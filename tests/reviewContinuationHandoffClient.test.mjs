import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewHandoffPreview, reviewHandoffAttemptFor, reviewHandoffDraftEndpoint } from "../lib/reviewContinuationHandoffClient.ts";

test("a lost answer handoff retries its key, changing anchors starts a new attempt", () => {
  let next = 0;
  const create = () => `key-${++next}`;
  const a = reviewHandoffAttemptFor(undefined, "answer-a", create);
  assert.equal(reviewHandoffAttemptFor(a, "answer-a", create), a);
  const b = reviewHandoffAttemptFor(a, "answer-b", create);
  const returnedA = reviewHandoffAttemptFor(b, "answer-a", create);
  assert.deepEqual([a.idempotencyKey, b.idempotencyKey, returnedA.idempotencyKey], ["key-1", "key-2", "key-3"]);
});

test("preview allowlists counts and availability without retaining reference content", () => {
  const preview = parseReviewHandoffPreview({ status: "unavailable", sourceMode: "legacy", nativeTurnCount: 2,
    nativeOmittedCount: 1, sourceTurnCount: 3, sourceOmittedCount: 4, attachmentsSupported: false,
    text: "Private reference", digest: "private-binding", parentConversationId: "parent" });
  assert.equal(preview.status, "unavailable");
  assert.equal(preview.sourceMode, "legacy");
  assert.doesNotMatch(JSON.stringify(preview), /Private|private-binding|parent/);
  assert.equal(parseReviewHandoffPreview({ ...preview, nativeTurnCount: -1 }), null);
  assert.equal(parseReviewHandoffPreview({ ...preview, sourceMode: "exact-replay" }), null);
  assert.equal(parseReviewHandoffPreview({ ...preview, status: "unknown" }), null);
  assert.equal(reviewHandoffDraftEndpoint("target"), "/api/conversations/target/continuation/review-handoff/draft");
});
