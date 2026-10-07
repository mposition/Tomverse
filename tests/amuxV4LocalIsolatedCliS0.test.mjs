import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chmod, lstat, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { amuxV4SandboxArgs } from "../lib/amux/ideaLocalSandboxArgs.mjs";
import { AMUX_V4_CLI_HARD_DEADLINE_MS,
  AMUX_V4_CODEX_S0_ENABLED, AMUX_V4_CLAUDE_S0_ENABLED,
  awaitAmuxV4BoundedChild, amuxV4CliCaughtFailureStage,
  amuxV4CliExitFailureStage, amuxV4CliInspectionFailureStage,
  amuxV4CliUnknownResult,
  runAmuxV4IsolatedSyntheticCliS0 } from
  "../lib/amux/ideaLocalIsolatedCliRunner.mjs";
import { inspectAmuxV4AnalysisCliResult,
  planAmuxV4AnalysisCliInvocation } from "../lib/amux/ideaLocalCliContract.mjs";
import { claimAmuxV4SyntheticS0Once } from "../lib/amux/ideaLocalS0Once.mjs";

test("v13 one-shot deadline is ten minutes", () => {
  assert.equal(AMUX_V4_CLI_HARD_DEADLINE_MS, 600_000);
});

test("CLI exit diagnosis exposes only a bounded stage", () => {
  assert.equal(amuxV4CliExitFailureStage({ timedOut: true,
    code: null, signal: "SIGKILL" }, false), "deadline");
  assert.equal(amuxV4CliExitFailureStage({ timedOut: false,
    code: null, signal: "SIGKILL" }, true), "stdout_limit");
  assert.equal(amuxV4CliExitFailureStage({ timedOut: false,
    code: 2, signal: null }, false), "child_nonzero");
  assert.equal(amuxV4CliExitFailureStage({ timedOut: false,
    code: 0, signal: null }, false), null);
});

test("invalid CLI output maps to parser rejection without exposing output", () => {
  const plan = planAmuxV4AnalysisCliInvocation({ provider: "anthropic",
    modelId: "claude-opus-5-5", reasoningEffort: "high" });
  const inspected = inspectAmuxV4AnalysisCliResult(plan,
    Buffer.from("not-json\n"), 0);
  assert.deepEqual(inspected, { kind: "outcome_unknown" });
  assert.equal(amuxV4CliInspectionFailureStage(inspected), "parser_rejected");
  assert.equal(amuxV4CliInspectionFailureStage({ kind: "verified_success" }), null);
});

test("spawn/setup and post-spawn I/O are separate metadata-only stages", () => {
  assert.equal(amuxV4CliCaughtFailureStage(false), "setup_or_spawn_error");
  assert.equal(amuxV4CliCaughtFailureStage(true), "child_io_error");
});

test("unknown CLI receipt carries only bounded exit and CONNECT counters", () => {
  const counts = { approved: 1, denied: 2 };
  assert.deepEqual(amuxV4CliUnknownResult("child_nonzero", 23, counts), {
    kind: "outcome_unknown", failureStage: "child_nonzero",
    parserReason: null, rejectionPoint: null, childExitCode: 23,
    approvedConnects: 1, deniedConnects: 2,
  });
  assert.deepEqual(amuxV4CliUnknownResult("parser_rejected", 0, counts,
    "served_model_mismatch"), { kind: "outcome_unknown",
    failureStage: "parser_rejected", parserReason: "served_model_mismatch",
    rejectionPoint: null, childExitCode: 0,
    approvedConnects: 1, deniedConnects: 2 });
  assert.equal(amuxV4CliUnknownResult("parser_rejected", 0, counts,
    "output_contract_mismatch", "assistant_stop").rejectionPoint,
  "assistant_stop");
  assert.equal(amuxV4CliUnknownResult("deadline", null, counts).childExitCode, null);
});

test("synthetic CLI S0 remains closed after the consumed diagnosis", async () => {
  const previous = process.env.AMUX_V4_SYNTHETIC_S0_APPROVED;
  try {
    delete process.env.AMUX_V4_SYNTHETIC_S0_APPROVED;
    assert.equal(AMUX_V4_CODEX_S0_ENABLED, false);
    assert.equal(AMUX_V4_CLAUDE_S0_ENABLED, false);
    assert.deepEqual(await runAmuxV4IsolatedSyntheticCliS0("openai"),
      { kind: "refused" });
    assert.deepEqual(await runAmuxV4IsolatedSyntheticCliS0("anthropic"),
      { kind: "refused" });
  } finally {
    if (previous === undefined) delete process.env.AMUX_V4_SYNTHETIC_S0_APPROVED;
    else process.env.AMUX_V4_SYNTHETIC_S0_APPROVED = previous;
  }
});

