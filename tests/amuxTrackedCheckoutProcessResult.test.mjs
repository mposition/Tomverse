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
const noCliError = { assistantError: null, resultIsError: null,
  apiErrorStatus: null, terminalReason: null, permissionDenials: null,
  turns: null, toolUses: { Read: 0, Grep: 0, Glob: 0 } };
const sentCliError = { ...noCliError, resultIsError: false, turns: 2,
  toolUses: { Read: 1, Grep: 0, Glob: 0 } };
const child = () => Object.assign(new EventEmitter(), {
  stdout: new PassThrough(), stderr: new PassThrough(),
});
const fakeRunnableChild = () => {
  const process = Object.assign(child(), { stdin: new PassThrough(), kills: 0,
    kill() {
      this.kills += 1;
      queueMicrotask(() => this.emit("close", null, "SIGKILL"));
    },
  });
  return process;
};
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
    { code: 0, signal: null, timedOut: true },
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

test("synthetic diagnostic distinguishes child failure from parser refusal without content", async () => {
  const failed = child();
  const first = observeAmuxTrackedCheckoutChild(failed,
    { ...input, diagnostic: true });
  await send(failed);
  assert.deepEqual(first.finish({ code: 2, signal: null }), {
    kind: "outcome_unknown", failureStage: "child_nonzero",
    childExitCode: 2, cliError: sentCliError,
  });
  const malformed = child();
  const second = observeAmuxTrackedCheckoutChild(malformed,
    { ...input, diagnostic: true });
  malformed.stdout.end("private malformed output");
  await new Promise((resolve) => malformed.stdout.once("end", resolve));
  assert.deepEqual(second.finish({ code: 0, signal: null }), {
    kind: "outcome_unknown", failureStage: "parser_rejected",
    childExitCode: null, cliError: noCliError,
  });
});

test("synthetic stderr reports only a bounded failure class", async () => {
  const process = child();
  const observed = observeAmuxTrackedCheckoutChild(process,
    { ...input, diagnostic: true });
  process.stderr.write("private-token=never-retain authenti");
  process.stderr.end("cation_error private-content=discard\n");
  await new Promise((resolve) => process.stderr.once("end", resolve));
  await send(process);
  const failure = observed.finish({ code: 1, signal: null });
  assert.deepEqual(failure, { kind: "outcome_unknown",
    failureStage: "child_nonzero", childExitCode: 1,
    stderrClass: "authentication", cliError: sentCliError });
  assert.equal(JSON.stringify(failure).includes("private"), false);
});

test("a failed CLI turn reports only its fixed error codes and counts", async () => {
  const process = child();
  const observed = observeAmuxTrackedCheckoutChild(process,
    { ...input, diagnostic: true });
  await send(process, [init,
    { type: "assistant", error: "authentication_failed", message: {
      role: "assistant", content: [{ type: "text", text: "private login text" }] } },
    { type: "result", subtype: "success", is_error: true, num_turns: 1,
      api_error_status: 401, terminal_reason: "api_error",
      permission_denials: [{ tool: "private" }], result: "private result text" }]);
  const failure = observed.finish({ code: 1, signal: null });
  assert.deepEqual(failure, { kind: "outcome_unknown",
    failureStage: "child_nonzero", childExitCode: 1,
    cliError: { assistantError: "authentication_failed", resultIsError: true,
      apiErrorStatus: 401, terminalReason: "api_error", permissionDenials: 1,
      turns: 1, toolUses: { Read: 0, Grep: 0, Glob: 0 } } });
  assert.equal(JSON.stringify(failure).includes("private"), false);
  // An unlisted error code or a free-text reason collapses to "other".
  const odd = child();
  const second = observeAmuxTrackedCheckoutChild(odd, { ...input, diagnostic: true });
  await send(odd, [init,
    { type: "assistant", error: "Private Text!", message: { role: "assistant",
      content: [{ type: "text", text: "x" }] } },
    { type: "result", subtype: "success", is_error: true, num_turns: 1,
      api_error_status: "401", terminal_reason: "Private reason", result: "x" }]);
  assert.deepEqual(second.finish({ code: 1, signal: null }).cliError, {
    ...noCliError, assistantError: "other", resultIsError: true,
    terminalReason: "other", turns: 1 });
  // A code-shaped value outside the CLI's own list is not passed through.
  const shaped = child();
  const third = observeAmuxTrackedCheckoutChild(shaped, { ...input, diagnostic: true });
  await send(shaped, [init, { type: "result", subtype: "success", is_error: true,
    num_turns: 1, terminal_reason: "private_customer_identifier", result: "x" }]);
  const shapedFailure = third.finish({ code: 1, signal: null });
  assert.equal(shapedFailure.cliError.terminalReason, "other");
  assert.equal(JSON.stringify(shapedFailure).includes("private"), false);
});

