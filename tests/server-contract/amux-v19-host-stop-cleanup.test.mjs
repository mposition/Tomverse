import assert from "node:assert/strict";
import { execFileSync, spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as realFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
let mode = "stop";
let spawnCount = 0;
let stageCount = 0;
let sandboxCount = 0;
let cleanupPath;
let gitStarted;
let checkoutSignal;
let gitAbortObserved = false;
let repositoryPath;
let commitSha;

mock.module("node:child_process", { namedExports: {
  spawn(command, args, options) {
    if (command !== "/usr/bin/bwrap") {
      if (command === "/usr/bin/git") {
        checkoutSignal = options.signal;
        if (mode === "stop") {
          const child = new EventEmitter();
          child.stdout = new PassThrough();
          options.signal.addEventListener("abort", () => {
            gitAbortObserved = true;
            queueMicrotask(() => child.emit("error", new Error("synthetic abort")));
          }, { once: true });
          gitStarted?.();
          return child;
        }
      }
      return realSpawn(command, args, options);
    }
    spawnCount += 1;
    // Impossible OS PID and an already-exited child keep host kill paths inert.
    return { pid: Number.MAX_SAFE_INTEGER, exitCode: 0, signalCode: null,
      once() { return this; } };
  },
} });
mock.module("node:fs/promises", { namedExports: {
  ...realFs,
  async rmdir(path, options) {
    if (mode === "cleanup" && path.includes("amux-v4-socket-")) {
      cleanupPath = path;
      throw new Error("synthetic socket cleanup failure");
    }
    return realFs.rmdir(path, options);
  },
} });
mock.module(mod("lib/amux/ideaLocalApprovedCliCatalog.mjs"), {
  namedExports: { amuxV4ApprovedAnalysisCliForModel: () => ({
    provider: "anthropic", modelId: "claude-opus-5-5",
    reasoningEffort: "high", egressHosts: ["api.anthropic.com"],
  }) },
});
mock.module(mod("lib/amux/ideaLocalIsolatedCliRunner.mjs"), {
  namedExports: { stageAmuxV19ClaudeCli: async () => {
    stageCount += 1;
    return { authPath: "/tmp/synthetic-auth" };
  } },
});
mock.module(mod("lib/amux/ideaTrackedCheckoutProcessResult.mjs"), {
  namedExports: { awaitAmuxTrackedCheckoutChild: async () => ({
    kind: "verified_success", rawModelOutput: "{}", readFiles: [],
    inputTokens: 1, outputTokens: 1,
  }) },
});
mock.module(mod("lib/amux/ideaTrackedCheckoutSandbox.mjs"), {
  namedExports: { verifiedAmuxTrackedCheckoutSandbox: async () => {
    sandboxCount += 1;
    return [];
  } },
});

const { AMUX_V19_TRACKED_CHECKOUT_CLI_ENV, AmuxTrackedCheckoutHostError,
  runAmuxV19TrackedCheckoutAnalysis } = await import(
  mod("lib/amux/ideaTrackedCheckoutHostRunner.mjs"));
const input = (stopCheck) => ({
  modelId: "claude-opus-5-5", reasoningEffort: "high",
  prompt: Buffer.from("synthetic prompt"), repositoryPath,
  commitSha, digestSecret: "s".repeat(32), stopCheck,
});
const withSwitch = async (run) => {
  const before = process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
  try {
    process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] = "enabled";
    return await run();
  } finally {
    if (before === undefined) delete process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV];
    else process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] = before;
  }
};

test.before(async () => {
  if (process.platform !== "linux") return;
  repositoryPath = await realFs.mkdtemp(join(tmpdir(), "amux-v19-host-proof-"));
  const git = (args, options = {}) => execFileSync("/usr/bin/git", ["-C", repositoryPath,
    ...args], { stdio: "pipe", env: { ...process.env,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, ...options });
  git(["init", "-q"]);
  await realFs.writeFile(join(repositoryPath, "note.txt"), "synthetic tracked note\n");
  git(["add", "note.txt"]);
  git(["-c", "user.name=AMUX Test", "-c", "user.email=amux@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  commitSha = git(["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
});
test.after(async () => {
  if (cleanupPath) await realFs.rm(cleanupPath, { recursive: true, force: true });
  if (repositoryPath) await realFs.rm(repositoryPath, { recursive: true, force: true });
});

test("operator stop aborts checkout materialization before any CLI spawn", {
  skip: process.platform !== "linux", timeout: 5_000,
}, async () => withSwitch(async () => {
  mode = "stop";
  spawnCount = 0;
  stageCount = 0;
  checkoutSignal = null;
  gitAbortObserved = false;
  let checks = 0;
  const started = new Promise((resolveStarted) => { gitStarted = resolveStarted; });
  try {
    assert.deepEqual(await runAmuxV19TrackedCheckoutAnalysis(input(
      async () => ++checks === 1 ? false : (await started, true))),
    { kind: "outcome_unknown", cliStarted: false });
    assert.ok(checks >= 2);
    assert.equal(checkoutSignal.aborted, true);
    assert.equal(gitAbortObserved, true);
    assert.equal(spawnCount, 0);
    assert.equal(stageCount, 0);
  } finally { gitStarted = null; }
}));

test("cleanup failure after child spawn preserves the provider-use signal", {
  skip: process.platform !== "linux", timeout: 5_000,
}, async () => withSwitch(async () => {
  mode = "cleanup";
  spawnCount = 0;
  stageCount = 0;
  sandboxCount = 0;
  await assert.rejects(runAmuxV19TrackedCheckoutAnalysis(input(
    async () => false)), (error) => {
    assert.ok(error instanceof AmuxTrackedCheckoutHostError);
    assert.equal(error.cliStarted, true);
    assert.match(error.cause.message, /tracked checkout CLI cleanup failed/);
    assert.match(error.cause.errors[0].message, /synthetic socket cleanup failure/);
    return true;
  });
  assert.equal(spawnCount, 1);
  assert.equal(stageCount, 1);
  assert.equal(sandboxCount, 1);
}));
