// The CI auto-fix's conflict resolution (owner 2026-10-27): the proposing pass
// on the review server (tools/review-orchestrator/lib/ci-fix.mjs) merges
// develop into a conflicting branch and has the model resolve the markers;
// the sender carries the resolution and the develop commit; the workflow's
// guard (lib/prCiAutoFixGuardCore.ts, scripts/pr-ci-auto-fix-guard.mjs)
// merges that commit itself and decides whether the resolution is committed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  CI_FIX_CONFLICT_COMMIT_PREFIX,
  ciFixReport,
  conflictPrompt,
  readLedger,
  runCiFix,
  settleSentFixes,
  writeDispatchRequest,
} from "../tools/review-orchestrator/lib/ci-fix.mjs";
import { validateConfig } from "../tools/review-orchestrator/lib/config.mjs";
import { dispatchInputs, normaliseDispatchRequest } from "../tools/review-orchestrator/bin/pr-ci-auto-fix-sender.mjs";
import {
  PR_CI_AUTO_FIX_CONFLICT_PREFIX,
  PR_CI_AUTO_FIX_MAX_NEW_CONFLICT_LINES,
  judgePrCiAutoFixConflict,
  judgePrCiAutoFixTarget,
} from "../lib/prCiAutoFixGuardCore.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const sh = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const pull = (number, ref, sha, extra = {}) => ({
  number, draft: false,
  base: { ref: "develop", repo: { full_name: "o/r" } },
  head: { ref, sha, repo: { full_name: "o/r" } },
  ...extra,
});

test("the guard commits a resolution that keeps everything outside the conflicts and replaces only them", () => {
  // What git left: a shared security step before, one conflict, a shared step after.
  const MERGED = "name: ci\n- run: npm audit\n<<<<<<< HEAD\nb-branch\n=======\nb-develop\n>>>>>>> dev\n- run: npm test\n";
  const file = (path, resolved, extra = {}) => ({ path, regular: true, merged: MERGED, resolved, ...extra });
  const verdict = (input) => {
    const result = judgePrCiAutoFixConflict(input);
    return result.push ? [] : result.reasons;
  };
  const one = (path, resolved, extra) => verdict({ files: [file(path, resolved, extra)], proposed: [path] });
  assert.deepEqual(judgePrCiAutoFixConflict({ files: [file("lib/x.ts", "name: ci\n- run: npm audit\nb-branch\nb-develop\n- run: npm test\n")], proposed: ["lib/x.ts"] }), { push: true });
  // Taking one side is a resolution; so is joining them in a line.
  assert.deepEqual(one(".github/workflows/ci.yml", "name: ci\n- run: npm audit\nb-develop\n- run: npm test\n"), []);
  assert.deepEqual(one("lib/x.ts", "name: ci\n- run: npm audit\nb-branch + b-develop\n- run: npm test\n"), []);

  // Outside the conflict nothing may go, move or change: dropping the shared
  // audit step adds no line, and is still refused.
  assert.deepEqual(one(".github/workflows/ci.yml", "name: ci\nb-branch\n- run: npm test\n"), ["outside_conflict_changed"]);
  assert.deepEqual(one("lib/x.ts", "name: ci\n- run: npm test\nb-branch\n- run: npm audit\n"), ["outside_conflict_changed"]);
  assert.deepEqual(one("lib/x.ts", "name: ci\n- run: npm audit\nb-branch\n- run: npm test --bail\n"), ["outside_conflict_changed"]);
  // Whitespace counts: a trailing space added or dropped outside is a change.
  assert.deepEqual(one("lib/x.ts", "name: ci \n- run: npm audit\nb-branch\n- run: npm test\n"), ["outside_conflict_changed"]);
  assert.deepEqual(one(".github/workflows/ci.yml", "name: ci\n- run: npm audit\nb-branch \n- run: npm test\n"), ["gate_path_new_line"]);

  // Inside it, a gate path takes only its sides' lines; elsewhere a few joined lines are fine.
  assert.deepEqual(one(".github/workflows/ci.yml", "name: ci\n- run: npm audit\nrun: curl evil\n- run: npm test\n"), ["gate_path_new_line"]);
  assert.deepEqual(one("package.json", "name: ci\n- run: npm audit\n\"x\": \"1\"\n- run: npm test\n"), ["gate_path_new_line"]);
  const many = Array.from({ length: PR_CI_AUTO_FIX_MAX_NEW_CONFLICT_LINES + 1 }, (_, i) => `new ${i}`).join("\n");
  assert.deepEqual(one("lib/x.ts", `name: ci\n- run: npm audit\n${many}\n- run: npm test\n`), ["too_many_new_lines"]);

  assert.deepEqual(verdict({ files: [file("lib/x.ts", "name: ci\n- run: npm audit\nb-branch\n- run: npm test\n")], proposed: ["lib/x.ts", "lib/other.ts"] }), ["not_conflicted"]);
  assert.deepEqual(one("lib/x.ts", null), ["unresolved"]);
  assert.ok(one("lib/x.ts", MERGED).includes("marker_left"));
  assert.deepEqual(one("lib/x.ts", "x\n", { merged: null }), ["deleted_side"]);
  assert.deepEqual(one("lib/x.ts", "x\n", { regular: false }), ["not_regular_file"]);
  assert.deepEqual(one("lib/x.ts", "x\n", { merged: "a\n<<<<<<< HEAD\nb\n" }), ["markers_unreadable"]);
  assert.deepEqual(verdict({ files: [], proposed: [] }), ["no_conflict"]);
});

