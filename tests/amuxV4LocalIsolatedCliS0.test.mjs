import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { AMUX_V4_CLI_HARD_DEADLINE_MS,
  AMUX_V4_SYNTHETIC_S0_ENABLED,
  awaitAmuxV4BoundedChild,
  runAmuxV4IsolatedSyntheticCliS0 } from
  "../lib/amux/ideaLocalIsolatedCliRunner.mjs";

test("v13 one-shot deadline is ten minutes", () => {
  assert.equal(AMUX_V4_CLI_HARD_DEADLINE_MS, 600_000);
});

test("rejected S0 call path remains code-latched off", async () => {
  const previous = process.env.AMUX_V4_SYNTHETIC_S0_APPROVED;
  try {
    process.env.AMUX_V4_SYNTHETIC_S0_APPROVED = "1";
    assert.equal(AMUX_V4_SYNTHETIC_S0_ENABLED, false);
    assert.deepEqual(await runAmuxV4IsolatedSyntheticCliS0("openai"),
      { kind: "refused" });
    assert.deepEqual(await runAmuxV4IsolatedSyntheticCliS0("anthropic"),
      { kind: "refused" });
  } finally {
    if (previous === undefined) delete process.env.AMUX_V4_SYNTHETIC_S0_APPROVED;
    else process.env.AMUX_V4_SYNTHETIC_S0_APPROVED = previous;
  }
});

test("S0 script refuses even with its former environment approval", () => {
  const script = fileURLToPath(new URL("../scripts/amux-v4-cli-model-s0.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "openai"], {
    env: { ...process.env, AMUX_V4_SYNTHETIC_S0_APPROVED: "1" },
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
