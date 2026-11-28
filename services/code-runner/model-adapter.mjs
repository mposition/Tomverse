// The model side of a cloud job. The Tomverse CLI engine speaks OpenAI Chat Completions with tools to the endpoint
// it is given; this adapter answers it on a local socket and turns each request into one managed Code call
// (`complete`: one structured output, validated by the server against the schema sent here) made by the Tomverse
// server for the job's reservation. The structured output is a whole assistant turn: its text and the tool calls it
// wants. Nothing here prices, retries or picks a model: the server pins the model and settles each call.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

/** The managed path's own bounds (lib/codeCloudContract.ts, lib/codeManagedCore.ts). */
export const MANAGED_BOUNDS = { systemChars: 65_536, userChars: 786_432, schemaBytes: 64 * 1024, framingBytes: 4096 };
// Tool documentation and the schema share the system prompt and the schema budget; keep this much for them.
const TOOL_RESERVE_BYTES = 96 * 1024;

/**
 * The context window to report to the CLI, in its own token estimate (ASCII ~3.5 characters a token). The managed
 * path bounds a call by UTF-8 bytes against the model's context (lib/codeManagedCore.ts codeSchemaAndPrompt), and the
 * transcript is re-serialised as text here, so the window is the byte budget over 4.2: the CLI then compacts before a
 * request could exceed what the server accepts.
 */
export function reportedContextWindow(model) {
  const budget = Math.min(model.maxContextTokens || 0, MANAGED_BOUNDS.userChars) - (model.maxOutputTokens || 0) - MANAGED_BOUNDS.framingBytes - TOOL_RESERVE_BYTES;
  return Math.max(2_000, Math.floor(budget / 4.2));
}

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : part?.type ? `[${part.type} omitted]` : "")).join("");
};

/** Strips what the managed path refuses in a schema (patterns and formats) and documentation it does not need. */
export function managedSafeSchema(schema, depth = 0) {
  if (depth > 24 || !schema || typeof schema !== "object") return {};
  if (Array.isArray(schema)) return schema.map((item) => managedSafeSchema(item, depth + 1));
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (["pattern", "patternProperties", "format", "$schema", "description", "title", "examples", "default", "$id", "$comment"].includes(key)) continue;
    if (key === "$ref" && (typeof value !== "string" || !value.startsWith("#/"))) continue;
    if (key === "properties" || key === "definitions" || key === "$defs") {
      out[key] = Object.fromEntries(Object.entries(value ?? {}).map(([name, item]) => [name, managedSafeSchema(item, depth + 1)]));
    } else if (key === "enum" || key === "const" || key === "required") out[key] = value;
    else out[key] = value && typeof value === "object" ? managedSafeSchema(value, depth + 1) : value;
  }
  return out;
}

const toolList = (request) => (Array.isArray(request.tools) ? request.tools : [])
  .filter((tool) => tool?.type === "function" && typeof tool.function?.name === "string")
  .map((tool) => ({ name: tool.function.name, description: String(tool.function.description ?? ""), parameters: tool.function.parameters ?? { type: "object" } }));

/** The schema of one assistant turn. Tool arguments are checked per tool when the schema fits, else free-form. */
export function turnSchema(tools) {
  const freeForm = { type: "object", properties: { name: { type: "string", ...(tools.length ? { enum: tools.map((tool) => tool.name) } : {}) },
    arguments: { type: "object" } }, required: ["name", "arguments"], additionalProperties: false };
  const exact = tools.length ? { anyOf: tools.map((tool) => ({ type: "object",
    properties: { name: { const: tool.name }, arguments: managedSafeSchema(tool.parameters) }, required: ["name", "arguments"], additionalProperties: false })) } : freeForm;
  const build = (item) => ({ type: "object", properties: { content: { type: "string" }, tool_calls: { type: "array", items: item } },
    required: ["content", "tool_calls"], additionalProperties: false });
  const strict = build(exact);
  return Buffer.byteLength(JSON.stringify(strict)) <= MANAGED_BOUNDS.schemaBytes / 2 ? strict : build(freeForm);
}

const TURN_RULES = [
  "You are the assistant in an automated coding session in a temporary copy of a repository. Nobody can answer questions while you work.",
  "Answer every turn with one JSON object: {\"content\": text to show, \"tool_calls\": [{\"name\": a tool name, \"arguments\": an object matching that tool's parameters}]}.",
  "Call tools to read, change and check files. When the task is done, answer with an empty tool_calls list and a short summary of what you changed in content.",
].join("\n");

