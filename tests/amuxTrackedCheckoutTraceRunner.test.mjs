import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { launchAmuxV19TracedSandbox } from
  "../lib/amux/ideaTrackedCheckoutTraceRunner.mjs";

// These run the real traced sandbox: strace following bwrap with unprivileged
// user namespaces. The v19 Ubuntu runner has both; a host without them (the
// hosted CI runner restricts unprivileged user namespaces) skips with the
// reason instead of reporting a sandbox it could not build as a trace failure.
const sandboxUnavailable = (() => {
  if (process.platform !== "linux") return "linux only";
  if (!existsSync("/usr/bin/strace") || !existsSync("/usr/bin/bwrap"))
    return "strace or bwrap is not installed";
  try {
    execFileSync("/usr/bin/strace", ["-f", "-qq", "-o", "/dev/null", "/usr/bin/bwrap",
      "--unshare-all", "--ro-bind", "/", "/", "/bin/true"], { stdio: "ignore", timeout: 15_000 });
    return false;
  } catch { return "strace cannot follow an unprivileged bwrap sandbox on this host"; }
})();

test("isolated traced child streams opened checkout paths without a log", {
  skip: sandboxUnavailable,
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

test("Node's io_uring is refused and its read is still observed as a complete manifest", {
  skip: sandboxUnavailable,
}, async () => {
  // Measured 2026-10-19 on the v19 runner: without the seccomp filter Node 22's
  // libuv io_uring_setup succeeds and the manifest could not be certified.
  const directory = await mkdtemp("/tmp/amux-v19-checkout-");
  let launched;
  try {
    await writeFile(join(directory, "TRACE.txt"), "S0_OK\n", { mode: 0o400 });
    launched = await launchAmuxV19TracedSandbox({ directory, files: ["TRACE.txt"], diagnostic: true, args: [
      "--unshare-all", "--die-with-parent", "--cap-drop", "ALL", "--clearenv",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--ro-bind", directory, directory, "--chdir", directory,
      "--setenv", "PATH", "/usr/bin:/bin", "--", "/usr/bin/node", "-e",
      "require('fs').readFile('TRACE.txt', (e, d) => process.stdout.write(e ? 'ERR' : d))",
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
    assert.deepEqual(await launched.finishTrace(exit), { kind: "complete", files: ["TRACE.txt"] });
  } finally {
    await launched?.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent reads that strace splits across threads still form a complete manifest", {
  skip: sandboxUnavailable,
}, async () => {
  // The sixth Max S0 call ended `undecoded_open`: strace -f writes a call that
  // another thread interrupts as `<unfinished ...>` plus `<... resumed>`.
  const directory = await mkdtemp("/tmp/amux-v19-checkout-");
  const files = Array.from({ length: 24 }, (_, index) => `f${index}.txt`);
  let launched;
  try {
    for (const file of files) await writeFile(join(directory, file), "x\n", { mode: 0o400 });
    launched = await launchAmuxV19TracedSandbox({ directory, files, diagnostic: true, args: [
      "--unshare-all", "--die-with-parent", "--cap-drop", "ALL", "--clearenv",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--ro-bind", directory, directory, "--chdir", directory,
      "--setenv", "PATH", "/usr/bin:/bin", "--", "/usr/bin/node", "-e",
      `Promise.all(${JSON.stringify(files)}.map((f) => require('fs').promises.readFile(f)))` +
        ".then((all) => process.stdout.write(String(all.length)))",
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
    assert.equal(output, String(files.length));
    assert.deepEqual(await launched.finishTrace(exit),
      { kind: "complete", files: [...files].sort() });
  } finally {
    await launched?.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a caller cannot pass its own seccomp program", async () => {
  await assert.rejects(launchAmuxV19TracedSandbox({ directory: "/tmp/amux-v19-checkout-Ab12c3",
    files: [], args: ["--seccomp", "4", "--", "/usr/bin/true"] }), TypeError);
});
