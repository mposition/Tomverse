// The CI auto-fix's conflict resolution (owner 2026-10-27): the proposing pass
// on the review server (tools/review-orchestrator/lib/ci-fix.mjs) merges the
// pull request's base into a conflicting branch and has the model resolve the
// markers; the sender carries the resolution and the base commit; the workflow's
// guard (lib/prCiAutoFixGuardCore.ts, scripts/pr-ci-auto-fix-guard.mjs)
// merges that commit itself and decides whether the resolution is committed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  CI_FIX_CONFLICT_COMMIT_PREFIX,
  CI_FIX_PUBLISH_WAIT_MS,
  ciFixReport,
  conflictHunks,
  conflictPrompt,
  readLedger,
  runCiFix,
  settleSentFixes,
  writeDispatchRequest,
} from "../tools/review-orchestrator/lib/ci-fix.mjs";
import { validateConfig } from "../tools/review-orchestrator/lib/config.mjs";
import { createDispatchSender, dispatchInputs, normaliseDispatchRequest } from "../tools/review-orchestrator/bin/pr-ci-auto-fix-sender.mjs";
import {
  PR_CI_AUTO_FIX_CONFLICT_PREFIX,
  judgePrCiAutoFixConflict,
  judgePrCiAutoFixTarget,
  rebuildConflictResolution,
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

  // Inside it any file may take as many new lines as it needs, workflows too (owner 2026-11-03).
  const many = Array.from({ length: 200 }, (_, i) => `new ${i}`).join("\n");
  for (const path of ["package.json", "lib/adminAuth.ts", "lib/agentAuthorityFiles.ts", "scripts/x.mjs", "AGENTS.md", "lib/x.ts",
    ".github/workflows/ci.yml", ".github/actions/a/action.yml"]) {
    assert.deepEqual(one(path, `name: ci\n- run: npm audit\n${many}\n- run: npm test\n`), [], path);
  }

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

test("a conflict is served into any base, and its commit names the base it merged", () => {
  assert.deepEqual(judgePrCiAutoFixTarget({ headBranch: "claude/to-develop/x", baseBranch: "main", sameRepository: true }), { push: true });
  assert.equal(CI_FIX_CONFLICT_COMMIT_PREFIX, PR_CI_AUTO_FIX_CONFLICT_PREFIX);
  assert.ok(read("../.github/workflows/pr-ci-auto-fix.yml").includes(`"${PR_CI_AUTO_FIX_CONFLICT_PREFIX}merge \${BASE_BRANCH} into #`));
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
  const settle = (now) => settleSentFixes({
    ledger, pulls, now,
    github: { json: async (path) => commits[Number(path.split("/")[2])] },
    record: (key, entry) => { recorded[key] = entry; },
  });
  await settle(3 + 60_000);
  assert.deepEqual(
    Object.fromEntries(Object.entries(recorded).map(([key, entry]) => [key, entry.outcome])),
    { [SHA_A]: "pushed", [`${SHA_B}:conflict`]: "superseded" },
    "#3 has not moved: still sent",
  );
  assert.equal(recorded[SHA_A].settledHead, "1".repeat(40));
  // Unmoved two hours after it was queued: the workflow refused it or the push failed.
  await settle(3 + CI_FIX_PUBLISH_WAIT_MS + 1);
  assert.equal(recorded["c".repeat(40)].outcome, "not_published");

  const report = ciFixReport({
    [`${SHA_B}:conflict`]: { pr: 2, kind: "conflict", outcome: "superseded", settledHead: "2".repeat(40), at: 5 },
    [SHA_A]: { pr: 1, kind: "ci", outcome: "pushed", settledHead: "1".repeat(40), at: 4 },
  }, 6000);
  assert.deepEqual(report.entries[0], { pr: 2, head: SHA_B, kind: "conflict", outcome: "superseded", reason: null, retried: false, settled: null, ageSeconds: 6 });
  assert.equal(report.entries[1].settled, "1".repeat(40), "only a pushed fix carries the head it became");
});

/** A base branch (develop unless named) and a branch that both changed one line of app.js after they parted. */
function conflictFixture({ base = "develop", baseAdds = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ci-fix-conflict-"));
  const source = join(root, "source");
  mkdirSync(source);
  sh(source, "init", "-q", "-b", base);
  writeFileSync(join(source, "CLAUDE.md"), `${base} instructions\n`);
  mkdirSync(join(source, "lib"));
  writeFileSync(join(source, "lib", "app.js"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  writeFileSync(join(source, "lib", "other.js"), "export {};\n");
  sh(source, "add", "-A");
  sh(source, "commit", "-q", "-m", "base");
  // The model's instruction files always come from develop, whatever the base.
  if (base !== "develop") {
    sh(source, "checkout", "-q", "-b", "develop");
    writeFileSync(join(source, "CLAUDE.md"), "develop instructions\n");
    sh(source, "commit", "-q", "-am", "develop instructions");
    sh(source, "checkout", "-q", base);
  }
  sh(source, "checkout", "-q", "-b", "claude/to-develop/both");
  writeFileSync(join(source, "lib", "app.js"), "const a = 1;\nconst b = 2 + branch;\nconst c = 3;\n");
  sh(source, "commit", "-q", "-am", "branch change");
  const head = sh(source, "rev-parse", "HEAD");
  sh(source, "checkout", "-q", base);
  writeFileSync(join(source, "lib", "app.js"), "const a = 1;\nconst b = 2 + develop;\nconst c = 3;\n");
  for (const [path, text] of Object.entries(baseAdds)) {
    mkdirSync(join(source, path, ".."), { recursive: true });
    writeFileSync(join(source, path), text);
  }
  sh(source, "add", "-A");
  sh(source, "commit", "-q", "-m", "develop change");
  const develop = sh(source, "rev-parse", "HEAD");
  const config = validateConfig({
    stateDir: join(root, "state"),
    repos: { tomverse: { url: source, mirror: join(root, "state", "mirrors", "tomverse.git") } },
    providers: [{ id: "claude", vendor: "anthropic", enabled: true, command: "claude", args: [], timeoutSeconds: 60 }],
  });
  const github = {
    async json(path) {
      if (path.startsWith("/pulls?")) return [pull(51, "claude/to-develop/both", head, { draft: true, base: { ref: base, repo: { full_name: "o/r" } } })];
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
  // The server's worktree as on its Linux host: a Windows git converting to
  // CRLF would leave a merge the workflow's checkout does not reproduce.
  const env = { GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 };
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false" });
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
    assert.deepEqual(resolution.files["lib/app.js"].hunks, [["const b = 2 + branch + develop;"]], "only the lines that replace its conflict");
    assert.match(resolution.files["lib/app.js"].merged, /^[0-9a-f]{64}$/);

    // What the workflow does with it: a clean checkout at the head, develop's
    // commit merged there, and the trusted guard judging and writing it.
    const checkout = join(f.root, "pr");
    sh(f.root, "clone", "-q", "-c", "core.autocrlf=false", f.source, checkout);
    sh(checkout, "checkout", "-q", "--detach", f.head);
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-commit", "--no-ff", request.baseSha], { cwd: checkout });
    const resolutionPath = join(f.root, "resolution.json");
    writeFileSync(resolutionPath, JSON.stringify(resolution));
    const guard = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/pr-ci-auto-fix-guard.mjs", "conflict", checkout, resolutionPath], { encoding: "utf8" });
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
    // Lines made against another merge of the file are not put back into this one.
    const tampered = join(f.root, "tampered.json");
    writeFileSync(tampered, JSON.stringify({ files: { "lib/app.js": { ...resolution.files["lib/app.js"], merged: "0".repeat(64) } } }));
    const stale = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/pr-ci-auto-fix-guard.mjs", "conflict", again, tampered], { encoding: "utf8" });
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /unresolved/);
    // (A Windows clone may check it out with CRLF.)
    assert.equal(readFileSync(join(again, "lib", "other.js"), "utf8").replace(/\r\n/g, "\n"), "export {};\n");
  } finally {
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a resolution leaves as the lines for each conflict, which rebuild the file only where git left it the same", () => {
  const merged = [
    "{", '  "a": 1,', "<<<<<<< HEAD", '  "b": 2,', "=======", '  "b": 3,', ">>>>>>> dev",
    '  "c": 4,', "<<<<<<< HEAD", '  "d": 5', "=======", '  "d": 6', ">>>>>>> dev", "}", "",
  ].join("\n");
  const resolved = ["{", '  "a": 1,', '  "b": 3,', '  "c": 4,', '  "d": 5,', '  "e": 7', "}", ""].join("\n");
  const hunks = conflictHunks(merged, resolved);
  assert.deepEqual(hunks, [['  "b": 3,'], ['  "d": 5,', '  "e": 7']]);
  assert.equal(rebuildConflictResolution(merged, hunks), resolved, "the workflow rebuilds exactly what the model wrote");
  // A lockfile: megabytes outside the conflict, one line inside it.
  const big = Array.from({ length: 200_000 }, (_, i) => `  "pkg-${i}": "${i}.0.${i % 7}",`);
  const lock = ["{", ...big, "<<<<<<< HEAD", '  "x": "1"', "=======", '  "x": "2"', ">>>>>>> dev", "}", ""].join("\n");
  const lockResolved = ["{", ...big, '  "x": "2"', "}", ""].join("\n");
  assert.deepEqual(conflictHunks(lock, lockResolved), [['  "x": "2"']]);
  assert.equal(rebuildConflictResolution(lock, [['  "x": "2"']]), lockResolved);
  // And with the long text after the conflict, past the argument limit of a spread call.
  const tailLock = ["{", "<<<<<<< HEAD", '  "x": "1"', "=======", '  "x": "2"', ">>>>>>> dev", ...big, "}", ""].join("\n");
  const tailResolved = ["{", '  "x": "2"', ...big, "}", ""].join("\n");
  assert.deepEqual(conflictHunks(tailLock, tailResolved), [['  "x": "2"']]);
  assert.equal(rebuildConflictResolution(tailLock, [['  "x": "2"']]), tailResolved);
  // Not found when the text outside the conflicts changed, or the markers do not parse.
  assert.equal(conflictHunks(merged, resolved.replace('"a": 1', '"a": 9')), null);
  assert.equal(conflictHunks(merged, resolved.replace('"c": 4', '"c": 0')), null);
  assert.equal(conflictHunks("no markers\n", "no markers\n"), null);
  // And not rebuilt from the wrong number of conflicts, or lines that are not strings.
  assert.equal(rebuildConflictResolution(merged, [['  "b": 3,']]), null);
  assert.equal(rebuildConflictResolution(merged, [['  "b": 3,'], [5]]), null);
  assert.equal(rebuildConflictResolution(merged, "x"), null);
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

test("the real sender sends a head's first request and, when it was not published, the operator's retry", async () => {
  const f = conflictFixture();
  const stateDir = mkdtempSync(join(tmpdir(), "ci-fix-sender-state-"));
  try {
    let clock = 10 * 3_600_000;
    let labels = [];
    let labelledAt = null;
    const github = {
      async json(path) {
        if (path.startsWith("/pulls?")) return [pull(51, "claude/to-develop/both", f.head, { draft: true, labels })];
        if (path.startsWith("/issues/51/events")) {
          return labelledAt === null ? [] : [{ event: "labeled", label: { name: "ci:fix-again" }, created_at: new Date(labelledAt).toISOString() }];
        }
        return f.github.json(path);
      },
    };
    const resolve = ({ cwd }) => {
      writeFileSync(join(cwd, "lib", "app.js"), "const a = 1;\nconst b = 2 + branch + develop;\nconst c = 3;\n");
      return { ok: true, timedOut: false, tail: "RESULT: fixed" };
    };
    const proposerPass = () => pass(f, resolve, { github, clock: () => clock });
    const posts = [];
    const sender = createDispatchSender({
      settings: { token: "t".repeat(40), repo: "o/r", outbox: f.outbox, stateDir },
      log: () => {},
      now: () => clock,
      fetchImpl: async (url, init) => {
        posts.push(JSON.parse(init.body).inputs);
        return { status: 204, body: null };
      },
    });

    assert.equal((await proposerPass()).outcome, "queued");
    await sender.scanOnce();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].kind, "conflict");

    // The workflow refused it: two hours on, the head has not moved.
    clock += CI_FIX_PUBLISH_WAIT_MS + 60_000;
    assert.equal((await proposerPass()).outcome, "nothing_to_fix", "no second try without the operator");
    const ledger = readLedger(join(f.config.stateDir, "ci-fix", "ledger.json"));
    assert.equal(ledger[`${f.head}:conflict`].outcome, "not_published");

    // "Analyse again": the same head, a new request, and the sender sends it.
    labels = [{ name: "ci:fix-again" }];
    labelledAt = clock;
    clock += 60_000;
    assert.equal((await proposerPass()).outcome, "queued");
    await sender.scanOnce();
    assert.equal(posts.length, 2, "a new request for the same head is sent");
    await sender.scanOnce();
    assert.equal(posts.length, 2, "and only once");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("every request the sender accepts keeps its key through the sent ledger", async () => {
  const base = { schemaVersion: 1, prNumber: 9, headSha: SHA_A, runIds: [1], patchGzB64: "QUJD" };
  for (const createdAt of [1.5, -1, Number.MAX_SAFE_INTEGER + 2, 1e21]) {
    assert.equal(normaliseDispatchRequest({ ...base, createdAt }, `${SHA_A}.json`), null, String(createdAt));
  }
  // A forged fractional time was the way around the once-per-request record.
  const outbox = mkdtempSync(join(tmpdir(), "ci-fix-key-outbox-"));
  const stateDir = mkdtempSync(join(tmpdir(), "ci-fix-key-state-"));
  try {
    const now = 10 * 3_600_000;
    let posts = 0;
    const sender = createDispatchSender({
      settings: { token: "t".repeat(40), repo: "o/r", outbox, stateDir },
      log: () => {},
      now: () => now,
      fetchImpl: async () => {
        posts += 1;
        return { status: 204, body: null };
      },
    });
    writeFileSync(join(outbox, `${SHA_A}.json`), JSON.stringify({ ...base, createdAt: now - 1000.5 }));
    await sender.scanOnce();
    await sender.scanOnce();
    assert.equal(posts, 0);
    writeFileSync(join(outbox, `${SHA_A}.json`), JSON.stringify({ ...base, createdAt: now - 1000 }));
    for (let i = 0; i < 3; i += 1) await sender.scanOnce();
    assert.equal(posts, 1, "sent once, and the record read back keeps it so");
  } finally {
    rmSync(outbox, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the sender sends each request once, honours an older sender's record, and caps a head", async () => {
  const outbox = mkdtempSync(join(tmpdir(), "ci-fix-cap-outbox-"));
  const stateDir = mkdtempSync(join(tmpdir(), "ci-fix-cap-state-"));
  try {
    const now = 10 * 3_600_000;
    let posts = 0;
    const sender = () => createDispatchSender({
      settings: { token: "t".repeat(40), repo: "o/r", outbox, stateDir },
      log: () => {},
      now: () => now,
      fetchImpl: async () => {
        posts += 1;
        return { status: 204, body: null };
      },
    });
    const request = (createdAt) => writeDispatchRequest(outbox, { prNumber: 9, headSha: SHA_A, runIds: [1], patchGzB64: "QUJD", now: createdAt });
    // An older sender recorded the head itself when it sent a request made before then.
    writeFileSync(join(stateDir, "sent.json"), JSON.stringify({ [SHA_A]: now - 5000 }));
    request(now - 6000);
    await sender().scanOnce();
    assert.equal(posts, 0, "that request was sent already");
    for (const createdAt of [now - 4000, now - 3000, now - 2000, now - 1000]) {
      request(createdAt);
      await sender().scanOnce();
    }
    assert.equal(posts, 3, "with the older record, four requests in all for the head");
  } finally {
    rmSync(outbox, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
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

test("a pull request into main is merged with main, against develop's instruction files", async () => {
  // Review r-20261103-035414-7e52e9: a settings file only the base has must not survive the merge.
  const f = conflictFixture({ base: "main", baseAdds: { ".claude/settings.local.json": "{\"hooks\":{}}\n", "AGENTS.md": "base instructions\n" } });
  const env = { GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 };
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false" });
  try {
    const seen = [];
    const result = await pass(f, ({ cwd, prompt }) => {
      seen.push({ prompt, instructions: readFileSync(join(cwd, "CLAUDE.md"), "utf8"),
        settings: existsSync(join(cwd, ".claude", "settings.local.json")), agents: existsSync(join(cwd, "AGENTS.md")) });
      writeFileSync(join(cwd, "lib", "app.js"), "const a = 1;\nconst b = 2 + branch + develop;\nconst c = 3;\n");
      return { ok: true, timedOut: false, tail: "RESULT: fixed" };
    });
    assert.deepEqual(result, { outcome: "queued", pr: 51 });
    assert.equal(seen[0].instructions, "develop instructions\n", "the base merges; only develop instructs");
    assert.equal(seen[0].settings, false, "the base's own settings file is gone before the model starts");
    assert.equal(seen[0].agents, false, "and so is an instruction file only the base has");
    assert.equal(seen[0].prompt, conflictPrompt({ files: ["lib/app.js"], base: "main" }));
    assert.match(seen[0].prompt, /with main merged in/);
    const request = normaliseDispatchRequest(JSON.parse(readFileSync(join(f.outbox, `${f.head}.json`), "utf8")), `${f.head}.json`);
    assert.equal(request.baseSha, f.develop, "main's tip is the commit to merge");
  } finally {
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(f.root, { recursive: true, force: true });
  }
});
