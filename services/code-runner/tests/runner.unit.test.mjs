import assert from "node:assert/strict";
import test from "node:test";
import { buildManagedCall, chatCompletion, chatCompletionStream, createModelAdapter, managedSafeSchema, reportedContextWindow, turnSchema } from "../model-adapter.mjs";
import { sandboxCommand } from "../isolation.mjs";
import { createServerClient } from "../runner.mjs";
import { codeSchemaAndPrompt } from "../../../lib/codeManagedCore.ts";

const model = { modelId: "m", name: "M", provider: "openai", maxOutputTokens: 1000, maxContextTokens: 400_000 };

test("a tool schema loses what the managed path refuses and keeps its structure", () => {
  const schema = managedSafeSchema({ type: "object", description: "d", properties: { url: { type: "string", format: "uri", pattern: "^h" },
    nested: { type: "array", items: { type: "string", pattern: "x" } } }, required: ["url"], $schema: "http://json-schema.org/draft-07/schema#" });
  assert.deepEqual(schema, { type: "object", properties: { url: { type: "string" }, nested: { type: "array", items: { type: "string" } } }, required: ["url"] });
  assert.equal(JSON.stringify(turnSchema([{ name: "t", parameters: { $ref: "https://evil.example/schema" } }])).includes("evil"), false);
});

test("one request becomes one managed call the server's own bounds accept", () => {
  const request = {
    model: "m", stream: true, max_tokens: 50_000,
    tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string", pattern: ".+" } }, required: ["path"] } } }],
    messages: [
      { role: "system", content: "You are Tomverse." },
      { role: "user", content: [{ type: "text", text: "Fix it" }, { type: "image_url", image_url: { url: "data:..." } }] },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "contents" },
    ],
  };
  const call = buildManagedCall(request, model);
  assert.equal(call.maxOutputTokens, 1000);
  assert.match(call.prompt.system, /You are Tomverse\./);
  assert.match(call.prompt.user, /\[image_url omitted\]/);
  assert.match(call.prompt.user, /\[assistant called read_file as call_1\]/);
  assert.match(call.prompt.user, /\[result of call_1\]\ncontents/);
  assert.doesNotThrow(() => codeSchemaAndPrompt({ action: "complete", reservationId: crypto.randomUUID(), callId: crypto.randomUUID(), role: "executor", modelId: "m",
    prompt: call.prompt, schema: call.schema, maxOutputTokens: call.maxOutputTokens }, { capabilities: { maxOutputTokens: 1000, maxContextTokens: 400_000 } }));
  assert.ok(reportedContextWindow(model) * 4.2 < 400_000);
});

test("the structured turn comes back as Chat Completions, streamed or not, with only offered tools", () => {
  const completion = chatCompletion({ content: "ok", tool_calls: [{ name: "read_file", arguments: { path: "a" } }, { name: "rm_rf", arguments: {} }] },
    { inputTokens: 3, outputTokens: 2 }, "m", ["read_file"]);
  const message = completion.choices[0].message;
  assert.equal(message.tool_calls.length, 1);
  assert.equal(message.tool_calls[0].function.arguments, "{\"path\":\"a\"}");
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  const stream = chatCompletionStream(completion);
  assert.match(stream, /"finish_reason":"tool_calls"/);
  assert.ok(stream.endsWith("data: [DONE]\n\n"));
  assert.equal(chatCompletion({ content: "done", tool_calls: [] }, null, "m", []).choices[0].finish_reason, "stop");
});

