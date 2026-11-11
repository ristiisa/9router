import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = { settings: {}, session: null };

vi.mock("@/lib/localDb", () => ({ getSettings: async () => state.settings }));
vi.mock("@/lib/auth/dashboardSession", () => ({ getDashboardAuthSession: async () => state.session }));

import { redactDetails, resolvePayloadAccess, auditPayloadAccess, isPromptLoggingEnabled } from "@/lib/auth/promptLogging";
describe("request-details redaction", () => {
  it("removes conversation payloads but keeps metadata", () => {
    const details = [{
      id: "abc",
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      timestamp: "2026-08-05T00:00:00Z",
      status: "success",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      request: { messages: [{ role: "user", content: "secret prompt" }] },
      providerRequest: { messages: [{ role: "user", content: "secret prompt" }] },
      providerResponse: { choices: [{ message: { content: "secret answer" } }] },
      response: { content: "secret answer" },
    }];
    const out = redactDetails(details)[0];
    expect(out.id).toBe("abc");
    expect(out.provider).toBe("opencode");
    expect(out.model).toBe("deepseek-v4-flash-free");
    expect(out.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(out.request).toEqual({ redacted: true });
    expect(out.providerRequest).toEqual({ redacted: true });
    expect(out.providerResponse).toEqual({ redacted: true });
    expect(out.response).toEqual({ redacted: true });
  });

  it("handles empty details", () => {
    expect(redactDetails([])).toEqual([]);
    expect(redactDetails(null)).toEqual([]);
  });

  it("keeps non-sensitive fields untouched", () => {
    const details = [{ id: "x", status: "error", latency: { total: 100 } }];
    const out = redactDetails(details)[0];
    expect(out.id).toBe("x");
    expect(out.status).toBe("error");
    expect(out.latency).toEqual({ total: 100 });
  });
});


function req(cookie = "auth_token=tok") {
  return new Request("http://localhost/api/usage/request-details", { headers: cookie ? { cookie } : {} });
}

describe("prompt logging access", () => {
  beforeEach(() => {
    state.settings = {};
    state.session = null;
    delete process.env.ENABLE_PROMPT_LOGGING;
    delete process.env.PROMPT_LOGGING_ADMINS;
  });
  afterEach(() => vi.restoreAllMocks());

  it("is denied by default", async () => {
    state.session = { authenticated: true };
    expect(await resolvePayloadAccess(req())).toMatchObject({ allowed: false, reason: "disabled" });
  });

  it("enabled via env or setting", () => {
    expect(isPromptLoggingEnabled({})).toBe(false);
    expect(isPromptLoggingEnabled({ promptLoggingEnabled: true })).toBe(true);
    process.env.ENABLE_PROMPT_LOGGING = "true";
    expect(isPromptLoggingEnabled({})).toBe(true);
  });

  it("denies when opted in but no session", async () => {
    state.settings = { promptLoggingEnabled: true };
    expect(await resolvePayloadAccess(req(null))).toMatchObject({ allowed: false, reason: "no-session" });
  });

  it("allows password session once opted in", async () => {
    process.env.ENABLE_PROMPT_LOGGING = "true";
    state.session = { authenticated: true };
    expect(await resolvePayloadAccess(req())).toMatchObject({ allowed: true, actor: { method: "password" } });
  });

  it("restricts SSO sessions to PROMPT_LOGGING_ADMINS when set", async () => {
    state.settings = { promptLoggingEnabled: true };
    process.env.PROMPT_LOGGING_ADMINS = "Admin@x.com, boss@x.com";
    state.session = { oidc: true, oidcSub: "u1", oidcEmail: "other@x.com" };
    expect(await resolvePayloadAccess(req())).toMatchObject({ allowed: false, reason: "not-admin" });
    state.session = { oidc: true, oidcSub: "u2", oidcEmail: "admin@x.com" };
    expect(await resolvePayloadAccess(req())).toMatchObject({ allowed: true, actor: { id: "u2" } });
  });

  it("allows any SSO session when no admin list is configured", async () => {
    state.settings = { promptLoggingEnabled: true };
    state.session = { saml: true, samlEmail: "a@x.com" };
    expect(await resolvePayloadAccess(req())).toMatchObject({ allowed: true, actor: { id: "a@x.com", method: "saml" } });
  });

  it("audit line carries actor, rows and timestamp", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    auditPayloadAccess(req(), { allowed: true, reason: "ok", actor: { id: "u2", method: "oidc" } }, 3);
    const line = warn.mock.calls[0][0];
    expect(line).toContain("[AUDIT] prompt-logging UNREDACTED");
    expect(line).toContain("actor=u2");
    expect(line).toContain("rows=3");
    expect(line).toMatch(/at=\d{4}-\d{2}-\d{2}T/);
  });
});
