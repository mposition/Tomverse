// Drain mode: an update stops new assignments, lets running reviews finish,
// restarts, and resumes -- so no review is cut off and closed as unknown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeRpc } from "../tools/review-orchestrator/client/review.mjs";
import { validateConfig } from "../tools/review-orchestrator/lib/config.mjs";
import { Orchestrator, isDraining } from "../tools/review-orchestrator/lib/service.mjs";
import { Store } from "../tools/review-orchestrator/lib/store.mjs";

const allAvailable = (config) => Object.fromEntries(config.providers.map((provider) => [provider.id, { state: "available" }]));

const TOOL = resolve("tools/review-orchestrator");
const CLIENT = join(TOOL, "client/review.mjs");
const SERVER = join(TOOL, "bin/review-orchestrator.mjs");
const FAKE = resolve("tests/fixtures/review-orchestrator/fake-reviewer.mjs");

const run = (cmd, args, opts = {}) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};
const git = (cwd, ...args) => {
  const result = run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-orch-drain-"));
  const origin = join(root, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "develop");
  writeFileSync(join(origin, "a.txt"), "one\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "base");
  const work = join(root, "work");
  git(root, "clone", "-q", origin, work);
  const raw = {
    stateDir: join(root, "state"),
    pollMs: 50,
    waitMaxSeconds: 1,
    repos: { demo: { url: origin, mirror: join(root, "state", "mirrors", "demo.git") } },
    providers: [
      { id: "claude", vendor: "anthropic", enabled: true, command: process.execPath, args: [FAKE, "accept"] },
    ],
  };
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(raw));
  const env = { ...process.env, REVIEW_ORCH_CONFIG: configPath, REVIEW_ORCH_LOCAL_BIN: SERVER };
  const client = (...args) => run(process.execPath, [CLIENT, ...args], { cwd: work, env });
  const server = (...args) => run(process.execPath, [SERVER, ...args], { env });
  const commit = (file, body) => {
    writeFileSync(join(work, file), body);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", `change ${file}`);
  };
  return { root, config: validateConfig(raw), client, server, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("while draining, submits are queued but nothing new starts; lifting the drain resumes", async () => {
  const f = fixture();
  try {
    const on = f.server("drain", "on");
    assert.equal(on.code, 0, on.stderr);
    assert.equal(JSON.parse(on.stdout).draining, true);
    assert.equal(isDraining(f.config), true);

    f.commit("a.txt", "two\n");
    const submitted = f.client("submit", "--author", "codex", "--repo", "demo");
    assert.equal(submitted.code, 3, submitted.stderr);
    const { jobId } = JSON.parse(submitted.stdout);

    const orchestrator = new Orchestrator(f.config);
    assert.deepEqual(orchestrator.tick(allAvailable(f.config)), []);
    assert.equal(new Store(f.config.stateDir).readSlot(jobId, 0).status, "queued");

    assert.equal(f.server("drain", "off").code, 0);
    assert.equal(orchestrator.tick(allAvailable(f.config)).length, 1);
    await orchestrator.idle();
    assert.equal(new Store(f.config.stateDir).readSlot(jobId, 0).verdict, "accept");
  } finally {
    f.cleanup();
  }
});

test("drain wait returns once nothing is running, and refuses to wait while not draining", () => {
  const f = fixture();
  try {
    const refused = f.server("drain", "wait");
    assert.equal(refused.code, 64);
    assert.match(refused.stderr, /not_draining/);

    f.server("drain", "on");
    // A slot left running by another process keeps the wait open until the timeout.
    f.commit("a.txt", "two\n");
    const { jobId } = JSON.parse(f.client("submit", "--author", "codex", "--repo", "demo").stdout);
    const store = new Store(f.config.stateDir);
    store.writeSlot(jobId, { index: 0, status: "running", provider: "claude", vendor: "anthropic", assignedAt: Date.now() });
    const timedOut = f.server("drain", "wait", "--timeout", "1");
    assert.equal(timedOut.code, 3);
    assert.equal(JSON.parse(timedOut.stdout).runningReviews, 1);

    store.writeSlot(jobId, { index: 0, status: "done", verdict: "accept", findings: [], provider: "claude", vendor: "anthropic", assignedAt: Date.now() });
    const idle = f.server("drain", "wait", "--timeout", "5");
    assert.equal(idle.code, 0, idle.stderr);
    assert.equal(JSON.parse(idle.stdout).runningReviews, 0);
  } finally {
    f.cleanup();
  }
});

test("drain is local only: an rpc cannot reach it", () => {
  const f = fixture();
  try {
    const remote = f.server("rpc", encodeRpc({ command: "drain" }));
    assert.equal(remote.code, 64);
    assert.match(remote.stderr, /rpc_command_invalid/);
    assert.equal(isDraining(f.config), false);
  } finally {
    f.cleanup();
  }
});
