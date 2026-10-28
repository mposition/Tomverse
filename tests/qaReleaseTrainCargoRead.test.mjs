import assert from "node:assert/strict";
import test from "node:test";

import { readFromGithub } from "../lib/qaReleaseTrainCargoRead.ts";

const NOW = Date.parse("2026-10-28T00:00:00Z");
const develop = (number) => ({
  number,
  title: `PR ${number}`,
  user: { login: "codex" },
  base: { ref: "develop" },
  head: { ref: `claude/to-develop/pr-${number}` },
  merged_at: new Date(NOW - (6000 - number) * 60_000).toISOString(),
  updated_at: "2026-10-27T00:00:00Z",
  merge_commit_sha: String(number).padStart(40, "a"),
});

/** A GitHub with `count` merged develop pull requests, none on main, counting what is read. */
function github(count, { failFilesFor = new Set() } = {}) {
  const reads = [];
  const pulls = Array.from({ length: count }, (_, i) => develop(5000 + i));
  const readJson = async (path) => {
    reads.push(path);
    if (path.startsWith("/pulls?state=closed&base=develop")) return path.includes("page=1&") || path.endsWith("page=1") ? pulls : [];
    if (path.startsWith("/pulls?")) return [];
    const files = path.match(/^\/pulls\/(\d+)\/files/);
    if (files) {
      if (failFilesFor.has(Number(files[1]))) throw new Error("timeout");
      return [{ filename: `lib/pr-${files[1]}.ts` }];
    }
    const commits = path.match(/^\/pulls\/(\d+)\/commits/);
    if (commits) return [{ sha: String(commits[1]).padStart(40, "b"), parents: [{}], commit: { message: `change ${commits[1]}` } }];
    throw new Error(`unexpected ${path}`);
  };
  return { reads, readJson, fileReads: () => reads.filter((path) => /\/files/.test(path)).length };
}

test("every candidate's files are read, a merged pull request's only once, and at most 120 new ones a read", async () => {
  const first = github(150, { failFilesFor: new Set([5149]) });
  const one = await readFromGithub(NOW, first.readJson);
  assert.equal(one.status, "ok");
  // Newest first: 120 read this time (one failed), the 30 oldest wait for the next read.
  assert.equal(first.fileReads(), 120);
  const statusOf = (read) => new Map(read.candidates.map((candidate) => [candidate.number, candidate.status]));
  let status = statusOf(one);
  assert.equal(status.get(5148), "available");
  assert.equal(status.get(5149), "unchecked");
  assert.equal(status.get(5000), "unchecked");
  assert.equal([...status.values()].filter((value) => value === "unchecked").length, 31);

  // The next read starts only what was not read before: the 30 waiting and the one that failed.
  const second = github(150);
  const two = await readFromGithub(NOW, second.readJson);
  assert.equal(second.fileReads(), 31);
  status = statusOf(two);
  assert.equal([...status.values()].filter((value) => value === "unchecked").length, 0);

  // Then nothing is read again.
  const third = github(150);
  await readFromGithub(NOW, third.readJson);
  assert.equal(third.fileReads(), 0);
});
