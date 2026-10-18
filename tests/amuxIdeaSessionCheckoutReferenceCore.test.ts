import assert from "node:assert/strict";
import test from "node:test";

import { selectAmuxSessionCheckoutReference } from
  "@/lib/amux/ideaSessionCheckoutReferenceCore";

const idea = { version: 1 as const, idea: "Improve the backlog flow.",
  repositories: ["mposition/Tomverse"],
  pullRequests: [{ repository: "mposition/tomverse-private-docs", number: 37 }] };
const pin = "a".repeat(40);

test("checkout targets follow the sealed input order and canonical pin", () => {
  assert.deepEqual(selectAmuxSessionCheckoutReference({ idea,
    referenceCount: 2, pinnedCommitSha: pin, referenceOrdinal: 0 }), {
    referenceCount: 2, kind: "repository", repository: "mposition/Tomverse",
    pullRequestNumber: null, pinnedCommitSha: pin,
  });
  assert.deepEqual(selectAmuxSessionCheckoutReference({ idea,
    referenceCount: 2, pinnedCommitSha: pin, referenceOrdinal: 1 }), {
    referenceCount: 2, kind: "pull_request",
    repository: "mposition/tomverse-private-docs", pullRequestNumber: 37,
    pinnedCommitSha: pin,
  });
});

test("a missing, shifted or malformed intake pin never yields a checkout target", () => {
  for (const input of [
    { referenceCount: 1, pinnedCommitSha: pin, referenceOrdinal: 0 },
    { referenceCount: 2, pinnedCommitSha: pin, referenceOrdinal: 2 },
    { referenceCount: 2, pinnedCommitSha: null, referenceOrdinal: 0 },
    { referenceCount: 2, pinnedCommitSha: "not-a-sha", referenceOrdinal: 0 },
    { referenceCount: 2, pinnedCommitSha: pin, referenceOrdinal: -1 },
  ]) {
    assert.equal(selectAmuxSessionCheckoutReference({ idea, ...input }), null);
  }
  assert.equal(selectAmuxSessionCheckoutReference({ idea: { ...idea,
    repositories: [], pullRequests: [] }, referenceCount: 0,
  pinnedCommitSha: null, referenceOrdinal: 0 }), null);
});
