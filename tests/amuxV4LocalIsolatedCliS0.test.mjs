import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { amuxV4SandboxArgs } from "../lib/amux/ideaLocalSandboxArgs.mjs";
import { AMUX_V4_CLI_HARD_DEADLINE_MS,
  AMUX_V4_CODEX_S0_ENABLED, AMUX_V4_CLAUDE_S0_ENABLED,
  awaitAmuxV4BoundedChild,
  runAmuxV4IsolatedSyntheticCliS0 } from
  "../lib/amux/ideaLocalIsolatedCliRunner.mjs";

test("v13 one-shot deadline is ten minutes", () => {
  assert.equal(AMUX_V4_CLI_HARD_DEADLINE_MS, 600_000);
});

test("temporary S0 activation still requires one-process environment approval", async () => {
  const previous = process.env.AMUX_V4_SYNTHETIC_S0_APPROVED;
  try {
    delete process.env.AMUX_V4_SYNTHETIC_S0_APPROVED;
    assert.equal(AMUX_V4_CODEX_S0_ENABLED, true);
    assert.equal(AMUX_V4_CLAUDE_S0_ENABLED, true);
    assert.deepEqual(await runAmuxV4IsolatedSyntheticCliS0("openai"),
      { kind: "refused" });
    assert.deepEqual(await runAmuxV4IsolatedSyntheticCliS0("anthropic"),
      { kind: "refused" });
  } finally {
    if (previous === undefined) delete process.env.AMUX_V4_SYNTHETIC_S0_APPROVED;
    else process.env.AMUX_V4_SYNTHETIC_S0_APPROVED = previous;
  }
});

test("S0 script refuses without one-process environment approval", () => {
  const script = fileURLToPath(new URL("../scripts/amux-v4-cli-model-s0.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "openai"], {
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /AMUX_V4_CLI_MODEL_S0_REFUSED/);
});

test("bounded child kills its process group at the deadline without a model call", {
  skip: process.platform !== "linux",
}, async () => {
  const child = spawn("/usr/bin/node", ["-e", "setInterval(() => {}, 1000)"],
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
});

test("deadline kills a fake CLI inside the bwrap process tree", {
  skip: process.platform !== "linux",
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
