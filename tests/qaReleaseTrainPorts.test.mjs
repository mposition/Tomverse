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
  assert.deepEqual(await answerWith({ numbers: [1, 2], emergency: [3] }).selection(), { numbers: [1, 2], emergency: [3] });
  // An app older than emergency trains says nothing of them.
  assert.deepEqual(await answerWith({ numbers: [1] }).selection(), { numbers: [1], emergency: null });
  await assert.rejects(answerWith({ numbers: [1], emergency: ["x"] }).selection(), /app_selection_shape/);

  sent.length = 0;
  const ports = answerWith({ admitted: true });
  await ports.admit("20261020-1237", true);
  await ports.admit("20261020-1100");
  assert.deepEqual(sent, [
    { phase: "admit", slot: "20261020-1237", emergency: true },
    { phase: "admit", slot: "20261020-1100" },
  ]);
});
