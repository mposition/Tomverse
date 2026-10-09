// A reviewer CLI that will not read stdin gets the prompt as a file. Tested
// through the real spawn path: on 2026-10-02 Devin passed a shell-pipe check
// and then failed every review, because a spawned child's stdin is a socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function fixture(provider) {
  const root = mkdtempSync(join(tmpdir(), "review-orch-promptfile-"));
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
    providers: [{ id: "devin", vendor: "cognition", enabled: true, command: process.execPath, ...provider }],
  };
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(raw));
  const env = { ...process.env, REVIEW_ORCH_CONFIG: configPath, REVIEW_ORCH_LOCAL_BIN: SERVER };
  const client = (...args) => run(process.execPath, [CLIENT, ...args], { cwd: work, env });
  writeFileSync(join(work, "a.txt"), "two\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "change");
  return { root, config: validateConfig(raw), client, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("{promptFile} hands the prompt (note first) as an owner-only file and removes it afterwards", async () => {
  const f = fixture({
    args: [FAKE, "promptfile", "{promptFile}"],
    passEnv: ["FAKE_REVIEWER_PROMPT_OUT", "FAKE_REVIEWER_STAT_OUT"],
    promptNote: "TOOL RULE NOTE",
  });
  const promptOut = join(f.root, "prompt.txt");
  const statOut = join(f.root, "mode.txt");
  process.env.FAKE_REVIEWER_PROMPT_OUT = promptOut;
  process.env.FAKE_REVIEWER_STAT_OUT = statOut;
  try {
    const { jobId } = JSON.parse(f.client("submit", "--author", "claude", "--repo", "demo").stdout);
    const orchestrator = new Orchestrator(f.config);
    orchestrator.tick(allAvailable(f.config));
    await orchestrator.idle();
    const slot = new Store(f.config.stateDir).readSlot(jobId, 0);
    assert.equal(slot.verdict, "accept", JSON.stringify(slot));
    const prompt = readFileSync(promptOut, "utf8");
    assert.ok(prompt.startsWith("TOOL RULE NOTE\n\n"), prompt.slice(0, 60));
    assert.match(prompt, /independent code reviewer/);
    if (process.platform !== "win32") assert.equal(readFileSync(statOut, "utf8"), String(0o600));
    // Nothing is left behind in the prompts directory.
    assert.deepEqual(readdirSync(join(f.config.stateDir, "prompts")), []);
  } finally {
    delete process.env.FAKE_REVIEWER_PROMPT_OUT;
    delete process.env.FAKE_REVIEWER_STAT_OUT;
    f.cleanup();
  }
});

test("{promptDir} names a directory of the job's own holding prompt.md, for a CLI given only a short -p", async () => {
  const f = fixture({ args: [FAKE, "promptfile", "{promptDir}/prompt.md"], passEnv: ["FAKE_REVIEWER_PROMPT_OUT"] });
  const promptOut = join(f.root, "prompt.txt");
  process.env.FAKE_REVIEWER_PROMPT_OUT = promptOut;
  try {
    const { jobId } = JSON.parse(f.client("submit", "--author", "claude", "--repo", "demo").stdout);
    const orchestrator = new Orchestrator(f.config);
    orchestrator.tick(allAvailable(f.config));
    await orchestrator.idle();
    assert.equal(new Store(f.config.stateDir).readSlot(jobId, 0).verdict, "accept");
    assert.match(readFileSync(promptOut, "utf8"), /independent code reviewer/);
    assert.deepEqual(readdirSync(join(f.config.stateDir, "prompts")), []);
  } finally {
    delete process.env.FAKE_REVIEWER_PROMPT_OUT;
    f.cleanup();
  }
});

test("without {promptFile} the prompt still goes on stdin, with the note first", async () => {
  const f = fixture({ args: [FAKE, "accept"], passEnv: ["FAKE_REVIEWER_PROMPT_OUT"], promptNote: "STDIN NOTE" });
  const promptOut = join(f.root, "prompt.txt");
  process.env.FAKE_REVIEWER_PROMPT_OUT = promptOut;
  try {
    const { jobId } = JSON.parse(f.client("submit", "--author", "claude", "--repo", "demo").stdout);
    const orchestrator = new Orchestrator(f.config);
    orchestrator.tick(allAvailable(f.config));
    await orchestrator.idle();
    assert.equal(new Store(f.config.stateDir).readSlot(jobId, 0).verdict, "accept");
    assert.ok(readFileSync(promptOut, "utf8").startsWith("STDIN NOTE\n\n"));
    assert.equal(existsSync(join(f.config.stateDir, "prompts")), false);
  } finally {
    delete process.env.FAKE_REVIEWER_PROMPT_OUT;
    f.cleanup();
  }
});

test("a promptNote that is not a short string fails config validation", () => {
  const base = { stateDir: "/x", repos: { demo: { url: "u", mirror: "m" } } };
  const provider = { id: "devin", vendor: "cognition", enabled: true, command: "devin", args: [] };
  assert.throws(() => validateConfig({ ...base, providers: [{ ...provider, promptNote: 42 }] }), /promptNote/);
  assert.throws(() => validateConfig({ ...base, providers: [{ ...provider, promptNote: "x".repeat(4001) }] }), /promptNote/);
});
