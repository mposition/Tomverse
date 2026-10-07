import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { amuxV22ClaudeArgs, amuxV22SidecarEnabled,
  checkAmuxV22SidecarSocketDir, createAmuxV22SidecarHandler,
  createAmuxV22SidecarServer,
  parseAmuxV22OneShotRequest,
  runAmuxV22OneShot } from
  "../lib/amux/v22OneShotSidecar.mjs";

const attemptId = "00000000-0000-4000-8000-000000000001";
const request = { version: 1, attemptId, worker: "worker-a",
  role: "implement", modelId: "claude-opus-5-5",
  budgetMicrousd: 1_250_000, prompt: "Change a small file." };
const config = { worker: "worker-a", binaryPath: "/usr/bin/claude",
  worktreePath: "/tmp/worktree", homePath: "/home/tommy",
  claudeConfigDir: "/home/tommy/.amux-cli-profiles/claude" };
const usage = { type: "result", subtype: "success", is_error: false,
  result: "Synthetic review result",
  num_turns: 1, modelUsage: { "claude-opus-5-5": {
    inputTokens: 10, outputTokens: 5,
    cacheReadInputTokens: 2, cacheCreationInputTokens: 1,
  } } };

async function readFinished(handler) {
  for (let i = 0; i < 100; i += 1) {
    const result = await handler({ op: "readback", attemptId });
    if (result.kind !== "in_progress") return result;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("sidecar result was not recorded");
}

function fakeSpawn(result, options = {}) {
  const calls = [];
  const spawnChild = (binary, args, spawnOptions) => {
    calls.push({ binary, args, spawnOptions });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.signalCode = "SIGKILL";
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    };
    queueMicrotask(() => {
      child.emit("spawn");
      if (options.hang) return;
      child.stdout.end(result);
      child.exitCode = options.exitCode ?? 0;
      child.emit("close", child.exitCode, null);
    });
    return child;
  };
  return { spawnChild, calls };
}

test("sidecar is dark even when its environment switch is set", () => {
  assert.equal(amuxV22SidecarEnabled("1"), false);
});

test("the one-shot request and CLI command have bounded capabilities", () => {
  assert.deepEqual(parseAmuxV22OneShotRequest(request, "worker-a"), request);
  assert.throws(() => parseAmuxV22OneShotRequest({ ...request,
    worker: "worker-b" }, "worker-a"));
  assert.throws(() => parseAmuxV22OneShotRequest({ ...request,
    budgetMicrousd: 5_000_001 }, "worker-a"));
  assert.throws(() => parseAmuxV22OneShotRequest({ ...request,
    worktreePath: "/etc" }, "worker-a"));
  const args = amuxV22ClaudeArgs(request);
  assert.ok(args.includes("--restricted"));
  assert.ok(args.includes("--permission-prompts"));
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "1.250000");
  assert.equal(args[args.indexOf("--tools") + 1],
    "Read,Grep,Glob,Edit,Write");
  assert.equal(args.some((arg) => arg.includes("Bash")), false);
});

test("one child returns a reviewable result and a content-free receipt", async () => {
  const fake = fakeSpawn(JSON.stringify(usage));
  const result = await runAmuxV22OneShot(request, config, {
    syntheticPlatform: true, spawnChild: fake.spawnChild,
  });
  assert.equal(result.kind, "succeeded");
  assert.equal(result.attemptId, attemptId);
  assert.equal(Object.hasOwn(result, "usageObservation"), false);
  assert.equal(result.usageReceipt.binding.attemptId, attemptId);
  assert.equal(result.usageReceipt.actualModelId, "claude-opus-5-5");
  assert.equal(result.usageReceipt.completeness, "reported_complete");
  assert.equal(result.usageReceipt.observed.inputTokens, 10);
  assert.match(result.usageReceiptDigest, /^[0-9a-f]{64}$/);
  assert.match(result.outputDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.resultText, usage.result);
  assert.match(result.resultSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result.usageReceipt).includes(usage.result), false);
  assert.equal(JSON.stringify(result).includes(request.prompt), false);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].spawnOptions.shell, false);
  assert.equal(fake.calls[0].spawnOptions.env.TOMVERSE_AMUX_SYNC_SECRET,
    undefined);
});