test("two conflicts in one file are each replaced, the text between them kept", () => {
  const merged = "top\n<<<<<<< HEAD\na1\n=======\na2\n>>>>>>> dev\nmiddle\n<<<<<<< HEAD\nb1\n||||||| base\nb0\n=======\nb2\n>>>>>>> dev\nend\n";
  const judge = (resolved) => judgePrCiAutoFixConflict({ files: [{ path: "lib/x.ts", regular: true, merged, resolved }], proposed: ["lib/x.ts"] });
  assert.deepEqual(judge("top\na1\na2\nmiddle\nb0\nend\n"), { push: true }, "a diff3 base line is a side");
  assert.deepEqual(judge("top\na1\nend\n"), { push: false, reasons: ["outside_conflict_changed"] });
});

test("a conflict may be resolved on a draft, and counts its own attempts", () => {
  const target = (extra) => judgePrCiAutoFixTarget({
    headBranch: "claude/to-develop/x", baseBranch: "develop", draft: true, sameRepository: true, author: "codex",
    commitMessages: ["work"], commitCount: 1, ...extra,
  });
  assert.deepEqual(target({ kind: "conflict" }), { push: true });
  assert.deepEqual(target({}), { push: false, reasons: ["draft"] }, "a failed-CI fix still needs a ready pull request");
  const twice = [`${PR_CI_AUTO_FIX_CONFLICT_PREFIX}one`, `${PR_CI_AUTO_FIX_CONFLICT_PREFIX}two`];
  assert.deepEqual(target({ kind: "conflict", commitMessages: twice, commitCount: 2 }), { push: false, reasons: ["attempts_exhausted"] });
  assert.equal(CI_FIX_CONFLICT_COMMIT_PREFIX, PR_CI_AUTO_FIX_CONFLICT_PREFIX);
  assert.ok(read("../.github/workflows/pr-ci-auto-fix.yml").includes(`"${PR_CI_AUTO_FIX_CONFLICT_PREFIX}merge develop into #`));
});

