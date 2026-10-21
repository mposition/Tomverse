import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createQaReleaseTrainGitPorts, createQaReleaseTrainGithubPorts } from "../lib/qaReleaseTrainPorts.ts";
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

test("the main:next search is read page by page, past the first 100", async () => {
  const urls = [];
  const searchPage = (page) => {
    const count = page === 1 ? 100 : page === 2 ? 3 : 0;
    const start = (page - 1) * 100 + 1;
    return { items: Array.from({ length: count }, (_, i) => ({ number: start + i })) };
  };
  const http = async ({ url }) => {
    urls.push(url);
    if (url.startsWith("https://api.github.com/search/issues")) {
      const page = Number(new URL(url).searchParams.get("page"));
      return { status: 200, text: JSON.stringify(searchPage(page)) };
    }
    const number = Number(url.split("/").pop());
    return {
      status: 200,
      text: JSON.stringify({
        number,
        title: `PR ${number}`,
        labels: [{ name: "main:next" }],
        base: { ref: "develop" },
        merged_at: "2026-10-21T00:00:00Z",
        merge_commit_sha: String(number % 10).repeat(40),
      }),
    };
  };
  const github = createQaReleaseTrainGithubPorts({ http, token: async () => "t" });
  const cargo = await github.labelledCargo();
  assert.equal(cargo.length, 103);
  assert.ok(cargo.some((c) => c.number === 103), "the newest, on page 2, is carried");
  const searches = urls.filter((url) => url.includes("/search/issues"));
  assert.equal(searches.length, 2, "stops at the first short page");
  assert.ok(searches.every((url) => url.includes("sort=created") && url.includes("order=asc")));
});
