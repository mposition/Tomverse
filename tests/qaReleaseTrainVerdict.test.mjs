import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { QA_RELEASE_TRAIN_VERDICT_ASKS_PER_ROUND, createQaReleaseTrainVerdictGit, runQaReleaseTrainVerdictRound } from "../lib/qaReleaseTrainVerdict.ts";

const MAIN = "a".repeat(40);
const NOW = Date.parse("2026-10-29T03:00:00Z");
const candidate = (number) => ({ number, title: `#${number}`, mergeCommitSha: String(number % 10).repeat(40), mergedAt: new Date(NOW - number * 60_000).toISOString(), mainPullRequest: null });
const differs = {
  changed: [
    {
      path: "x.ts",
      post: "b".repeat(40),
      main: null,
      develop: "b".repeat(40),
      binary: false,
      diff: ["--- /dev/null", "+++ b/x.ts", "@@ -0,0 +1 @@", "+export const x = 1;", ""].join("\n"),
      mainText: null,
      developText: "export const x = 1;\n",
    },
  ],
};
const onMain = { changed: [{ path: "y.ts", post: "c".repeat(40), main: "c".repeat(40), develop: "c".repeat(40), binary: false }] };

const ports = ({ candidates, stored = null, head = MAIN, read = () => differs, ask } = {}) => {
  const calls = { prepare: 0, asks: [], saved: null };
  return {
    calls,
    ports: {
      app: {
        queue: async () => ({ candidates, stored }),
        save: async (verdicts) => {
          calls.saved = verdicts;
        },
      },
      git: {
        mainHead: async () => head,
        prepare: async () => {
          calls.prepare += 1;
          return head;
        },
        analyse: async (c) => read(c),
        mainPullsTouching: async () => [2856],
      },
      github: { pull: async (number) => ({ title: `title ${number}`, body: `body ${number}` }) },
      ...(ask
        ? {
            ask: async (question) => {
              calls.asks.push(question);
              return ask(question);
            },
          }
        : {}),
    },
  };
};
const options = { deadlineMs: NOW + 20 * 60_000, now: () => NOW };

test("nothing to check, or nothing new since the last check, clones nothing", async () => {
  const none = ports({ candidates: [] });
  assert.deepEqual(await runQaReleaseTrainVerdictRound(none.ports, options), { verdict: "none" });
  const stored = { mainSha: MAIN, at: "x", verdicts: [{ number: 1, content: { state: "on_main", lines: 1 }, mainSha: MAIN }] };
  const same = ports({ candidates: [candidate(1)], stored });
  assert.deepEqual(await runQaReleaseTrainVerdictRound(same.ports, options), { verdict: "unchanged" });
  assert.equal(same.calls.prepare, 0);
});

test("a round due for one new candidate checks only it, keeping the others' verdicts as they are", async () => {
  const stored = { mainSha: MAIN, at: "x", verdicts: [{ number: 1, content: { state: "on_main", lines: 1 }, mainSha: MAIN, checkedAt: "2026-10-29T00:00:00.000Z" }] };
  const read = [];
  const run = ports({ candidates: [candidate(1), candidate(2)], stored, read: (c) => (read.push(c.number), onMain) });
  await runQaReleaseTrainVerdictRound(run.ports, options);
  assert.deepEqual(read, [2]);
  assert.deepEqual(run.calls.saved.verdicts.find((v) => v.number === 1), stored.verdicts[0]);
});

test("a candidate the deadline skipped keeps its old verdict and is checked again next round; an unread one after an hour", async () => {
  const old = "f".repeat(40);
  const stored = { mainSha: old, at: "x", verdicts: [1, 2].map((number) => ({ number, content: { state: "on_main", lines: 1 }, mainSha: old })) };
  let clock = NOW;
  // The first candidate's check runs the clock past the deadline.
  const run = ports({ candidates: [candidate(1), candidate(2)], stored, read: () => ((clock = NOW + 30 * 60_000), onMain) });
  await runQaReleaseTrainVerdictRound(run.ports, { deadlineMs: NOW + 20 * 60_000, now: () => clock });
  const saved = new Map(run.calls.saved.verdicts.map((v) => [v.number, v]));
  assert.equal(saved.get(1).mainSha, MAIN);
  assert.equal(saved.get(2).mainSha, old);
  const next = ports({ candidates: [candidate(1), candidate(2)], stored: run.calls.saved, read: () => onMain });
  assert.equal((await runQaReleaseTrainVerdictRound(next.ports, options)).verdict, "saved");

  const unread = { mainSha: MAIN, at: "x", verdicts: [{ number: 1, content: { state: "unread" }, mainSha: MAIN, checkedAt: new Date(NOW).toISOString() }] };
  const soon = ports({ candidates: [candidate(1)], stored: unread });
  assert.deepEqual(await runQaReleaseTrainVerdictRound(soon.ports, { ...options, now: () => NOW + 30 * 60_000 }), { verdict: "unchanged" });
  const later = ports({ candidates: [candidate(1)], stored: unread, read: () => onMain });
  assert.equal((await runQaReleaseTrainVerdictRound(later.ports, { deadlineMs: NOW + 3 * 60 * 60_000, now: () => NOW + 61 * 60_000 })).onMain, 1);
});