test("a conflict request carries the develop commit and no runs, and a CI fix's inputs are unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-fix-conflict-outbox-"));
  try {
    const path = writeDispatchRequest(dir, { kind: "conflict", prNumber: 12, headSha: SHA_A, baseSha: SHA_B, runIds: [], patchGzB64: "H4sIAAAA", now: 1000 });
    const request = normaliseDispatchRequest(JSON.parse(readFileSync(path, "utf8")), `${SHA_A}.json`);
    assert.deepEqual(request, { kind: "conflict", baseSha: SHA_B, prNumber: 12, headSha: SHA_A, runIds: [], patchGzB64: "H4sIAAAA", createdAt: 1000 });
    const inputs = dispatchInputs(request);
    assert.deepEqual(inputs, { pr_number: "12", head_sha: SHA_A, run_ids: "", patch_gz_b64: "H4sIAAAA", kind: "conflict", base_sha: SHA_B });
    const workflow = read("../.github/workflows/pr-ci-auto-fix.yml");
    const declared = workflow.slice(workflow.indexOf("inputs:"), workflow.indexOf("permissions:"));
    for (const name of Object.keys(inputs)) assert.match(declared, new RegExp(`^      ${name}:$`, "m"), name);

    const base = { schemaVersion: 1, prNumber: 12, headSha: SHA_A, patchGzB64: "H4sIAAAA", createdAt: 1 };
    for (const bad of [
      { kind: "conflict", baseSha: SHA_B, runIds: [5] },
      { kind: "conflict", runIds: [] },
      { kind: "conflict", baseSha: "develop", runIds: [] },
      { kind: "ci", runIds: [] },
      { kind: "ci", baseSha: SHA_B, runIds: [5] },
      { kind: "deploy", runIds: [5] },
    ]) {
      assert.equal(normaliseDispatchRequest({ ...base, ...bad }, `${SHA_A}.json`), null, JSON.stringify(bad));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sent fix is settled from the pull request's new head: its own commit, or something else", async () => {
  const ledger = {
    [SHA_A]: { pr: 1, kind: "ci", outcome: "queued", at: 1 },
    [`${SHA_B}:conflict`]: { pr: 2, kind: "conflict", outcome: "queued", at: 2 },
    ["c".repeat(40)]: { pr: 3, kind: "ci", outcome: "queued", at: 3 },
  };
  const pulls = [pull(1, "claude/to-develop/a", "1".repeat(40)), pull(2, "claude/to-develop/b", "2".repeat(40)), pull(3, "claude/to-develop/c", "c".repeat(40))];
  const commits = {
    1: [{ sha: "1".repeat(40), parents: [{ sha: SHA_A }], commit: { message: "auto-fix(ci): PR Fast Gate failure on #1" } }],
    2: [{ sha: "2".repeat(40), parents: [{ sha: SHA_B }], commit: { message: "fix by hand" } }],
  };
  const recorded = {};
  await settleSentFixes({
    ledger, pulls,
    github: { json: async (path) => commits[Number(path.split("/")[2])] },
    record: (key, entry) => { recorded[key] = entry.outcome; },
  });
  assert.deepEqual(recorded, { [SHA_A]: "pushed", [`${SHA_B}:conflict`]: "superseded" }, "#3 has not moved: still sent");
  const report = ciFixReport({ [`${SHA_B}:conflict`]: { pr: 2, kind: "conflict", outcome: "superseded", at: 5 } }, 6000);
  assert.deepEqual(report.entries[0], { pr: 2, head: SHA_B, kind: "conflict", outcome: "superseded", reason: null, retried: false, ageSeconds: 6 });
});

