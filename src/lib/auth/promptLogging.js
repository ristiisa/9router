import { getSettings } from "@/lib/localDb";
import { getDashboardAuthSession } from "./dashboardSession";
import { hasTrustedPeerHeaders } from "./trustedPeer";

// Conversation payloads stored with each request detail. Redacted unless an
// operator opts in AND the caller holds a real dashboard session.
export const PAYLOAD_KEYS = ["request", "providerRequest", "providerResponse", "response"];

function readCookie(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx !== -1 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function adminAllowList() {
  return (process.env.PROMPT_LOGGING_ADMINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isPromptLoggingEnabled(settings) {
  return process.env.ENABLE_PROMPT_LOGGING === "true" || settings?.promptLoggingEnabled === true;
}

export function describeActor(session) {
  if (!session) return { id: "anonymous", method: "none", email: null };
  const email = session.samlEmail || session.oidcEmail || null;
  if (session.saml) return { id: email || "saml-user", method: "saml", email };
  if (session.oidc) return { id: session.oidcSub || email || "oidc-user", method: "oidc", email };
  return { id: "dashboard-password", method: "password", email: null };
}

/**
 * Decide whether this request may see unredacted payloads.
 * Needs: opt-in flag, a verified dashboard session cookie (requireLogin=false and
 * CLI tokens do not count), and — for SSO sessions — membership in
 * PROMPT_LOGGING_ADMINS when that list is set. The password login is the instance
 * owner's credential and is always allowed once opted in.
 */
export async function resolvePayloadAccess(request) {
  const settings = await getSettings();
  if (!isPromptLoggingEnabled(settings)) return { allowed: false, reason: "disabled", actor: describeActor(null) };

  const session = await getDashboardAuthSession(readCookie(request, "auth_token"));
  const actor = describeActor(session);
  if (!session) return { allowed: false, reason: "no-session", actor };

  const allow = adminAllowList();
  if (allow.length && actor.method !== "password" && !(actor.email && allow.includes(actor.email.toLowerCase()))) {
    return { allowed: false, reason: "not-admin", actor };
  }
  return { allowed: true, reason: "ok", actor };
}

export function redactDetails(details) {
  return (details || []).map((d) => {
    const redacted = { ...d };
    for (const key of PAYLOAD_KEYS) {
      if (redacted[key] !== undefined) redacted[key] = { redacted: true };
    }
    return redacted;
  });
}

export async function auditPromptLoggingToggle(request, enabled) {
  const session = await getDashboardAuthSession(readCookie(request, "auth_token"));
  const actor = describeActor(session);
  const ip = hasTrustedPeerHeaders(request) ? request.headers.get("x-9r-real-ip") : null;
  console.warn(`[AUDIT] prompt-logging TOGGLE enabled=${enabled} actor=${actor.id} method=${actor.method} ip=${ip || "-"} at=${new Date().toISOString()}`);
}

export function auditPayloadAccess(request, access, rows) {
  const ip = hasTrustedPeerHeaders(request) ? request.headers.get("x-9r-real-ip") : null;
  const line = `[AUDIT] prompt-logging ${access.allowed ? "UNREDACTED" : `DENIED(${access.reason})`} actor=${access.actor.id} method=${access.actor.method} ip=${ip || "-"} rows=${rows} at=${new Date().toISOString()}`;
  console.warn(line);
}