test("a clone that fails leaves nothing behind and removes only the port's own directory", async () => {
  const neighbour = mkdtempSync(join(tmpdir(), "train-verdict-neighbour-"));
  const port = createQaReleaseTrainVerdictGit({ remote: join(neighbour, "no-such-repository") });
  try {
    await assert.rejects(port.prepare(), /git_clone/);
    await port.cleanup();
    assert.ok(existsSync(neighbour));
  } finally {
    rmSync(neighbour, { recursive: true, force: true });
  }
});

test("a moved main checks every candidate, asks the model about each difference, at most the round's limit", async () => {
  const limit = QA_RELEASE_TRAIN_VERDICT_ASKS_PER_ROUND;
  // One difference more than a round may ask about, and one candidate on main.
  const numbers = Array.from({ length: limit + 2 }, (_, i) => i + 1);
  const waiting = limit + 1;
  const already = limit + 2;
  const read = (c) => (c.number === already ? onMain : differs);
  const run = ports({
    candidates: numbers.map(candidate),
    stored: { mainSha: "f".repeat(40), at: "x", verdicts: [] },
    read,
    ask: (question) => ({ decision: "not_needed", why: { ko: "가", en: "a" }, evidence: [question.mainPulls[0].number] }),
  });
  const outcome = await runQaReleaseTrainVerdictRound(run.ports, options);
  assert.deepEqual(outcome, { verdict: "saved", checked: limit + 2, onMain: 1, differs: limit + 1, asked: limit });
  // Newest first; the model saw the description and the main pull request near the difference.
  assert.deepEqual(run.calls.asks.map((q) => q.number), numbers.slice(0, limit));
  assert.equal(run.calls.asks[0].body, "body 1");
  assert.deepEqual(run.calls.asks[0].mainPulls, [{ number: 2856, title: "title 2856", body: "body 2856" }]);
  const saved = new Map(run.calls.saved.verdicts.map((v) => [v.number, v]));
  assert.equal(saved.get(already).content.state, "on_main");
  assert.equal(saved.get(1).model.decision, "not_needed");
  // The difference past the limit waits for the next round, which is due because of it.
  assert.equal(saved.get(waiting).model, undefined);
  const next = ports({ candidates: numbers.map(candidate), stored: run.calls.saved, read, ask: () => null });
  const again = await runQaReleaseTrainVerdictRound(next.ports, options);
  assert.equal(again.verdict, "saved");
  // Only that one is asked: the others' answers are kept for the same difference.
  assert.deepEqual(next.calls.asks.map((q) => q.number), [waiting]);
  assert.equal(new Map(next.calls.saved.verdicts.map((v) => [v.number, v])).get(1).model.decision, "not_needed");
});

test("a failed ask is not repeated for the same difference until it has waited", async () => {
  const first = ports({ candidates: [candidate(1)], stored: { mainSha: "f".repeat(40), at: "x", verdicts: [] }, ask: () => null });
  await runQaReleaseTrainVerdictRound(first.ports, options);
  const verdict = first.calls.saved.verdicts[0];
  assert.equal(verdict.askedAt, new Date(NOW).toISOString());
  const soon = ports({ candidates: [candidate(1)], stored: first.calls.saved, ask: () => null });
  assert.deepEqual(await runQaReleaseTrainVerdictRound(soon.ports, { ...options, now: () => NOW + 60 * 60_000 }), { verdict: "unchanged" });
  const later = ports({ candidates: [candidate(1)], stored: first.calls.saved, ask: () => null });
  const outcome = await runQaReleaseTrainVerdictRound(later.ports, { ...options, now: () => NOW + 7 * 60 * 60_000, deadlineMs: NOW + 8 * 60 * 60_000 });
  assert.equal(outcome.asked, 1);
});