/** A develop and a branch that both changed one line of app.js after they parted. */
function conflictFixture() {
  const root = mkdtempSync(join(tmpdir(), "ci-fix-conflict-"));
  const source = join(root, "source");
  mkdirSync(source);
  sh(source, "init", "-q", "-b", "develop");
  writeFileSync(join(source, "CLAUDE.md"), "develop instructions\n");
  mkdirSync(join(source, "lib"));
  writeFileSync(join(source, "lib", "app.js"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  writeFileSync(join(source, "lib", "other.js"), "export {};\n");
  sh(source, "add", "-A");
  sh(source, "commit", "-q", "-m", "base");
  sh(source, "checkout", "-q", "-b", "claude/to-develop/both");
  writeFileSync(join(source, "lib", "app.js"), "const a = 1;\nconst b = 2 + branch;\nconst c = 3;\n");
  sh(source, "commit", "-q", "-am", "branch change");
  const head = sh(source, "rev-parse", "HEAD");
  sh(source, "checkout", "-q", "develop");
  writeFileSync(join(source, "lib", "app.js"), "const a = 1;\nconst b = 2 + develop;\nconst c = 3;\n");
  sh(source, "commit", "-q", "-am", "develop change");
  const develop = sh(source, "rev-parse", "HEAD");
  const config = validateConfig({
    stateDir: join(root, "state"),
    repos: { tomverse: { url: source, mirror: join(root, "state", "mirrors", "tomverse.git") } },
    providers: [{ id: "claude", vendor: "anthropic", enabled: true, command: "claude", args: [], timeoutSeconds: 60 }],
  });
  const github = {
    async json(path) {
      if (path.startsWith("/pulls?")) return [pull(51, "claude/to-develop/both", head, { draft: true })];
      if (path === "/pulls/51") return { number: 51, mergeable: false };
      if (path.startsWith("/pulls/51/commits")) return [{ sha: head, commit: { message: "branch change" } }];
      if (path.startsWith("/actions/runs?head_sha=")) return { workflow_runs: [] };
      throw new Error(`unexpected ${path}`);
    },
  };
  return { root, source, config, outbox: join(root, "outbox"), workDir: join(root, "work"), head, develop, github };
}

const pass = (f, claude, extra = {}) => runCiFix({
  ...f, model: "sonnet", minRemainingPercent: 0, quota: async () => ({ state: "available", remainingPercent: 90 }),
  claude, clock: () => 7000, log: () => {}, conflicts: true, ...extra,
});

test("a conflicting draft is merged with develop, resolved by the model, and the guard commits that resolution", async () => {
  const f = conflictFixture();
  try {
    const seen = [];
    const claude = ({ cwd, prompt }) => {
      seen.push({ prompt, app: readFileSync(join(cwd, "lib", "app.js"), "utf8"), instructions: readFileSync(join(cwd, "CLAUDE.md"), "utf8") });
      writeFileSync(join(cwd, "lib", "app.js"), "const a = 1;\nconst b = 2 + branch + develop;\nconst c = 3;\n");
      return { ok: true, timedOut: false, tail: "Joined both additions.\nRESULT: fixed" };
    };
    assert.equal((await pass(f, claude, { conflicts: false })).outcome, "nothing_to_fix", "off unless switched on");
    const result = await pass(f, claude);
    assert.deepEqual(result, { outcome: "queued", pr: 51 });
    assert.equal(seen.length, 1);
    assert.match(seen[0].app, /^<<<<<<< /m, "the model sees develop merged in, stopped on the conflict");
    assert.match(seen[0].prompt, /- lib\/app\.js/);
    assert.equal(seen[0].instructions, "develop instructions\n");
    assert.equal(seen[0].prompt, conflictPrompt({ files: ["lib/app.js"] }));

    const entry = readLedger(join(f.config.stateDir, "ci-fix", "ledger.json"))[`${f.head}:conflict`];
    assert.deepEqual({ kind: entry.kind, outcome: entry.outcome, reason: entry.reason }, { kind: "conflict", outcome: "queued", reason: "fixed" });

    const request = normaliseDispatchRequest(JSON.parse(readFileSync(join(f.outbox, `${f.head}.json`), "utf8")), `${f.head}.json`);
    assert.equal(request.kind, "conflict");
    assert.equal(request.baseSha, f.develop);
    const resolution = JSON.parse(gunzipSync(Buffer.from(request.patchGzB64, "base64")).toString("utf8"));
    assert.deepEqual(Object.keys(resolution.files), ["lib/app.js"], "only the conflicted file leaves");

    // What the workflow does with it: a clean checkout at the head, develop's
    // commit merged there, and the trusted guard judging and writing it.
    const checkout = join(f.root, "pr");
    sh(f.root, "clone", "-q", "-c", "core.autocrlf=false", f.source, checkout);
    sh(checkout, "checkout", "-q", "--detach", f.head);
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-commit", "--no-ff", request.baseSha], { cwd: checkout });
    const resolutionPath = join(f.root, "resolution.json");
    writeFileSync(resolutionPath, JSON.stringify(resolution));
    const guard = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/pr-ci-auto-fix-guard.mjs", "conflict", checkout, resolutionPath, "claude/to-develop/both"], { encoding: "utf8" });
    assert.equal(guard.status, 0, guard.stdout + guard.stderr);
    assert.equal(sh(checkout, "diff", "--name-only", "--diff-filter=U"), "", "nothing left unmerged");
    assert.equal(readFileSync(join(checkout, "lib", "app.js"), "utf8"), "const a = 1;\nconst b = 2 + branch + develop;\nconst c = 3;\n");

    // A resolution that names another file is not written.
    const forged = join(f.root, "forged.json");
    writeFileSync(forged, JSON.stringify({ files: { ...resolution.files, "lib/other.js": Buffer.from("evil\n").toString("base64") } }));
    const again = join(f.root, "pr2");
    sh(f.root, "clone", "-q", "-c", "core.autocrlf=false", f.source, again);
    sh(again, "checkout", "-q", "--detach", f.head);
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-commit", "--no-ff", request.baseSha], { cwd: again });
    const refused = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/pr-ci-auto-fix-guard.mjs", "conflict", again, forged], { encoding: "utf8" });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /not_conflicted/);
    // (A Windows clone may check it out with CRLF.)
    assert.equal(readFileSync(join(again, "lib", "other.js"), "utf8").replace(/\r\n/g, "\n"), "export {};\n");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("one head carries one request: a conflict waits while a CI fix for that head is under way or sent", async () => {
  const f = conflictFixture();
  try {
    const ledgerPath = join(f.config.stateDir, "ci-fix", "ledger.json");
    mkdirSync(join(f.config.stateDir, "ci-fix"), { recursive: true });
    for (const outcome of ["started", "queued"]) {
      writeFileSync(ledgerPath, JSON.stringify({ [f.head]: { pr: 51, kind: "ci", outcome, at: 6000 } }));
      assert.equal((await pass(f, () => assert.fail("the conflict must wait"))).outcome, "nothing_to_fix", outcome);
    }
    // A CI try that ended without a request leaves the head to the conflict.
    writeFileSync(ledgerPath, JSON.stringify({ [f.head]: { pr: 51, kind: "ci", outcome: "no_change", at: 6000 } }));
    const result = await pass(f, () => ({ ok: true, timedOut: false, tail: "RESULT: not_found" }));
    assert.equal(result.outcome, "no_change");
    assert.equal(readLedger(ledgerPath)[`${f.head}:conflict`].kind, "conflict");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a resolution that leaves a marker is recorded and not sent", async () => {
  const f = conflictFixture();
  try {
    const result = await pass(f, () => ({ ok: true, timedOut: false, tail: "RESULT: not_found" }));
    assert.equal(result.outcome, "no_change");
    const entry = readLedger(join(f.config.stateDir, "ci-fix", "ledger.json"))[`${f.head}:conflict`];
    assert.deepEqual({ outcome: entry.outcome, reason: entry.reason }, { outcome: "no_change", reason: "not_found" });
    assert.equal((await pass(f, () => assert.fail("one try per head"))).outcome, "nothing_to_fix");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the guard writes through no link: a conflicted path that is one is refused", { skip: process.platform === "win32" }, () => {
  const f = conflictFixture();
  try {
    const checkout = join(f.root, "pr");
    sh(f.root, "clone", "-q", "-c", "core.autocrlf=false", f.source, checkout);
    sh(checkout, "checkout", "-q", "--detach", f.head);
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-commit", "--no-ff", f.develop], { cwd: checkout });
    const outside = join(f.root, "outside.txt");
    writeFileSync(outside, "keep me\n");
    rmSync(join(checkout, "lib", "app.js"));
    symlinkSync(outside, join(checkout, "lib", "app.js"));
    const resolutionPath = join(f.root, "resolution.json");
    writeFileSync(resolutionPath, JSON.stringify({ files: { "lib/app.js": Buffer.from("owned\n").toString("base64") } }));
    const guard = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/pr-ci-auto-fix-guard.mjs", "conflict", checkout, resolutionPath], { encoding: "utf8" });
    assert.equal(guard.status, 1);
    assert.match(guard.stdout, /not_regular_file/);
    assert.equal(readFileSync(outside, "utf8"), "keep me\n");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
