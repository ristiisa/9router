import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

function context(raw, sourceFormat, targetFormat) {
  return {
    providerResponse: new Response(raw, { headers: { "content-type": "text/event-stream" } }),
    provider: targetFormat === FORMATS.OPENAI_RESPONSES ? "codex" : "op-test-chat",
    model: "test-model",
    sourceFormat,
    targetFormat,
    body: { model: "test-model", stream: false, messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/messages" },
    trackDone: vi.fn(),
    appendLog: vi.fn()
  };
}

function responsesSSE(output) {
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return event("response.created", { response: { id: "resp_test", created_at: 1700000000 } })
    + output.map((item, output_index) => event("response.output_item.done", { item, output_index })).join("")
    + event("response.completed", { response: { usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } } });
}

const toolItem = { type: "function_call", call_id: "call_test", name: "lookup", arguments: '{"code":"A"}' };

describe("Claude JSON clients behind forced-stream upstreams", () => {
  it.each(["<decision>allow</decision>", "<decision>block</decision>"])("preserves the upstream text verbatim: %s", async (text) => {
    const raw = responsesSSE([{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }]);
    const result = await handleForcedSSEToJson(context(raw, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES));
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("application/json");
    const json = await result.response.json();
    expect(json).toMatchObject({
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 7 }
    });
    expect(json).not.toHaveProperty("choices");
    expect(json.content.filter(block => block.type === "text").map(block => block.text).join("")).toBe(text);
  });

  it("returns Responses function calls as Claude tool_use blocks", async () => {
    const result = await handleForcedSSEToJson(context(responsesSSE([toolItem]), FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES));
    const json = await result.response.json();
    expect(json.content).toEqual([{ type: "tool_use", id: "call_test", name: "lookup", input: { code: "A" } }]);
    expect(json.stop_reason).toBe("tool_use");
  });

  it("returns standard Chat SSE as a Claude message and preserves truncation", async () => {
    const chunks = [
      { id: "chatcmpl_test", model: "test-model", choices: [{ delta: { content: "partial" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 8, completion_tokens: 2 } }
    ];
    const raw = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const result = await handleForcedSSEToJson(context(raw, FORMATS.CLAUDE, FORMATS.OPENAI));
    const json = await result.response.json();
    expect(json.content).toEqual([{ type: "text", text: "partial" }]);
    expect(json.stop_reason).toBe("max_tokens");
    expect(json.usage).toEqual({ input_tokens: 8, output_tokens: 2 });
  });

  it("keeps an empty output as empty text rather than inventing a decision", async () => {
    const result = await handleForcedSSEToJson(context(responsesSSE([]), FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES));
    expect((await result.response.json()).content).toEqual([{ type: "text", text: "" }]);
  });

  it.each([FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.GEMINI])("keeps the existing %s client shape", async (sourceFormat) => {
    const raw = responsesSSE([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }]);
    const result = await handleForcedSSEToJson(context(raw, sourceFormat, FORMATS.OPENAI_RESPONSES));
    const json = await result.response.json();
    if (sourceFormat === FORMATS.OPENAI) expect(json.choices[0].message.content).toBe("hello");
    else if (sourceFormat === FORMATS.OPENAI_RESPONSES) expect(json.output[0].content[0].text).toBe("hello");
    else expect(json.response.candidates[0].content.parts[0].text).toBe("hello");
  });

  it("reuses the same conversion for ordinary non-streaming Chat responses", () => {
    const json = translateNonStreamingResponse({
      id: "chatcmpl_test",
      model: "test-model",
      choices: [{ message: { content: "unchanged" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1 }
    }, FORMATS.OPENAI, FORMATS.CLAUDE);
    expect(json.content).toEqual([{ type: "text", text: "unchanged" }]);
    expect(json.stop_reason).toBe("end_turn");
  });

  it("converts Antigravity/Gemini SSE stream to Claude JSON message with text, thinking, and usage", async () => {
    const agChunks = [
      {
        response: {
          candidates: [{
            content: {
              role: "model",
              parts: [
                { thought: true, text: "Let me think about this." },
                { text: "ok" }
              ]
            },
            finishReason: "STOP"
          }],
          usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 2, totalTokenCount: 17 },
          modelVersion: "gemini-3.8-flash",
          responseId: "resp_ag_123"
        }
      }
    ];
    const raw = agChunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const ctx = {
      ...context(raw, FORMATS.CLAUDE, FORMATS.ANTIGRAVITY),
      provider: "antigravity",
      model: "ag/gemini-3.8-flash"
    };
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("application/json");
    const json = await result.response.json();
    expect(json).toMatchObject({
      type: "message",
      role: "assistant",
      model: "gemini-3.8-flash",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 15, output_tokens: 2 }
    });
    expect(json.content).toEqual([
      { type: "thinking", thinking: "Let me think about this." },
      { type: "text", text: "ok" }
    ]);
  });

  it("converts Antigravity/Gemini SSE stream with functionCall to Claude tool_use JSON message", async () => {
    const agChunks = [
      {
        response: {
          candidates: [{
            content: {
              role: "model",
              parts: [
                { functionCall: { id: "call_lookup_1", name: "lookup", args: { code: "A" } } }
              ]
            },
            finishReason: "STOP"
          }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 },
          modelVersion: "gemini-3.8-flash",
          responseId: "resp_ag_tool"
        }
      }
    ];
    const raw = agChunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const ctx = {
      ...context(raw, FORMATS.CLAUDE, FORMATS.ANTIGRAVITY),
      provider: "antigravity",
      model: "ag/gemini-3.8-flash"
    };
    const result = await handleForcedSSEToJson(ctx);
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.content).toEqual([
      { type: "tool_use", id: "call_lookup_1", name: "lookup", input: { code: "A" } }
    ]);
    expect(json.stop_reason).toBe("tool_use");
    expect(json.usage).toEqual({ input_tokens: 20, output_tokens: 5 });
  });

  it("translates direct Antigravity/Gemini non-streaming candidate responses to Claude Messages", () => {
    const geminiCandidateBody = {
      response: {
        candidates: [{
          content: {
            role: "model",
            parts: [
              { thought: true, text: "thinking..." },
              { text: "hello world" }
            ]
          },
          finishReason: "STOP"
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
        modelVersion: "gemini-3.8-flash",
        responseId: "resp_ns_1"
      }
    };
    const json = translateNonStreamingResponse(geminiCandidateBody, FORMATS.ANTIGRAVITY, FORMATS.CLAUDE);
    expect(json).toMatchObject({
      type: "message",
      role: "assistant",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 3 }
    });
    expect(json.content).toEqual([
      { type: "thinking", thinking: "thinking..." },
      { type: "text", text: "hello world" }
    ]);
  });

  it("translates direct Antigravity/Gemini non-streaming candidate response with tool calls to Claude Messages", () => {
    const geminiCandidateBody = {
      response: {
        candidates: [{
          content: {
            role: "model",
            parts: [
              { functionCall: { name: "get_weather", args: { location: "London" } } }
            ]
          },
          finishReason: "STOP"
        }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6, totalTokenCount: 18 },
        modelVersion: "gemini-3.8-flash",
        responseId: "resp_ns_tool"
      }
    };
    const json = translateNonStreamingResponse(geminiCandidateBody, FORMATS.ANTIGRAVITY, FORMATS.CLAUDE);
    expect(json.type).toBe("message");
    expect(json.stop_reason).toBe("tool_use");
    expect(json.content).toEqual([
      expect.objectContaining({ type: "tool_use", name: "get_weather", input: { location: "London" } })
    ]);
    expect(json.usage).toEqual({ input_tokens: 12, output_tokens: 6 });
  });
});
