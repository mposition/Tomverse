import assert from "node:assert/strict";
import test from "node:test";

import { qaReleaseMainCandidates } from "../lib/qaReleaseMainCandidatesCore.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const pull = (number, head, extra = {}) => ({
  number,
  title: `PR ${number}`,
  state: "open",
  draft: false,
  html_url: `https://github.com/mposition/Tomverse/pull/${number}`,
  head: { ref: head },
  base: { ref: "main" },
  ...extra,
});

test("open main pull requests carry the source rule's verdict, sorted by number", () => {
  const result = qaReleaseMainCandidates({
    openPullsJson: [pull(12, "claude/to-main/x"), pull(10, "release/2026-10-19-x", { draft: true }), pull(11, "develop"), { junk: true }, pull(13, "develop", { base: { ref: "develop" } })],
    mainHeadJson: { sha: A },
    environment: "production",
    servingSha: A,
  });
  assert.deepEqual(
    result.pullRequests.map((p) => [p.number, p.allowed, p.draft]),
    [[10, true, true], [11, true, false], [12, false, false]],
  );
  assert.deepEqual(result.production, { environment: "production", servingSha: A, mainHeadSha: A, servesMainHead: true });
});

test("an unread GitHub answer is unread, not empty; an unknown commit makes the state unknown", () => {
  const unread = qaReleaseMainCandidates({ openPullsJson: null, mainHeadJson: null, environment: "staging", servingSha: B });
  assert.equal(unread.pullRequests, null);
  assert.equal(unread.production.servesMainHead, null);
  const behind = qaReleaseMainCandidates({ openPullsJson: [], mainHeadJson: { sha: A }, environment: "production", servingSha: B });
  assert.deepEqual(behind.pullRequests, []);
  assert.equal(behind.production.servesMainHead, false);
  const badSha = qaReleaseMainCandidates({ openPullsJson: [], mainHeadJson: { sha: "nope" }, environment: "production", servingSha: "abc" });
  assert.deepEqual([badSha.production.mainHeadSha, badSha.production.servingSha, badSha.production.servesMainHead], [null, null, null]);
});
