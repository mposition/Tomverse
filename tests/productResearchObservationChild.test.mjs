// Running a child so that a deadline can actually end it.
//
// Both reviewers of the product-research release found this by reading the
// code, because `spawnSync` left nothing a test could exercise: it blocks the
// event loop, so the run's own deadline cannot fire while a child runs, and its
// `timeout` sends SIGTERM and then waits, so a child that ignores SIGTERM is
// waited for forever. These hold the replacement.

import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  CHILD_KILL_GRACE_MS,
  CHILD_OUTPUT_MAX_BYTES,
  endChild,
  runChild,
} from "../lib/productResearchObservationChild.mjs";

/** A child that is this process's own binary, so the test needs nothing installed. */
const node = (source, options) =>
  runChild(process.execPath, ["-e", source], options);

test("a child that outlives its deadline is ended, and says so", async () => {
  const started = Date.now();
  const result = await node("setInterval(() => {}, 1000)", { timeoutMs: 300 });
  const elapsed = Date.now() - started;

  // `timedOut` is a fact the runner knows and the caller cannot infer: a kill
  // looks the same from outside whatever caused it.
  assert.equal(result.timedOut, true);
  assert.notEqual(result.status === 0, true);
  // It did not wait for the child's own idea of when to stop, which was never.
  assert.ok(elapsed < 300 + CHILD_KILL_GRACE_MS + 5_000, `${elapsed}ms`);
});

test("the event loop keeps running while a child does", async () => {
  // The whole reason this is not `spawnSync`. Under that the timer below could
  // not fire until the child had finished, which is exactly why the run's
  // fifteen-minute deadline could never end a hung child.
  let ticks = 0;
  const ticking = setInterval(() => {
    ticks += 1;
  }, 20);
  try {
    await node("setTimeout(() => {}, 400)");
  } finally {
    clearInterval(ticking);
  }
  assert.ok(ticks > 5, `the loop ticked ${ticks} times while a child ran`);
});

test("a child that ignores SIGTERM is killed anyway", { skip: process.platform === "win32" }, async () => {
  // The second half of the defect. `spawnSync` asks once and then waits
  // forever; this asks, waits the grace period, and then does not ask.
  const started = Date.now();
  const result = await node(
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    { timeoutMs: 200 },
  );
  const elapsed = Date.now() - started;

  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  // It took the grace period and not much more: the SIGTERM was sent, ignored,
  // and followed up.
  assert.ok(elapsed >= CHILD_KILL_GRACE_MS, `${elapsed}ms is too fast to have waited`);
  assert.ok(elapsed < CHILD_KILL_GRACE_MS + 5_000, `${elapsed}ms`);
});

test("a grandchild goes with its parent", { skip: process.platform === "win32" }, async () => {
  // `git clone` starts `git-remote-https`. Killing only git would leave that
  // holding the connection, which is why children are spawned detached and the
  // kill addresses the process group.
  const result = await node(
    [
      "const { spawn } = require('node:child_process');",
      "const kid = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });",
      "console.log(kid.pid);",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    { timeoutMs: 400 },
  );
  assert.equal(result.timedOut, true);
  const grandchild = Number(result.stdout.trim());
  assert.ok(Number.isInteger(grandchild) && grandchild > 0, result.stdout);

  // `kill(pid, 0)` asks whether the process exists without signalling it.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.throws(
    () => process.kill(grandchild, 0),
    /ESRCH/,
    "the grandchild outlived the child it was started by",
  );
});

test("a child printing without end is stopped rather than buffered", async () => {
  const result = await node(
    "for (;;) process.stdout.write('x'.repeat(64 * 1024));",
    { maxBytes: 128 * 1024, timeoutMs: 20_000 },
  );
  assert.equal(result.overflowed, true);
  assert.equal(result.timedOut, false);
  // Held output stays near the cap rather than growing to whatever the child
  // felt like sending.
  assert.ok(result.stdout.length <= 256 * 1024, `${result.stdout.length} bytes held`);
  assert.ok(CHILD_OUTPUT_MAX_BYTES > 0);
});

test("a command that does not exist answers instead of throwing", async () => {
  // A caller with its own deadline must not be left waiting on a promise that
  // never settles, and must not have to catch to find out.
  const result = await runChild("a-command-that-is-not-installed", ["--version"], {
    timeoutMs: 5_000,
  });
  assert.equal(result.status, null);
  assert.equal(result.timedOut, false);
  assert.ok(result.error, "a missing binary should be reported, not swallowed");
});

test("ending something already gone is not an error", () => {
  // A watchdog is the last thing that should be taken down by its own cleanup.
  assert.equal(endChild(null, "SIGKILL"), false);
  assert.equal(endChild(undefined, "SIGKILL"), false);
  assert.equal(endChild({ exitCode: 0, signalCode: null, pid: 1 }, "SIGKILL"), false);
  assert.equal(endChild({ exitCode: null, signalCode: "SIGKILL", pid: 1 }, "SIGKILL"), false);
});
