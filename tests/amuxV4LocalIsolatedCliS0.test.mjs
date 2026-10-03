import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { AMUX_V4_CLI_HARD_DEADLINE_MS,
  awaitAmuxV4BoundedChild,
  runAmuxV4IsolatedSyntheticCliS0 } from
  "../lib/amux/ideaLocalIsolatedCliRunner.mjs";

test("v13 one-shot deadline is ten minutes", () => {
  assert.equal(AMUX_V4_CLI_HARD_DEADLINE_MS, 600_000);
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
