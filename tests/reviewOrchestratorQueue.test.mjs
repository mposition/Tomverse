// What kept the queue full on 2026-10-02: every job carried hundreds of other
// people's files, so every job tripped the contract floor into two reviewers,
// and every second reviewer had to be the one vendor left.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateConfig } from "../tools/review-orchestrator/lib/config.mjs";
import { Orchestrator } from "../tools/review-orchestrator/lib/service.mjs";
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
const write = (dir, file, body) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), body);
};

/**
 * origin has main and develop; develop is main plus a merged contract change
 * (prisma) by someone else. The work branch is cut from develop.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-orch-queue-"));
  const origin = join(root, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  write(origin, "a.txt", "one\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "base");
  git(origin, "checkout", "-q", "-b", "develop");
  write(origin, "prisma/migrations/1/migration.sql", "someone else's\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "merged contract work on develop");
  const work = join(root, "work");
  git(root, "clone", "-q", "--branch", "develop", origin, work);
  const raw = {
    stateDir: join(root, "state"),
    pollMs: 50,
    waitMaxSeconds: 1,
    repos: { demo: { url: origin, mirror: join(root, "state", "mirrors", "demo.git") } },
    contractPaths: ["prisma/**"],
    providers: [
      { id: "claude", vendor: "anthropic", enabled: true, maxConcurrent: 2, command: process.execPath, args: [FAKE, "accept"] },
      { id: "cursor", vendor: "xai", enabled: true, maxConcurrent: 2, command: process.execPath, args: [FAKE, "accept"] },
    ],
  };
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(raw));
  const env = { ...process.env, REVIEW_ORCH_CONFIG: configPath, REVIEW_ORCH_LOCAL_BIN: SERVER };
  const client = (...args) => run(process.execPath, [CLIENT, ...args], { cwd: work, env });
  const server = (...args) => run(process.execPath, [SERVER, ...args], { env });
  const commit = (file, body) => {
    write(work, file, body);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", `change ${file}`);
    return git(work, "rev-parse", "HEAD");
  };
  return { root, work, config: validateConfig(raw), client, server, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("--base origin/main on a develop branch still uses develop's nearer fork point", () => {
  const f = fixture();
  try {
    const developTip = git(f.work, "rev-parse", "origin/develop");
    f.commit("mine.txt", "my change\n");
    const result = JSON.parse(f.client("submit", "--author", "codex", "--repo", "demo", "--base", "origin/main").stdout);
    const { job } = new Store(f.config.stateDir).readJob(result.jobId);
    assert.equal(job.base, developTip);
    // Only this branch's file, so no contract floor from someone else's migration.
    assert.equal(result.fileCount, 1);
    assert.equal(result.reviewers, 1);
    assert.equal(result.touchesContract, false);
  } finally {
    f.cleanup();
  }
});

test("a focus this server finished reviewing narrows the contract count; an unreviewed one does not", async () => {
  const f = fixture();
  try {
    f.commit("prisma/migrations/2/migration.sql", "my contract change\n");
    const round1 = f.commit("doc.md", "round one\n");
    // Round 1 is reviewed by this server: contract change, two reviewers.
    const first = JSON.parse(f.client("submit", "--author", "codex", "--repo", "demo").stdout);
    assert.equal(first.reviewers, 2);
    const orchestrator = new Orchestrator(f.config);
    orchestrator.tick(allAvailable(f.config));
    await orchestrator.idle();
    // Round 2 touches no contract path since round 1's head.
    f.commit("doc.md", "round two\n");
    const second = JSON.parse(f.client("submit", "--author", "codex", "--repo", "demo", "--focus", round1).stdout);
    assert.equal(second.reviewers, 1, JSON.stringify(second));
    assert.equal(new Store(f.config.stateDir).readJob(second.jobId).job.focusReviewed, true);
  } finally {
    f.cleanup();
  }
});

test("a focus nobody reviewed keeps the whole range in the contract count", () => {
  const f = fixture();
  try {
    f.commit("prisma/migrations/2/migration.sql", "unreviewed contract change\n");
    const hidden = f.commit("doc.md", "one\n");
    f.commit("doc.md", "two\n");
    const result = JSON.parse(f.client("submit", "--author", "codex", "--repo", "demo", "--focus", hidden).stdout);
    assert.equal(result.reviewers, 2);
    assert.equal(new Store(f.config.stateDir).readJob(result.jobId).job.focusReviewed, false);
  } finally {
    f.cleanup();
  }
});

test("cancel closes queued slots as unknown, leaves running ones, and is local only", () => {
  const f = fixture();
  try {
    f.commit("prisma/migrations/2/migration.sql", "contract\n");
    const { jobId } = JSON.parse(f.client("submit", "--author", "codex", "--repo", "demo").stdout);
    const store = new Store(f.config.stateDir);
    store.writeSlot(jobId, { index: 0, status: "running", provider: "claude", vendor: "anthropic", assignedAt: Date.now() });
    const cancelled = f.server("cancel", jobId);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.deepEqual(JSON.parse(cancelled.stdout), [{ jobId, closedSlots: 1 }]);
    assert.equal(store.readSlot(jobId, 0).status, "running");
    assert.deepEqual(
      { status: store.readSlot(jobId, 1).status, reason: store.readSlot(jobId, 1).reason },
      { status: "done", reason: "cancelled_by_operator" },
    );
    // A cancelled review is not a review: it never narrows a later contract count.
    assert.equal(f.server("cancel", "../etc").code, 64);
  } finally {
    f.cleanup();
  }
});
