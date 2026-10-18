import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { launchAmuxV19TracedSandbox } from
  "../lib/amux/ideaTrackedCheckoutTraceRunner.mjs";

test("isolated traced child streams opened checkout paths without a log", {
  skip: process.platform !== "linux",
}, async () => {
  const directory = await mkdtemp("/tmp/amux-v19-checkout-");
  let launched;
  try {
    await writeFile(join(directory, "TRACE.txt"), "S0_OK\n",
      { mode: 0o400 });
    launched = await launchAmuxV19TracedSandbox({ directory,
      files: ["TRACE.txt"], args: [
        "--unshare-all", "--die-with-parent", "--cap-drop", "ALL",
        "--clearenv", "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib",
        "--ro-bind", "/lib64", "/lib64", "--proc", "/proc",
        "--dev", "/dev", "--tmpfs", "/tmp",
        "--ro-bind", directory, directory, "--chdir", directory,
        "--setenv", "PATH", "/usr/bin:/bin", "--", "/usr/bin/cat",
        "TRACE.txt",
      ] });
    const child = launched.child;
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.resume();
    child.stdin.end();
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(output, "S0_OK\n");
    assert.deepEqual(await launched.finishTrace(exit), {
      kind: "complete", files: ["TRACE.txt"],
    });
  } finally {
    await launched?.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