test("implement refuses a dirty baseline before CLI and holds a patch only in memory", async () => {
  const refused = fakeSpawn(JSON.stringify(usage));
  const blocked = await runAmuxV22OneShot(request, config, {
    syntheticPlatform: true, spawnChild: refused.spawnChild,
    captureBaseline: async () => ({ ok: false, reason: "dirty_worktree" }),
  });
  assert.deepEqual({ kind: blocked.kind, failure: blocked.failure,
    cliStarted: blocked.cliStarted },
  { kind: "failed", failure: "patch_baseline_dirty_worktree",
    cliStarted: false });
  assert.equal(refused.calls.length, 0);

  const stateDir = await mkdtemp(join(tmpdir(), "amux-v22-patch-"));
  const patchBody = "diff --git a/example b/example\n";
  const patchDigest = (await import("node:crypto")).createHash("sha256")
    .update(patchBody).digest("hex");
  const publishFiles = [{ path: "tests/example.test.mjs", mode: "100644",
    bytesBase64: "YQ==" }];
  const filesDigest = (await import("node:crypto")).createHash("sha256")
    .update(JSON.stringify(publishFiles)).digest("hex");
  try {
    const fake = fakeSpawn(JSON.stringify(usage));
    const handler = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run: (input) => runAmuxV22OneShot(input, config, {
        syntheticPlatform: true, spawnChild: fake.spawnChild,
        captureBaseline: async () => ({ ok: true, baseSha: "a".repeat(40) }),
        capturePatch: async () => ({ ok: true, baseSha: "a".repeat(40),
          patchBody, patchDigest, publishFiles }),
      }) });
    assert.equal((await handler({ op: "execute", ...request })).kind,
      "in_progress");
    const result = await readFinished(handler);
    assert.equal(result.patchBody, patchBody);
    assert.equal(result.patchDigest, patchDigest);
    assert.deepEqual(result.publishFiles, publishFiles);
    assert.equal(result.publishFilesDigest, filesDigest);
    assert.equal((await readFile(join(stateDir, `${attemptId}.result`),
      "utf8")).includes(patchBody), false);
    assert.equal((await readFile(join(stateDir, `${attemptId}.result`),
      "utf8")).includes(filesDigest), true);
    assert.equal((await handler({ op: "confirm_patch", attemptId,
      patchDigest })).kind, "confirmed");
    assert.equal((await handler({ op: "readback", attemptId })).patchBody,
      undefined);
    assert.equal((await handler({ op: "readback", attemptId }))
      .publishFilesDigest, filesDigest);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("unknown output and deadline never become success or retry", async () => {
  const malformed = fakeSpawn("not-json");
  const malformedResult = await runAmuxV22OneShot(request, config, {
    syntheticPlatform: true, spawnChild: malformed.spawnChild,
  });
  assert.deepEqual({ kind: malformedResult.kind,
    failure: malformedResult.failure },
    { kind: "outcome_unknown", failure: "invalid_result" });

  const wrongShape = fakeSpawn("{}");
  const wrongShapeResult = await runAmuxV22OneShot(request, config, {
    syntheticPlatform: true, spawnChild: wrongShape.spawnChild,
  });
  assert.deepEqual({ kind: wrongShapeResult.kind,
    failure: wrongShapeResult.failure },
    { kind: "outcome_unknown", failure: "invalid_result" });

  const hanging = fakeSpawn("", { hang: true });
  const timeoutResult = await runAmuxV22OneShot(request, config, {
    syntheticPlatform: true, spawnChild: hanging.spawnChild,
    deadlineMs: 5,
  });
  assert.deepEqual({ kind: timeoutResult.kind,
    failure: timeoutResult.failure },
    { kind: "outcome_unknown", failure: "deadline" });
  assert.equal(hanging.calls.length, 1);
});

test("durable claim prevents duplicate CLI invocation across handler restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "amux-v22-once-"));
  try {
    let calls = 0;
    const run = async (input) => {
      calls += 1;
      return { kind: "succeeded", attemptId: input.attemptId,
        cliStarted: true };
    };
    const first = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run });
    const execute = { op: "execute", ...request };
    assert.equal((await first(execute)).kind, "in_progress");
    assert.equal((await readFinished(first)).kind, "succeeded");
    assert.equal((await first(execute)).kind, "succeeded");
    const restarted = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run });
    assert.equal((await restarted(execute)).kind, "succeeded");
    assert.equal((await restarted({ op: "readback", attemptId })).kind,
      "succeeded");
    assert.equal(calls, 1);
    await assert.rejects(restarted({ ...execute,
      prompt: "Different brief" }), /conflict/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("result text is available for exact transfer but never persisted in the sidecar journal", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "amux-v22-result-"));
  try {
    const text = "Private review result";
    const sha256 = (await import("node:crypto")).createHash("sha256")
      .update(text).digest("hex");
    const handler = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run: async (input) => ({ kind: "succeeded",
        attemptId: input.attemptId, resultText: text,
        resultSha256: sha256 }) });
    assert.equal((await handler({ op: "execute", ...request })).kind,
      "in_progress");
    const result = await readFinished(handler);
    assert.equal(result.resultText, text);
    assert.equal(result.resultSha256, sha256);
    assert.equal((await readFile(join(stateDir, `${attemptId}.result`),
      "utf8")).includes(text), false);
    assert.equal((await handler({ op: "confirm_result", attemptId,
      sourceSha256: sha256 })).kind, "confirmed");
    assert.equal((await handler({ op: "readback", attemptId })).resultText,
      undefined);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("a crash after the claim is unknown, never a second invocation", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "amux-v22-crash-"));
  try {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const run = async (input) => { calls += 1; await pending;
      return { kind: "failed", attemptId: input.attemptId }; };
    const first = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run });
    const execute = { op: "execute", ...request };
    assert.equal((await first(execute)).kind, "in_progress");
    // The claim is created asynchronously, so wait until it has been written.
    for (let i = 0; i < 50 && calls === 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(calls, 1);
    assert.equal((await first(execute)).kind, "in_progress");
    const restarted = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run });
    assert.equal((await restarted(execute)).kind, "outcome_unknown");
    assert.equal(calls, 1);
    release();
    assert.equal((await readFinished(first)).kind, "failed");
    assert.equal((await restarted({ op: "readback", attemptId })).kind,
      "failed");
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("Ubuntu runs one synthetic CLI process and replays its durable result",
  { skip: process.platform !== "linux" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "amux-v22-process-"));
    const stateDir = join(root, "state");
    const binaryPath = join(root, "synthetic-claude");
    const callsPath = join(root, "calls");
    try {
      await mkdir(stateDir, { mode: 0o700 });
      await writeFile(binaryPath, `#!/bin/sh\nprintf x >> '${callsPath}'\nprintf '%s\\n' '{"type":"result","subtype":"success","is_error":false}'\n`);
      await chmod(binaryPath, 0o700);
      const handler = createAmuxV22SidecarHandler({ worker: "worker-a",
        stateDir, run: (input) => runAmuxV22OneShot(input, {
          ...config, binaryPath, worktreePath: root, homePath: root,
          claudeConfigDir: root,
        }) });
      const execute = { op: "execute", ...request, role: "review" };
      assert.equal((await handler(execute)).kind, "in_progress");
      const finished = await readFinished(handler);
      assert.equal(finished.kind, "succeeded");
      assert.match(finished.outputDigest, /^[0-9a-f]{64}$/);
      const restarted = createAmuxV22SidecarHandler({ worker: "worker-a",
        stateDir, run: () => { throw new Error("duplicate CLI invocation"); } });
      assert.deepEqual(await restarted(execute), finished);
      assert.equal(await readFile(callsPath, "utf8"), "x");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

test("Ubuntu socket carries only one bounded request and supports readback",
  { skip: process.platform !== "linux" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "amux-v22-socket-"));
    const socketPath = join(root, "worker.sock");
    const stateDir = join(root, "state");
    const { mkdir, stat } = await import("node:fs/promises");
    await mkdir(stateDir, { mode: 0o700 });
    let calls = 0;
    const handler = createAmuxV22SidecarHandler({ worker: "worker-a",
      stateDir, run: async (input) => { calls += 1;
        return { kind: "succeeded", attemptId: input.attemptId }; } });
    const server = createAmuxV22SidecarServer(socketPath, handler);
    const send = (body) => new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let answer = "";
      socket.once("error", reject);
      socket.on("data", (part) => { answer += part.toString("utf8"); });
      socket.once("end", () => resolve(JSON.parse(answer)));
      socket.once("connect", () => socket.end(`${JSON.stringify(body)}\n`));
    });
    try {
      await checkAmuxV22SidecarSocketDir(socketPath);
      await server.listen();
      assert.equal((await stat(socketPath)).mode & 0o777, 0o660);
      assert.equal((await send({ op: "execute", ...request })).kind,
        "in_progress");
      let answer;
      for (let i = 0; i < 100; i += 1) {
        answer = await send({ op: "readback", attemptId });
        if (answer.kind !== "in_progress") break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.equal(answer.kind, "succeeded");
      assert.equal((await send({ op: "execute", ...request })).kind,
        "succeeded");
      assert.equal(calls, 1);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test("Ubuntu socket parent must be private",
  { skip: process.platform !== "linux" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "amux-v22-permission-"));
    const { chmod } = await import("node:fs/promises");
    try {
      await chmod(root, 0o755);
      await assert.rejects(checkAmuxV22SidecarSocketDir(
        join(root, "worker.sock")), /unsafe/);
      await chmod(root, 0o750);
      await checkAmuxV22SidecarSocketDir(join(root, "worker.sock"));
      await chmod(root, 0o770);
      await assert.rejects(checkAmuxV22SidecarSocketDir(
        join(root, "worker.sock")), /unsafe/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
