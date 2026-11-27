import assert from "node:assert/strict";
import test from "node:test";
import { buildManagedCall, chatCompletion, chatCompletionStream, managedSafeSchema, reportedContextWindow, turnSchema } from "../model-adapter.mjs";
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