/** One managed call from one Chat Completions request: prompt text, the turn schema and the output bound. */
export function buildManagedCall(request, model) {
  const tools = toolList(request);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const systemText = messages.filter((m) => m?.role === "system" || m?.role === "developer").map((m) => textOf(m.content)).join("\n\n");
  const toolDocs = tools.map((tool) => `## ${tool.name}\n${tool.description}\nParameters: ${JSON.stringify(managedSafeSchema(tool.parameters))}`).join("\n\n");
  let system = [TURN_RULES, systemText, tools.length ? `# Tools\n${toolDocs}` : "# Tools\nNone: answer with an empty tool_calls list."].filter(Boolean).join("\n\n");
  if (system.length > MANAGED_BOUNDS.systemChars) system = system.slice(0, MANAGED_BOUNDS.systemChars);
  const lines = [];
  for (const message of messages) {
    if (message?.role === "user") lines.push(`[user]\n${textOf(message.content)}`);
    else if (message?.role === "assistant") {
      const text = textOf(message.content);
      if (text) lines.push(`[assistant]\n${text}`);
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : [])
        lines.push(`[assistant called ${call?.function?.name} as ${call?.id}]\n${call?.function?.arguments ?? "{}"}`);
    } else if (message?.role === "tool") lines.push(`[result of ${message.tool_call_id}]\n${textOf(message.content)}`);
  }
  const user = `${lines.join("\n\n")}\n\n[now]\nWrite the next assistant turn as the JSON object.`;
  const asked = Number(request.max_completion_tokens ?? request.max_tokens) || model.maxOutputTokens;
  return {
    prompt: { system, user },
    schema: turnSchema(tools),
    maxOutputTokens: Math.max(1, Math.min(asked, model.maxOutputTokens)),
    oversized: user.length > MANAGED_BOUNDS.userChars,
    toolNames: tools.map((tool) => tool.name),
  };
}