test("without the model, or near the deadline, nothing is asked; an unreadable candidate is unread", async () => {
  const off = ports({ candidates: [candidate(1), candidate(2)], read: (c) => (c.number === 2 ? Promise.reject(new Error("git_failed")) : differs) });
  const outcome = await runQaReleaseTrainVerdictRound(off.ports, options);
  assert.deepEqual(outcome, { verdict: "saved", checked: 2, onMain: 0, differs: 1, asked: 0 });
  assert.deepEqual(off.calls.saved.verdicts.find((v) => v.number === 2).content, { state: "unread" });
  const late = ports({ candidates: [candidate(1)], ask: () => ({ decision: "release", why: { ko: "가", en: "a" }, evidence: [] }) });
  assert.equal((await runQaReleaseTrainVerdictRound(late.ports, { deadlineMs: NOW + 60_000, now: () => NOW })).asked, 0);
});

test("a failed read is a short code, never a message", async () => {
  const broken = ports({ candidates: [candidate(1)] });
  broken.ports.git.mainHead = async () => {
    throw new Error("https://token@github.com refused");
  };
  assert.deepEqual(await runQaReleaseTrainVerdictRound(broken.ports, options), { verdict: "failed", failure: "main_head:unknown" });
});

// A real git run: main carries one develop pull request under another commit
// (a selective release that also moved the lines around), and lacks another.
test("the git port finds a change main carries under another commit, and names what main lacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "train-verdict-test-"));
  const port = createQaReleaseTrainVerdictGit({ remote: join(root, "origin") });
  try {
    const repo = join(root, "origin");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "a.ts"), "export const base = 1;\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("switch", "--quiet", "-c", "develop");
    const merge = (name, file, text) => {
      git("switch", "--quiet", "-c", name, "develop");
      writeFileSync(join(repo, file), text);
      git("add", ".");
      git("commit", "--quiet", "-m", name);
      git("switch", "--quiet", "develop");
      git("merge", "--quiet", "--no-ff", "-m", `Merge pull request #${name.slice(1)} from x/${name}`, name);
      return git("rev-parse", "HEAD");
    };
    const shipped = merge("p11", "a.ts", "export const base = 1;\nexport const shipped = true;\n");
    const missing = merge("p12", "b.ts", "export const notYet = true;\n");
    // #13 only makes a.ts executable: the same blob, another mode.
    git("switch", "--quiet", "-c", "p13", "develop");
    git("update-index", "--chmod=+x", "a.ts");
    git("commit", "--quiet", "-m", "p13");
    git("switch", "--quiet", "develop");
    git("merge", "--quiet", "--no-ff", "-m", "Merge pull request #13 from x/p13", "p13");
    const modeOnly = git("rev-parse", "HEAD");
    // main got #11 with other lines around it, through a release of its own.
    git("switch", "--quiet", "main");
    git("switch", "--quiet", "-c", "release/x");
    writeFileSync(join(repo, "a.ts"), "export const release = 0;\nexport const base = 1;\nexport const shipped = true;\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "release");
    git("switch", "--quiet", "main");
    git("merge", "--quiet", "--no-ff", "-m", "Merge pull request #900 from x/release", "release/x");
    const head = git("rev-parse", "HEAD");

    assert.equal(await port.mainHead(), head);
    assert.equal(await port.prepare(), head);
    const one = await port.analyse({ number: 11, title: "", mergeCommitSha: shipped, mergedAt: "2026-10-20T00:00:00Z", mainPullRequest: null });
    const two = await port.analyse({ number: 12, title: "", mergeCommitSha: missing, mergedAt: "2026-10-20T00:01:00Z", mainPullRequest: null });
    const { qaReleaseTrainContentGap } = await import("../lib/qaReleaseTrainVerdictCore.ts");
    assert.equal(qaReleaseTrainContentGap(one.changed).verdict.state, "on_main");
    const gap = qaReleaseTrainContentGap(two.changed);
    assert.equal(gap.verdict.state, "differs");
    assert.deepEqual(gap.gap, [{ path: "b.ts", missing: ["export const notYet = true;"], leftOnMain: [] }]);
    const three = await port.analyse({ number: 13, title: "", mergeCommitSha: modeOnly, mergedAt: "2026-10-20T00:02:00Z", mainPullRequest: null });
    assert.equal(qaReleaseTrainContentGap(three.changed).verdict.state, "differs");
    // The release that touched a.ts after #11 merged.
    assert.deepEqual(await port.mainPullsTouching(["a.ts"], "2000-01-01T00:00:00Z"), [900]);
  } finally {
    await port.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
