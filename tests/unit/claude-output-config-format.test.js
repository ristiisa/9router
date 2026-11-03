import { describe, expect, it } from "vitest";

import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

const FORMAT = { type: "json_schema", schema: { type: "object", properties: { questions: { type: "array", items: { type: "string" } } }, required: ["questions"], additionalProperties: false } };

describe("Claude output_config.format with effort", () => {
  it.each(["claude-opus-5-5", "claude-sonnet-5-5"])("%s keeps format next to effort", (model) => {
    const body = applyThinking("claude", model, { output_config: { effort: "low", format: FORMAT } }, "claude");
    expect(body.output_config).toEqual({ effort: "low", format: FORMAT });
  });

  it("keeps format when only format is sent", () => {
    const body = applyThinking("claude", "claude-opus-5-5", { output_config: { format: FORMAT } }, "claude");
    expect(body.output_config.format).toEqual(FORMAT);
  });

  it("keeps format through request preparation", () => {
    const body = prepareClaudeRequest({ model: "claude-opus-5-5", max_tokens: 1024, messages: [{ role: "user", content: "hi" }], output_config: { effort: "low", format: FORMAT } }, "claude");
    expect(body.output_config).toEqual({ effort: "low", format: FORMAT });
  });
});
