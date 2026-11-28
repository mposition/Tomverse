import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { planCommand, runCommand } from "../../tomverse-cli/src/commands.js";
import { codeProcessLaunch } from "../src/host/code-process-launch";
import { spawnNativeFixture } from "../src/host/spawn-native-fixture";

const linuxOnly = { skip: process.platform !== "linux", timeout: 10_000 };

async function liveIdentity(pid: number) {
  const stat = await readFile("/proc/" + pid + "/stat", "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return;
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
  if (fields[0] !== "Z" && fields[0] !== "X") return fields[19];
}

if (process.argv[2] === "--fixture-worker") {
  const child = spawnNativeFixture(process.execPath, ["-e", process.argv[3]!], { cwd: process.cwd(), env: process.env });
  child.stdout.pipe(process.stdout);
} else if (process.argv[2] === "--command-worker") {
  const plan = planCommand({ argv: [process.execPath, "-e", process.argv[3]!] }, process.cwd(), 6_000);
  await runCommand(plan, new AbortController().signal, (stream, text) => {
    if (stream === "stdout") process.stdout.write(text);
  }, [], codeProcessLaunch);
} else {
  for (const [kind, flag] of [
    ["native fixture", "--fixture-worker"], ["managed command", "--command-worker"],
  ]) test(`the Linux ${kind} ends its process tree when the Code worker exits`, linuxOnly, async () => {
    const commandScript = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'console.log(JSON.stringify([process.pid, child.pid]));',
      'setInterval(() => {}, 1000);',
    ].join("\n");
    const worker = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), flag, commandScript],
      { stdio: ["ignore", "pipe", "inherit"] });
    const exited = once(worker, "exit");
    const output = createInterface({ input: worker.stdout, crlfDelay: Infinity });
    const observed = new Map<number, string>();
    try {
      const message = await Promise.race([once(output, "line", { signal: AbortSignal.timeout(4_000) }),
        exited.then(() => { throw new Error("The Linux Code worker exited before reporting its process tree."); })]);
      const pids = JSON.parse(message[0] as string) as number[];
      assert.equal(pids.length, 2);
      for (const pid of pids) {
        assert.ok(Number.isInteger(pid) && pid > 0);
        const identity = await liveIdentity(pid);
        assert.ok(identity);
        observed.set(pid, identity);
      }
      worker.kill("SIGKILL");
      await exited;
      for (let i = 0; i < 40 && (await Promise.all(pids.map(liveIdentity))).some(Boolean); i++) await delay(50);
      assert.deepEqual(await Promise.all(pids.map(liveIdentity)), [undefined, undefined]);
    } finally {
      output.close();
      worker.stdout.destroy();
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
      for (const [pid, identity] of observed) {
        if (await liveIdentity(pid) !== identity) continue;
        try { process.kill(pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  });

  test("the Linux fixture forwards standard input, output and the ordinary exit status", linuxOnly, async () => {
    const child = spawnNativeFixture(process.execPath, ["-e", "process.stdin.pipe(process.stdout); process.exitCode = 7;"],
      { cwd: process.cwd(), env: process.env });
    const closed = once(child, "close");
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stdin.end("the fixture input\n");
    try {
      assert.deepEqual(await closed, [7, null]);
      assert.equal(Buffer.concat(output).toString("utf8"), "the fixture input\n");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  test("the Linux managed command forwards the approved arguments and keeps stdin closed", linuxOnly, async () => {
    const script = 'process.stdin.on("end", () => { console.log(process.argv[1]); console.error("command stderr"); process.exitCode = 7; }); process.stdin.resume();';
    const argument = 'one two $VALUE "quotes"; *';
    const plan = planCommand({ argv: [process.execPath, "-e", script, argument] }, process.cwd(), 4_000);
    const result = await runCommand(plan, new AbortController().signal, undefined, [], codeProcessLaunch);
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, argument + "\n");
    assert.equal(result.stderr, "command stderr\n");
    assert.deepEqual(result.residualProcesses, []);
  });

  test("the fixture releases the protocol reader after an input pipe error", linuxOnly, async () => {
    const child = spawnNativeFixture(process.execPath, ["-e",
      'require("node:fs").closeSync(0); console.log("input closed"); setInterval(() => {}, 1000);'],
      { cwd: process.cwd(), env: process.env });
    const closed = once(child, "close");
    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      assert.deepEqual(await once(output, "line", { signal: AbortSignal.timeout(4_000) }), ["input closed"]);
      const stdoutClosed = once(child.stdout, "close", { signal: AbortSignal.timeout(4_000) });
      const error = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
        child.stdin.write("unread input\n", (error) => resolve((error ?? undefined) as NodeJS.ErrnoException | undefined));
      });
      assert.equal(error?.code, "EPIPE");
      await stdoutClosed;
      assert.equal(child.exitCode, null);
    } finally {
      output.close();
      if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
      await closed;
    }
  });
}