test("result codes survive a stream the validator already rejected", async () => {
  const process = child();
  const observed = observeAmuxTrackedCheckoutChild(process, { ...input, diagnostic: true });
  await send(process, [init,
    { type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "read_1", name: "Read",
        input: { file_path: `${directory}/src/a.ts` } }] } },
    // A failed tool result makes the validator stop parsing later lines.
    { type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "read_1", is_error: true, content: "x" }] } },
    { type: "result", subtype: "success", is_error: true, num_turns: 3,
      terminal_reason: "max_turns", permission_denials: [], result: "x" }]);
  assert.deepEqual(observed.finish({ code: 0, signal: null, stopped: false }), {
    kind: "outcome_unknown", failureStage: "parser_rejected", childExitCode: null,
    cliError: { ...noCliError, resultIsError: true, terminalReason: "max_turns",
      permissionDenials: 0, turns: 3, toolUses: { Read: 1, Grep: 0, Glob: 0 } },
  });
});

test("a diagnostic success also reports file tool counts; a normal one does not", async () => {
  const verified = { kind: "verified_success", rawModelOutput: result.result,
    readFiles: ["src/a.ts"], inputTokens: 14, outputTokens: 2 };
  const process = child();
  const observed = observeAmuxTrackedCheckoutChild(process, { ...input, diagnostic: true });
  await send(process);
  assert.deepEqual(observed.finish({ code: 0, signal: null, stopped: false }),
    { ...verified, toolUses: { Read: 1, Grep: 0, Glob: 0 } });
  const normal = child();
  const plain = observeAmuxTrackedCheckoutChild(normal, input);
  await send(normal);
  assert.deepEqual(plain.finish({ code: 0, signal: null, stopped: false }), verified);
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
  const childProcess = spawn(process.execPath, ["-e", script, output], {
    detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
  const observed = await awaitAmuxTrackedCheckoutChild({ ...input,
    child: childProcess, prompt: Buffer.from("synthetic-only"),
    stopCheck: async () => false,
  });
  assert.equal(observed.kind, "verified_success");
  assert.deepEqual(observed.readFiles, ["src/a.ts"]);
});

test("the stoppable child bridge requires a complete trace when supplied", {
  skip: process.platform !== "linux",
}, async () => {
  const output = Buffer.from(events.map(JSON.stringify).join("\n")).toString("base64");
  const script = "process.stdin.resume(); process.stdin.on('end', () => " +
    "process.stdout.end(Buffer.from(process.argv[1], 'base64')))";
  const childProcess = spawn(process.execPath, ["-e", script, output], {
    detached: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
  let traceFinished = false;
  const observed = await awaitAmuxTrackedCheckoutChild({ ...input,
    child: childProcess, prompt: Buffer.from("synthetic-only"),
    stopCheck: async () => false,
    finishOpenTrace: async (exit) => {
      traceFinished = true;
      assert.equal(exit.code, 0);
      return { kind: "complete", files: ["src/a.ts"] };
    },
  });
  assert.equal(traceFinished, true);
  assert.equal(observed.kind, "verified_success");
  assert.deepEqual(observed.readFiles, ["src/a.ts"]);
});

test("the stoppable child bridge refuses an operator stop", {
  skip: process.platform !== "linux",
}, async () => {
  const process = fakeRunnableChild();
  const observed = await awaitAmuxTrackedCheckoutChild({ ...input,
    child: process, prompt: Buffer.from("synthetic-only"),
    stopCheck: async () => true,
  });
  assert.deepEqual(observed, { kind: "outcome_unknown" });
  assert.equal(process.kills, 1);
});

test("the stoppable child bridge refuses a child transport error", {
  skip: process.platform !== "linux",
}, async () => {
  const process = fakeRunnableChild();
  queueMicrotask(() => process.emit("error", new Error("synthetic failure")));
  const observed = await awaitAmuxTrackedCheckoutChild({ ...input,
    child: process, prompt: Buffer.from("synthetic-only"),
    stopCheck: async () => false,
  });
  assert.deepEqual(observed, { kind: "outcome_unknown" });
  assert.equal(process.kills, 1);
});

test("the stoppable child bridge refuses a prompt pipe failure", {
  skip: process.platform !== "linux",
}, async () => {
  const process = fakeRunnableChild();
  queueMicrotask(() => {
    process.stdin.emit("error", new Error("EPIPE"));
    process.emit("close", 0, null);
  });
  const observed = await awaitAmuxTrackedCheckoutChild({ ...input,
    child: process, prompt: Buffer.from("synthetic-only"),
    stopCheck: async () => false,
  });
  assert.deepEqual(observed, { kind: "outcome_unknown" });
});

test("invalid observer setup kills an already-spawned child", {
  skip: process.platform !== "linux",
}, async () => {
  const process = fakeRunnableChild();
  const observed = await awaitAmuxTrackedCheckoutChild({ ...input,
    modelId: "unapproved-model", child: process,
    prompt: Buffer.from("synthetic-only"), stopCheck: async () => false,
  });
  assert.deepEqual(observed, { kind: "outcome_unknown" });
  assert.equal(process.kills, 1);
});