/** The adapter on a loopback port, with a scripted managed call that counts how often it is made and with which call id. */
async function adapterWith(answers) {
  const calls = [];
  const adapter = createModelAdapter({ model, callModel: async (call) => {
    calls.push(call);
    const next = answers[Math.min(calls.length, answers.length) - 1];
    return typeof next === "function" ? next(call) : next;
  } });
  await new Promise((resolve) => adapter.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${adapter.server.address().port}/api/code/v1`;
  const post = async (key, body) => {
    const response = await fetch(`${base}/chat/completions`, { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) } });
    return { status: response.status, requestId: response.headers.get("x-request-id"), body: await response.json() };
  };
  const status = async (key) => (await fetch(`${base}/requests/status`, { headers: { "idempotency-key": key } })).json();
  return { calls, post, status, close: () => adapter.close() };
}
const turn = { model: "m", stream: false, tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  messages: [{ role: "user", content: "Fix it" }] };
const settled = { ok: true, value: { content: "reading", tool_calls: [{ name: "read_file", arguments: { path: "a" } }] }, usage: { inputTokens: 3, outputTokens: 2 }, callCredits: 4 };

test("a request sent again with its Idempotency-Key after it completed gets the stored answer, not a second paid call", async () => {
  const adapter = await adapterWith([settled]);
  try {
    const first = await adapter.post("key-1", turn);
    assert.equal(first.status, 200);
    const again = await adapter.post("key-1", turn);
    assert.equal(again.status, 200);
    assert.equal(adapter.calls.length, 1);
    // The same answer: the same completion id, the same tool call ids the CLI sends results back for, the same receipt.
    assert.deepEqual(again.body, first.body);
    assert.equal(again.requestId, first.requestId);
    assert.equal(again.requestId, adapter.calls[0].callId);
    const receipt = (await adapter.status("key-1")).request;
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.chargedCredits, 4);
    // The same key with another body is refused, and makes no call either.
    const reused = await adapter.post("key-1", { ...turn, messages: [{ role: "user", content: "Something else" }] });
    assert.equal(reused.status, 422);
    assert.equal(reused.body.error.code, "idempotency_key_reused");
    assert.equal(adapter.calls.length, 1);
    // Without a key every request is its own call, as on the coding API.
    await adapter.post(null, turn);
    await adapter.post(null, turn);
    assert.equal(adapter.calls.length, 3);
    assert.notEqual(adapter.calls[1].callId, adapter.calls[2].callId);
  } finally {
    await adapter.close();
  }
});

test("two requests with one Idempotency-Key at once make one managed call; the second is told it is in progress", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // Opened anyway after a while, so an adapter that sent both calls fails the assertions below instead of hanging.
  const timer = setTimeout(() => release(), 5_000);
  const adapter = await adapterWith([async () => { await gate; return settled; }]);
  try {
    const both = [adapter.post("key-2", turn), adapter.post("key-2", turn)];
    // The call is held open, so the first answer back can only be the refusal of the twin.
    const first = await Promise.race(both);
    assert.equal(first.status, 409);
    assert.equal(first.body.error.code, "idempotent_request_in_progress");
    assert.equal(first.body.tomverse.status, "held");
    assert.equal(first.body.tomverse.charged_credits, null);
    release();
    const answers = await Promise.all(both);
    assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 409]);
    assert.equal(adapter.calls.length, 1);
    assert.equal(first.requestId, adapter.calls[0].callId);
  } finally {
    clearTimeout(timer);
    release();
    await adapter.close();
  }
});

test("a call whose outcome is unknown is never sent again under its key; one refused before dispatch is, with the same call id", async () => {
  const unknown = { ok: false, status: 503, code: "CODE_CLOUD_MODEL_OUTCOME_UNKNOWN", dispatchState: "dispatched" };
  const adapter = await adapterWith([unknown, settled]);
  try {
    assert.equal((await adapter.post("key-3", turn)).status, 503);
    const retry = await adapter.post("key-3", turn);
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error.code, "idempotent_request_in_progress");
    assert.equal(adapter.calls.length, 1);
    assert.equal((await adapter.status("key-3")).request.status, "held");
  } finally {
    await adapter.close();
  }
  const refused = { ok: false, status: 429, code: "CODE_CALL_CONCURRENCY_EXCEEDED", dispatchState: "not_dispatched" };
  const second = await adapterWith([refused, settled]);
  try {
    assert.equal((await second.post("key-4", turn)).status, 429);
    const receipt = (await second.status("key-4")).request;
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.chargedCredits, 0);
    const retry = await second.post("key-4", turn);
    assert.equal(retry.status, 200);
    assert.equal(second.calls.length, 2);
    // The retry is the same managed call: if the server had recorded it after all, it refuses it as already dispatched.
    assert.equal(second.calls[1].callId, second.calls[0].callId);
    assert.equal((await second.post("key-4", turn)).status, 200);
    assert.equal(second.calls.length, 2);
  } finally {
    await second.close();
  }
});

test("under bubblewrap the worker gets an empty environment, no network and only its own folders", () => {
  const command = sandboxCommand({ isolation: { kind: "bwrap", prlimit: true }, node: "/usr/local/bin/node", args: ["/runner/worker.mjs", "/job/io/request.json"],
    cwd: "/job/work", env: { HOME: "/job/home", PATH: "/usr/bin" }, paths: { readOnly: ["/runner", "/cli/dist"], writable: ["/job/work", "/job/home", "/job/io"] } });
  assert.equal(command.command, "bwrap");
  assert.deepEqual(command.env, {});
  const args = command.args.join(" ");
  for (const flag of ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"]) assert.ok(command.args.includes(flag), flag);
  assert.ok(!command.args.includes("--share-net"));
  assert.match(args, /--ro-bind \/runner \/runner/);
  assert.match(args, /--bind \/job\/work \/job\/work/);
  assert.doesNotMatch(args, /--bind \/job \/job/);
  assert.match(args, /prlimit --cpu=\d+ --fsize=\d+ --nofile=\d+ --nproc=\d+ -- \/usr\/local\/bin\/node --max-old-space-size=\d+/);
  assert.match(args, /--setenv HOME \/job\/home/);
});

test("the server client refuses a plain-http origin that is not loopback", () => {
  assert.throws(() => createServerClient({ origin: "http://tomverse.app", secret: "x".repeat(40) }));
  assert.doesNotThrow(() => createServerClient({ origin: "http://127.0.0.1:3000", secret: "x".repeat(40) }));
});