/** The structured turn as a Chat Completions answer; tool calls get ids the CLI uses to send their results back. */
export function chatCompletion(value, usage, modelId, toolNames) {
  const content = typeof value?.content === "string" ? value.content : "";
  const calls = (Array.isArray(value?.tool_calls) ? value.tool_calls : [])
    .filter((call) => typeof call?.name === "string" && (!toolNames.length || toolNames.includes(call.name)))
    .map((call) => ({ id: `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`, type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments && typeof call.arguments === "object" ? call.arguments : {}) } }));
  const tokens = { prompt_tokens: usage?.inputTokens ?? 0, completion_tokens: usage?.outputTokens ?? 0,
    total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) };
  return {
    id: `chatcmpl-${randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: tokens,
  };
}

/** The same answer as the Server-Sent Events stream the CLI asks for (`stream: true`). */
export function chatCompletionStream(completion) {
  const base = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model };
  const choice = completion.choices[0];
  const events = [{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: choice.message.content }, finish_reason: null }] }];
  (choice.message.tool_calls ?? []).forEach((call, index) => events.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, ...call }] }, finish_reason: null }] }));
  events.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] });
  events.push({ ...base, choices: [], usage: completion.usage });
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

const readBody = (req, limit) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

// The coding API's error shape and types (lib/externalApiInference.ts externalApiErrorResponse).
const errorType = (status) => status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 404 ? "not_found_error"
  : status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error";

/**
 * The adapter's HTTP server on a socket only the job's sandbox can reach. `callModel` sends one managed call and
 * returns `{ ok: true, value, usage, callCredits }` or `{ ok: false, status, code, dispatchState }`.
 *
 * Idempotency-Key, as on the coding API (lib/externalApiInference.ts idempotentReplay): a key names one managed call,
 * and its call id is kept for every try of it. A second request with the key never makes a second call while the first
 * is in flight or its outcome is unknown (409 idempotent_request_in_progress), gets the stored answer once it completed,
 * and with a different body is refused (422 idempotency_key_reused). Only a refusal the server made before dispatch
 * (nothing reached the provider and nothing was recorded under the call id) leaves the key free for another try, which
 * is sent with the same call id so the server itself refuses it if that call was recorded after all.
 */
export function createModelAdapter({ model, callModel, onCall = () => {} }) {
  /** Idempotency-Key -> { digest, callId, receipt, answer } */
  const calls = new Map();
  const window = reportedContextWindow(model);
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const error = (res, status, code, message, { requestId, details } = {}) => send(res, status,
    { error: { message, type: errorType(status), code, param: null }, ...(details ? { tomverse: details } : {}) }, requestId ? { "x-request-id": requestId } : {});
  const answer = (res, completion, stream, callId) => {
    const headers = { "x-request-id": callId, "x-tomverse-routed-model": model.modelId };
    if (!stream) return send(res, 200, completion, headers);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers });
    return res.end(chatCompletionStream(completion));
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://adapter").pathname;
    try {
      if (req.method === "GET" && path === "/api/code/v1/models") {
        return send(res, 200, { data: [{ id: model.modelId, tomverse: { name: model.name, provider: model.provider,
          capabilities: { tools: true, vision: false, reasoning: false }, protocols: ["chat_completions"],
          context_window_tokens: window, max_output_tokens: model.maxOutputTokens, credits_per_request: 0 } }] });
      }
      if (req.method === "GET" && path === "/api/code/v1/usage") return send(res, 200, { key: null, requests: [...calls.values()].map((entry) => entry.receipt) });
      if (req.method === "GET" && path === "/api/code/v1/requests/status") {
        const key = req.headers["idempotency-key"];
        const byId = new URL(req.url ?? "/", "http://adapter").searchParams.get("request_id");
        const receipt = [...calls.entries()].find(([k, entry]) => k === key || entry.receipt.requestId === byId)?.[1].receipt;
        return receipt ? send(res, 200, { request: receipt }) : error(res, 404, "request_not_found", "No such request.");
      }
      if (req.method !== "POST" || path !== "/api/code/v1/chat/completions") return error(res, 404, "not_found", "Not found.");
      const raw = await readBody(req, 8 * 1024 * 1024);
      const request = JSON.parse(raw);
      const call = buildManagedCall(request, model);
      const header = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() : "";
      if (header.length > 255) return error(res, 400, "invalid_idempotency_key", "Idempotency-Key must be at most 255 characters.");
      if (call.oversized) return error(res, 400, "context_too_large", "The conversation is larger than one managed call accepts.");
      // From here to callModel nothing awaits, so of two requests with one key only the first gets past this check.
      const key = header || randomUUID();
      const digest = createHash("sha256").update(raw).digest("hex");
      let entry = calls.get(key);
      if (entry) {
        const requestId = entry.callId;
        if (entry.digest !== digest) return error(res, 422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request body.", { requestId });
        if (entry.answer) return answer(res, entry.answer, request.stream, requestId);
        if (entry.receipt.status !== "failed") {
          return error(res, 409, "idempotent_request_in_progress",
            "A request with this Idempotency-Key is still in progress or its outcome is not yet known. It was not sent again.",
            { requestId, details: { request_id: requestId, status: "held", outcome: null, finish_reason: null, charged_credits: null } });
        }
      } else {
        entry = { digest, callId: randomUUID(), receipt: null, answer: null };
        calls.set(key, entry);
      }
      const { callId } = entry;
      const receipt = { requestId: callId, modelId: model.modelId, protocol: "chat_completions", status: "held", outcome: null, heldCredits: 0,
        chargedCredits: null, finishReason: null, errorCode: null, createdAt: new Date().toISOString(), completedAt: null, usage: null };
      entry.receipt = receipt;
      const result = await callModel({ callId, prompt: call.prompt, schema: call.schema, maxOutputTokens: call.maxOutputTokens });
      onCall(result);
      if (!result.ok) {
        // A call that may have reached the provider stays "held": never sent again, by the CLI or by another request with its key.
        if (result.dispatchState === "not_dispatched") Object.assign(receipt, { status: "failed", outcome: "failed", chargedCredits: 0, errorCode: result.code, completedAt: new Date().toISOString() });
        return error(res, result.status >= 400 && result.status < 600 ? result.status : 503, result.code, `The managed call was refused (${result.code}).`);
      }
      const completion = chatCompletion(result.value, result.usage, model.modelId, call.toolNames);
      Object.assign(receipt, { status: "completed", outcome: "completed", chargedCredits: result.callCredits ?? 0, finishReason: completion.choices[0].finish_reason,
        completedAt: new Date().toISOString(), usage: { inputTokens: result.usage?.inputTokens ?? 0, cachedInputTokens: result.usage?.cachedInputTokens ?? 0,
          cacheWriteInputTokens: result.usage?.cacheWriteInputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0 } });
      entry.answer = completion;
      return answer(res, completion, request.stream, callId);
    } catch {
      return error(res, 500, "adapter_error", "The model adapter could not answer.");
    }
  });
  return {
    server,
    listen: (socketPath) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve()); }),
    // Ends connections still open (a model call the killed worker was waiting on) instead of waiting for them.
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
