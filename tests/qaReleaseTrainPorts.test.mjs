import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createQaReleaseTrainAppPorts, createQaReleaseTrainGitPorts, createQaReleaseTrainGithubPorts } from "../lib/qaReleaseTrainPorts.ts";
import { qaReleaseTrainPullRequest } from "../lib/qaReleaseTrainCore.ts";

// The two defects left by the train's review: a rider that changes a workflow
// file made the whole push fail (the App has no workflows permission), and
// the main:next search read only its first 100 results.

test("a pull request that changes .github/workflows is left out, and the rest of the train still rides", async () => {
  const root = mkdtempSync(join(tmpdir(), "train-workflows-test-"));
  try {
    const repo = join(root, "origin");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    git("switch", "--quiet", "-c", "develop");
    const mergeFeature = (name, file, text) => {
      git("switch", "--quiet", "-c", name, "develop");
      mkdirSync(join(repo, file, ".."), { recursive: true });
      writeFileSync(join(repo, file), text);
      git("add", ".");
      git("commit", "--quiet", "-m", name);
      git("switch", "--quiet", "develop");
      git("merge", "--quiet", "--no-ff", "-m", `Merge ${name}`, name);
      return git("rev-parse", "HEAD");
    };
    const first = mergeFeature("first", "first.txt", "first\n");
    const workflow = mergeFeature("workflow", ".github/workflows/ci.yml", "on: push\n");
    const last = mergeFeature("last", "last.txt", "last\n");
    git("switch", "--quiet", "main");
    const mainSha = git("rev-parse", "HEAD");

    const ports = createQaReleaseTrainGitPorts({ token: async () => "unused", remote: repo });
    try {
      const result = await ports.assemble(
        "release/train-20261021-1100",
        [
          { number: 1, title: "first", mergeCommitSha: first, mergedAt: "2026-10-21T00:00:00Z" },
          { number: 2, title: "workflow", mergeCommitSha: workflow, mergedAt: "2026-10-21T00:01:00Z" },
          { number: 3, title: "last", mergeCommitSha: last, mergedAt: "2026-10-21T00:02:00Z" },
        ],
        2,
      );
      assert.deepEqual(result.picks, [
        { number: 1, outcome: "included" },
        { number: 2, outcome: "changes_workflows" },
        // The workflow pull request took no seat: #3 rides within capacity 2.
        { number: 3, outcome: "included" },
      ]);
      await ports.push("release/train-20261021-1100");
      const files = git("ls-tree", "-r", "--name-only", "release/train-20261021-1100").split("\n");
      assert.ok(files.includes("first.txt") && files.includes("last.txt"));
      assert.ok(!files.includes(".github/workflows/ci.yml"), "the workflow change is not on the train");
      assert.equal(git("rev-list", "--count", `${mainSha}..release/train-20261021-1100`), "2");
    } finally {
      await ports.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workflow change is listed as left out in the train's pull request", () => {
  const { body } = qaReleaseTrainPullRequest({
    slot: "20261021-1100",
    candidates: [{ number: 2, title: "CI tweak", mergeCommitSha: "a".repeat(40), mergedAt: "2026-10-21T00:00:00Z" }],
    picks: [{ number: 2, outcome: "changes_workflows" }],
    rcSha: "b".repeat(40),
    rollbackSha: "c".repeat(40),
  });
  assert.match(body, /## Left out \(1\)/);
  assert.match(body, /#2 CI tweak — changes \.github\/workflows/);
});

test("the picked numbers are read one by one; one not merged into develop, or gone, is left out", async () => {
  const http = async ({ url }) => {
    const number = Number(url.split("/").pop());
    if (number === 404) return { status: 404, text: "{}" };
    return {
      status: 200,
      text: JSON.stringify({
        number,
        title: `PR ${number}`,
        base: { ref: number === 3 ? "main" : "develop" },
        merged_at: number === 2 ? null : "2026-10-21T00:00:00Z",
        merge_commit_sha: String(number % 10).repeat(40),
      }),
    };
  };
  const github = createQaReleaseTrainGithubPorts({ http, token: async () => "t" });
  const cargo = await github.cargo([1, 2, 3, 404, 1]);
  assert.deepEqual(cargo.map((c) => c.number), [1]);
});

// The app's answer to the train (owner request 2026-10-25): the scheduled
// pick, and an emergency request's numbers when one is waiting.
test("the app port reads an emergency request and asks for an emergency admission by name", async () => {
  const env = { RAILWAY_ENVIRONMENT_NAME: "production", QA_RELEASE_MERGE_LANE_SECRET: "lane-secret", QA_RELEASE_CONTROL_REVISION: "3" };
  const sent = [];
  const answerWith = (body) =>
    createQaReleaseTrainAppPorts({
      env,
      http: async (request) => {
        sent.push(JSON.parse(request.body));
        return { status: 200, text: JSON.stringify(body) };
      },
    });
  assert.deepEqual(await answerWith({ numbers: [1, 2], emergency: { id: "cm123", numbers: [3] } }).selection(), {
    numbers: [1, 2],
    emergency: { id: "cm123", numbers: [3] },
  });
  // An app older than emergency trains says nothing of them.
  assert.deepEqual(await answerWith({ numbers: [1] }).selection(), { numbers: [1], emergency: null });
  await assert.rejects(answerWith({ numbers: [1], emergency: { id: "cm123", numbers: ["x"] } }).selection(), /app_selection_shape/);
  await assert.rejects(answerWith({ numbers: [1], emergency: { id: "a b", numbers: [3] } }).selection(), /app_selection_shape/);

  sent.length = 0;
  const ports = answerWith({ admitted: true });
  await ports.admit("20261020-1237", "cm123");
  await ports.admit("20261020-1100");
  assert.deepEqual(sent, [
    { phase: "admit", slot: "20261020-1237", emergencyRequestId: "cm123" },
    { phase: "admit", slot: "20261020-1100" },
  ]);
});

// Review r-20261025-064617: a train past the first hundred open main pull
// requests still holds the next one, and a list past the cap is a failed read.
test("open trains are counted across every page of open main pull requests", async () => {
  const pages = (count) =>
    Array.from({ length: count }, (_, i) => ({
      number: 5000 + i,
      head: { ref: i === count - 1 ? "release/train-20261025-1400" : `feature/${i}`, repo: { full_name: "mposition/Tomverse" } },
    }));
  const answerWith = (byPage) =>
    createQaReleaseTrainGithubPorts({
      token: async () => "t",
      http: async (request) => {
        const page = Number(new URL(request.url).searchParams.get("page"));
        return { status: 200, text: JSON.stringify(byPage[page - 1] ?? []) };
      },
    });
  // 100 others, then a train on page two.
  assert.equal((await answerWith([pages(100).map((p) => ({ ...p, head: { ref: "feature/x" } })), pages(3)]).openTrains()).count, 1);
  assert.equal((await answerWith([pages(5)]).openTrains()).count, 1);
  await assert.rejects(answerWith([pages(100), pages(100), pages(100)]).openTrains(), /github_pages/);
  // What each open train carries is the number leading each Included item:
  // not a number its titles mention (review r-20261025-074805), nor its other sections.
  const train = {
    number: 2998,
    title: "release: train 20261025-1400 (2 PRs) #4444",
    head: { ref: "release/train-20261025-1400", repo: { full_name: "mposition/Tomverse" } },
    body: "## Included (2)\n\n- #2985 follow up on #2988\n- #2989 fix\n\n## Left out (1)\n\n- #2659 conflict\n",
  };
  // A fork's pull request from a branch of the same name is not a train (review r-20261025-082156).
  const fork = { number: 9, head: { ref: "release/train-20261025-1500", repo: { full_name: "someone/Tomverse" } }, body: "## Included (1)\n\n- #3001 forged\n" };
  const goneFork = { number: 8, head: { ref: "release/train-20261025-1600", repo: null }, body: "## Included (1)\n\n- #3002 x\n" };
  assert.deepEqual(
    await answerWith([[train, fork, goneFork, { number: 1, head: { ref: "feature/x" }, body: "## Included\n- #7" }]]).openTrains(),
    { count: 1, riders: [2985, 2989] },
  );
});

test("a report an older app refuses for why is sent again without it; any other refusal stands", async () => {
  const env = { RAILWAY_ENVIRONMENT_NAME: "production", QA_RELEASE_MERGE_LANE_SECRET: "lane-secret", QA_RELEASE_CONTROL_REVISION: "3" };
  const sent = [];
  const ports = (statuses) =>
    createQaReleaseTrainAppPorts({
      env,
      http: async (request) => {
        sent.push(JSON.parse(request.body));
        const status = statuses.shift();
        return { status, text: JSON.stringify(status === 200 ? { ok: true } : { error: "bad" }) };
      },
    });
  const report = {
    slot: "20261027-1100",
    outcome: "opened",
    pullRequestNumber: 3100,
    branch: "release/train-20261027-1100",
    rcSha: "b".repeat(40),
    failure: null,
    picks: [
      { number: 10, outcome: "conflict", why: "It needs #9." },
      { number: 11, outcome: "included" },
    ],
  };
  await ports([400, 200]).report(report);
  assert.deepEqual(sent.map((body) => body.picks), [report.picks, [{ number: 10, outcome: "conflict" }, { number: 11, outcome: "included" }]]);
  sent.length = 0;
  await assert.rejects(ports([500]).report(report), /app_500/);
  await assert.rejects(ports([400]).report({ ...report, picks: [{ number: 11, outcome: "included" }] }), /app_400/);
  assert.equal(sent.length, 2);
});
