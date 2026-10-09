// --focus narrows what the reviewer is shown to <focus>..head, so a later
// review round is judged on what changed since the last one. It must not
// narrow what decides the reviewer's instructions or the reviewer count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-orch-focus-"));
  const origin = join(root, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "develop");
  writeFileSync(join(origin, "a.txt"), "one\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "base");
  const work = join(root, "work");
  git(root, "clone", "-q", origin, work);
  const promptOut = join(root, "prompt.txt");
  const raw = {
    stateDir: join(root, "state"),
    pollMs: 50,
    waitMaxSeconds: 1,
    repos: { demo: { url: origin, mirror: join(root, "state", "mirrors", "demo.git") } },
    contractPaths: ["prisma/**"],
    providers: [
      { id: "claude", vendor: "anthropic", enabled: true, command: process.execPath, args: [FAKE, "accept"], passEnv: ["FAKE_REVIEWER_PROMPT_OUT"] },
      { id: "cursor", vendor: "xai", enabled: true, command: process.execPath, args: [FAKE, "accept"], passEnv: ["FAKE_REVIEWER_PROMPT_OUT"] },
    ],
  };
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(raw));
  const env = { ...process.env, REVIEW_ORCH_CONFIG: configPath, REVIEW_ORCH_LOCAL_BIN: SERVER };
  const client = (...args) => run(process.execPath, [CLIENT, ...args], { cwd: work, env });
  const commit = (file, body) => {
    mkdirSync(join(work, file, ".."), { recursive: true });
    writeFileSync(join(work, file), body);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", `change ${file}`);
    return git(work, "rev-parse", "HEAD");
  };
  return { root, work, promptOut, config: validateConfig(raw), client, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function reviewAndReadPrompt(f) {
  process.env.FAKE_REVIEWER_PROMPT_OUT = f.promptOut;
  try {
    const orchestrator = new Orchestrator(f.config);
    orchestrator.tick(allAvailable(f.config));
    await orchestrator.idle();
    return readFileSync(f.promptOut, "utf8");
  } finally {
    delete process.env.FAKE_REVIEWER_PROMPT_OUT;
  }
}

test("the reviewer is shown only focus..head; earlier rounds are named as context", async () => {
  const f = fixture();
  try {
    const round4 = f.commit("round4.md", "ROUND FOUR TEXT\n");
    f.commit("round5.md", "ROUND FIVE TEXT\n");
    const submitted = f.client("submit", "--author", "codex", "--repo", "demo", "--focus", round4);
    assert.equal(submitted.code, 3, submitted.stderr);
    const result = JSON.parse(submitted.stdout);
    assert.equal(result.focus, round4);
    assert.equal(result.fileCount, 2);
    assert.equal(result.focusFileCount, 1);
    const prompt = await reviewAndReadPrompt(f);
    assert.match(prompt, /ROUND FIVE TEXT/);
    assert.doesNotMatch(prompt, /ROUND FOUR TEXT/);
    assert.match(prompt, new RegExp(`Review the commits ${round4}\\.\\.`));
    assert.match(prompt, /- round5\.md/);
    assert.doesNotMatch(prompt, /- round4\.md/);
  } finally {
    f.cleanup();
  }
});

test("an instruction-file edit before the focus is still shown, since the checkout holds the base version", async () => {
  const f = fixture();
  try {
    f.commit("AGENTS.md", "EARLIER PLANTED RULE\n");
    const round4 = f.commit("round4.md", "four\n");
    f.commit("round5.md", "five\n");
    assert.equal(f.client("submit", "--author", "codex", "--repo", "demo", "--focus", round4).code, 3);
    const prompt = await reviewAndReadPrompt(f);
    assert.match(prompt, /EARLIER PLANTED RULE/);
    assert.match(prompt, /edits 1 of them/);
  } finally {
    f.cleanup();
  }
});

test("a contract path before the focus still raises the reviewer count", () => {
  const f = fixture();
  try {
    f.commit("prisma/migrations/1/migration.sql", "select 1;\n");
    const round4 = f.commit("round4.md", "four\n");
    f.commit("round5.md", "five\n");
    const result = JSON.parse(f.client("submit", "--author", "codex", "--repo", "demo", "--focus", round4).stdout);
    assert.equal(result.reviewers, 2);
    assert.equal(result.touchesContract, true);
  } finally {
    f.cleanup();
  }
});

test("a focus outside base..head, or at head, is refused and leaves no job", () => {
  const f = fixture();
  try {
    f.commit("a.txt", "two\n");
    const head = f.commit("b.txt", "three\n");
    // A commit not on the path: an unrelated branch off the base.
    git(f.work, "checkout", "-q", "-b", "other", "origin/develop");
    const stray = f.commit("c.txt", "stray\n");
    git(f.work, "checkout", "-q", "-");
    const outside = f.client("submit", "--author", "codex", "--repo", "demo", "--focus", stray);
    assert.equal(outside.code, 64, outside.stderr);
    assert.match(outside.stderr, /focus_not_in_range/);
    const atHead = f.client("submit", "--author", "codex", "--repo", "demo", "--focus", head);
    assert.equal(atHead.code, 64, atHead.stderr);
    assert.match(atHead.stderr, /empty_focus/);
    assert.deepEqual(new Store(f.config.stateDir).listJobs(), []);
  } finally {
    f.cleanup();
  }
});
