import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewHandoffPreview, reviewHandoffAttemptFor, reviewHandoffDraftEndpoint, reviewHandoffReferencesAvailable } from "../lib/reviewContinuationHandoffClient.ts";

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

test("single-model handoff validation requires current explicit available metadata", async () => {
  const preview = { status: "available", sourceMode: "recorded", nativeTurnCount: 2, nativeOmittedCount: 0,
    sourceTurnCount: 3, sourceOmittedCount: 0, attachmentsSupported: false };
  const requests = [];
  const successful = async (url, options) => { requests.push({ url, options }); return Response.json({ reviewHandoff: preview }); };
  assert.equal(await reviewHandoffReferencesAvailable("target", successful), true);
  assert.deepEqual(requests, [{ url: "/api/conversations/target/continuation?offset=end&limit=1", options: { cache: "no-store" } }]);
  for (const reviewHandoff of [{ ...preview, status: "unavailable" }, { ...preview, status: undefined }, null]) {
    assert.equal(await reviewHandoffReferencesAvailable("target", async () => Response.json({ reviewHandoff })), false);
  }
  assert.equal(await reviewHandoffReferencesAvailable("target", async () => Response.json({ reviewHandoff: preview }, { status: 403 })), false);
  assert.equal(await reviewHandoffReferencesAvailable("target", async () => { throw new Error("Network unavailable"); }), false);
});
