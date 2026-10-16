import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { awaitAmuxTrackedCheckoutChild, observeAmuxTrackedCheckoutChild } from
  "../lib/amux/ideaTrackedCheckoutProcessResult.mjs";

const directory = "/tmp/amux-v19-checkout-abcdef";
const modelId = "claude-opus-5-5";
const input = { directory, modelId, files: ["src/a.ts"] };
const init = { type: "system", subtype: "init", tools: ["Read", "Grep", "Glob"],
  permissionMode: "dontAsk", mcp_servers: [], skills: [], plugins: [], agents: [] };
const result = { type: "result", subtype: "success", is_error: false,
  num_turns: 2, result: '{"schemaVersion":5,"units":[]}',
  modelUsage: { [modelId]: { inputTokens: 10, outputTokens: 2,
    cacheReadInputTokens: 3, cacheCreationInputTokens: 1 } } };
const events = [init,
  { type: "assistant", message: { role: "assistant", content: [
    { type: "tool_use", id: "read_1", name: "Read",
      input: { file_path: `${directory}/src/a.ts` } },
  ] } },
  { type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "read_1", is_error: false,
      content: "untrusted source text" },
  ] } }, result];
const child = () => Object.assign(new EventEmitter(), {
  stdout: new PassThrough(), stderr: new PassThrough(),
});
const send = async (process, sequence = events) => {
  const bytes = Buffer.from(sequence.map(JSON.stringify).join("\n"));
  process.stdout.write(bytes.subarray(0, 7));
  process.stdout.end(bytes.subarray(7));
  await new Promise((resolve) => process.stdout.once("end", resolve));
};

test("child output returns a verified result only after stdout closes", async () => {
  const process = child();
  const observed = observeAmuxTrackedCheckoutChild(process, input);
  process.stderr.end("secret diagnostic must be discarded");
  await send(process);
  assert.deepEqual(observed.finish({ code: 0, signal: null, stopped: false }), {
    kind: "verified_success", rawModelOutput: result.result,
    readFiles: ["src/a.ts"], inputTokens: 14, outputTokens: 2,
  });
  assert.deepEqual(observed.finish({ code: 0, signal: null }),
    { kind: "outcome_unknown" });
});

test("stop, signal and incomplete stdout never release model output", async () => {
  for (const exit of [
    { code: 0, signal: null, stopped: true },
    { code: 0, signal: "SIGKILL", stopped: false },
    { code: 1, signal: null, stopped: false },
  ]) {
    const process = child();
    const observed = observeAmuxTrackedCheckoutChild(process, input);
    await send(process);
    assert.deepEqual(observed.finish(exit), { kind: "outcome_unknown" });
  }
  const process = child();
  const observed = observeAmuxTrackedCheckoutChild(process, input);
  process.stdout.write(Buffer.from(events.map(JSON.stringify).join("\n")));
  assert.deepEqual(observed.finish({ code: 0, signal: null }),
    { kind: "outcome_unknown" });
  process.stdout.destroy();
});

test("stderr transport errors invalidate an otherwise complete result", async () => {
  const process = child();
  const observed = observeAmuxTrackedCheckoutChild(process, input);
  await send(process);
  process.stderr.destroy(new Error("private diagnostic"));
  await new Promise((resolve) => process.stderr.once("close", resolve));
  assert.equal(observed.hasIoFailure(), true);
  assert.deepEqual(observed.finish({ code: 0, signal: null, stopped: false }),
    { kind: "outcome_unknown" });
});

test("the stoppable child bridge verifies a synthetic complete stream", {
  skip: process.platform !== "linux",
}, async () => {
  const output = Buffer.from(events.map(JSON.stringify).join("\n")).toString("base64");
  const script = "process.stdin.resume(); process.stdin.on('end', () => " +
    "process.stdout.end(Buffer.from(process.argv[1], 'base64')))";
  const process = spawn(process.execPath, ["-e", script, output], {
    detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
  const observed = await awaitAmuxTrackedCheckoutChild({ ...input,
    child: process, prompt: Buffer.from("synthetic-only"),
    stopCheck: async () => false,
  });
  assert.equal(observed.kind, "verified_success");
  assert.deepEqual(observed.readFiles, ["src/a.ts"]);
});