test("S0 script refuses anthropic while its code latch is closed", () => {
  assert.equal(AMUX_V4_CLAUDE_S0_ENABLED, false);
  const script = fileURLToPath(new URL("../scripts/amux-v4-cli-model-s0.mjs", import.meta.url));
  const result = spawnSync(process.execPath,
    ["--import", "tsx", script, "anthropic"], {
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /AMUX_V4_CLI_MODEL_S0_REFUSED/);
});

test("S0 claim is empty, owned, expiring and consumed before any model call", {
  skip: process.platform !== "linux",
}, async () => {
  const directory = await mkdtemp("/tmp/amux-v4-s0-once-");
  const markerName = "s0-claude-test.claimed";
  const markerPath = join(directory, markerName);
  const expiresAt = Date.now() + 30_000;
  try {
    await chmod(directory, 0o755);
    assert.equal(await claimAmuxV4SyntheticS0Once({ directory,
      markerName, expiresAt }), false);
    await chmod(directory, 0o700);
    assert.equal(await claimAmuxV4SyntheticS0Once({ directory,
      markerName, expiresAt, now: expiresAt }), false);
    assert.equal(await claimAmuxV4SyntheticS0Once({ directory,
      markerName, expiresAt }), true);
    const marker = await lstat(markerPath);
    assert.equal(marker.size, 0);
    assert.equal(marker.mode & 0o777, 0o600);
    assert.equal(marker.uid, process.getuid());
    assert.equal(await claimAmuxV4SyntheticS0Once({ directory,
      markerName, expiresAt }), false);
  } finally {
    try { await unlink(markerPath); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rmdir(directory);
  }
});

test("bounded child kills its process group at the deadline without a model call", {
  skip: process.platform !== "linux",
}, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
    { detached: true, stdio: "ignore", shell: false,
      env: { PATH: "/usr/bin:/bin" } });
  const result = await awaitAmuxV4BoundedChild(child, 50);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
});

test("failed child spawn is handled without an unhandled error", {
  skip: process.platform !== "linux",
}, async () => {
  const child = spawn("/definitely-not-an-amux-command", [],
    { detached: true, stdio: "ignore", shell: false });
  await assert.rejects(awaitAmuxV4BoundedChild(child, 50),
    { code: "ENOENT" });
  assert.equal(amuxV4CliCaughtFailureStage(false), "setup_or_spawn_error");
});

test("nonzero fake CLI is diagnosed without reading its stderr", {
  skip: process.platform !== "linux",
}, async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(23)"], {
    detached: true, stdio: "ignore", shell: false,
    env: { PATH: "/usr/bin:/bin" },
  });
  const exit = await awaitAmuxV4BoundedChild(child, 1_000);
  assert.equal(amuxV4CliExitFailureStage(exit, false), "child_nonzero");
});

test("deadline kills a fake CLI inside the bwrap process tree", {
  // GitHub-hosted Node may live outside /usr/bin and bwrap is not installed
  // there; the dedicated Ubuntu S0 exercises this exact sandbox path.
  skip: process.platform !== "linux" ? "Linux sandbox only" :
    !existsSync("/usr/bin/node") || !existsSync("/usr/bin/bwrap") ?
      "requires the dedicated Ubuntu S0 image" : false,
}, async () => {
  const directory = await mkdtemp("/tmp/amux-v4-socket-");
  const socketPath = join(directory, "proxy.sock");
  const server = createServer();
  let child;
  let client;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const connected = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("fake CLI did not connect")), 2_000);
      server.once("connection", (socket) => {
        clearTimeout(timeout);
        client = socket;
        resolve();
      });
    });
    const fakeCli = "const s=require('node:net').connect('/run/amux/proxy.sock');" +
      "s.on('connect',()=>setInterval(()=>{},1000));" +
      "setTimeout(()=>process.exit(0),3000);";
    child = spawn("/usr/bin/bwrap", amuxV4SandboxArgs(directory,
      ["/usr/bin/node", "-e", fakeCli]), {
      detached: true, shell: false, stdio: "ignore", env: { PATH: "/usr/bin:/bin" },
    });
    await connected;
    const closed = new Promise((resolve) => client.once("close", resolve));
    const result = await awaitAmuxV4BoundedChild(child, 50);
    assert.equal(result.timedOut, true);
    await Promise.race([closed,
      new Promise((_resolve, reject) => setTimeout(() =>
        reject(new Error("fake CLI survived the bwrap deadline")), 1_000))]);
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    client?.destroy();
    await new Promise((resolve) => server.close(resolve));
    try { await unlink(socketPath); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rmdir(directory);
  }
});

test("S0 runner rejects arbitrary provider and absent explicit S0 gate before any spawn", async () => {
  const previous = process.env.AMUX_V4_SYNTHETIC_S0_APPROVED;
  try {
    delete process.env.AMUX_V4_SYNTHETIC_S0_APPROVED;
    assert.deepEqual(await runAmuxV4IsolatedSyntheticCliS0("openai"),
      { kind: "refused" });
    process.env.AMUX_V4_SYNTHETIC_S0_APPROVED = "1";
    assert.deepEqual(await runAmuxV4IsolatedSyntheticCliS0("other"),
      { kind: "refused" });
  } finally {
    if (previous === undefined) delete process.env.AMUX_V4_SYNTHETIC_S0_APPROVED;
    else process.env.AMUX_V4_SYNTHETIC_S0_APPROVED = previous;
  }
});
