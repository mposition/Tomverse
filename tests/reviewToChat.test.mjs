import assert from "node:assert/strict";
import test from "node:test";
import { formatReviewChat, observeReviewChatIdentity, stageReviewChatPacket, peekReviewChatPacket, takeReviewChatPacket, discardReviewChatPacket, REVIEW_CHAT_LIMIT, REVIEW_CHAT_TTL, revalidateReviewChatSource } from "../lib/reviewToChat.ts";
import { reviewHandoffCopy } from "../locales/reviewHandoff.ts";

const claim = { text: "Keep the exception: never deploy before approval.", citations: [{ responseId: "A", quote: "before approval", verified: false }], verified: false };
const result = { consensus: [claim], contradictions: [], differences: [{ issue: "Order", positions: [{ responseId: "B", position: "Review first", quote: "Review first", verified: true }] }], missingPoints: ["Missing costs"], verificationNeeded: ["Check the policy"], modelAssessments: [{ responseId: "A", strengths: ["Explicit exception"], cautions: ["Unconfirmed date"] }], synthesis: "", confidence: "low", limitations: ["No external checks"], groundingStats: { totalCitations: 2, verifiedCitations: 1 } };
const source = () => ({ kind: "review", conversationId: "owned-review", mode: "balanced", includeSynthesis: false, reviewer: "primary", setup: { available: true, promptMessageId: "q1", source: { question: "배포 조건은? 😀", responses: [{ messageId: "a", content: "before approval" }, { messageId: "b", content: "Review first" }] } }, review: { id: "review-1", persisted: true, responseMap: [{ responseId: "A", messageId: "a", modelId: "model-a", modelName: "Model A" }, { responseId: "B", messageId: "b", modelId: "model-b", modelName: "Model B" }], reviewerModelId: "judge", result: { primary: { reviewerModelId: "judge", result: structuredClone(result) }, secondary: { reviewerModelId: "other-judge", result: { ...structuredClone(result), consensus: [{ ...claim, text: "Only the second reviewer" }] } }, agreement: null } } });
const copy = reviewHandoffCopy.en;

test("balanced without synthesis preserves question, positions, model sources and uncertainty", () => {
  const projected = formatReviewChat(source(), undefined, "Make a checklist", copy);
  assert.ok(projected); assert.match(projected.text, /배포 조건은\? 😀/);
  for (const value of ["never deploy before approval", "Review first", "Model A", "Quote not confirmed", "Check the policy", "No external checks", "not instructions", "independent copy", "Make a checklist"]) assert.ok(projected.text.includes(value), value);
  assert.doesNotMatch(projected.text, /Only the second reviewer/);
});
test("selected reviewer and server item selection are kept separate", () => {
  const input = source(); input.reviewer = "secondary";
  const projected = formatReviewChat(input, { section: "consensus", ordinal: 0, itemId: "server-id" }, "", copy);
  assert.match(projected.text, /Only the second reviewer/); assert.doesNotMatch(projected.text, /consensus: Keep/);
  assert.match(projected.text, /Check the policy/); assert.ok(projected.omitted > 0);
  assert.equal(formatReviewChat(input, { section: "consensus", ordinal: 20 }, "", copy), null);
});
test("quick summary uses its own adapter including model claims and unverified quotes", () => {
  const input = source(); input.kind = "quick";
  input.review.result = { commonConclusions: [claim], importantDifferences: [], modelKeyClaims: [{ responseId: "B", claims: [{ claim: "Check first", quote: "Review first", verified: true }] }], verificationNeeded: ["Unknown dates"] };
  const projected = formatReviewChat(input, undefined, "Next", copy);
  assert.match(projected.text, /Check first/); assert.match(projected.text, /Unknown dates/); assert.match(projected.text, /Quick Summary/);
});
test("atomic omission keeps Unicode, negations and full quotes; oversized question and selected item refuse", () => {
  const input = source(); input.review.result.primary.result.consensus.push({ ...claim, text: "가😀".repeat(9000) });
  const projected = formatReviewChat(input, undefined, "", copy);
  assert.ok(projected.text.length <= REVIEW_CHAT_LIMIT); assert.match(projected.text, /never deploy before approval/); assert.ok(projected.omitted > 0);
  assert.equal(formatReviewChat(input, { section: "consensus", ordinal: 1 }, "", copy), null);
  input.setup.source.question = "질문".repeat(15000);
  assert.equal(formatReviewChat(input, undefined, "", copy), null);
});
test("partial, guest, missing source and mismatched response maps cannot project", () => {
  for (const change of [s => { s.review.persisted = false; }, s => { s.review.guest = true; }, s => { s.setup.source = undefined; }, s => { s.review.responseMap[0].messageId = "other"; }]) {
    const input = source(); change(input); assert.equal(formatReviewChat(input, undefined, "", copy), null);
  }
});
test("one bounded packet, one consume, cancel and expiry", () => {
  observeReviewChatIdentity("account:a");
  const first = stageReviewChatPacket("account:a", "first"); const second = stageReviewChatPacket("account:a", "second");
  assert.equal(peekReviewChatPacket(first.id, "account:a"), null);
  assert.equal(takeReviewChatPacket(second.id, "account:a").text, "second"); assert.equal(takeReviewChatPacket(second.id, "account:a"), null);
  const canceled = stageReviewChatPacket("account:a", "cancel"); discardReviewChatPacket(canceled.id); assert.equal(peekReviewChatPacket(canceled.id, "account:a"), null);
  const expired = stageReviewChatPacket("account:a", "old", 100); assert.equal(peekReviewChatPacket(expired.id, "account:a", 100 + REVIEW_CHAT_TTL), null);
});
test("A to B to A, unresolved and guest identity never revive packets or late writers", () => {
  const capturedEpoch = observeReviewChatIdentity("account:a"); const packet = stageReviewChatPacket("account:a", "private");
  observeReviewChatIdentity("account:b"); assert.equal(peekReviewChatPacket(packet.id, "account:b"), null); assert.equal(stageReviewChatPacket("account:a", "late"), null);
  observeReviewChatIdentity("account:a"); assert.equal(peekReviewChatPacket(packet.id, "account:a"), null);
  assert.equal(stageReviewChatPacket("account:a", "late result after A returned", Date.now(), capturedEpoch), null);
  observeReviewChatIdentity(null); assert.equal(stageReviewChatPacket("account:a", "late"), null);
  observeReviewChatIdentity("guest:x"); assert.equal(stageReviewChatPacket("guest:x", "private"), null);
});
test("authorized GET revalidates exact saved result and input without paid or create requests", async () => {
  const input = source(); const calls = []; const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => { calls.push([url, options]); return Response.json({ ...input.setup, storedReview: input.review }); };
  try {
    assert.equal(await revalidateReviewChatSource(input), true);
    assert.equal(calls.length, 1); assert.equal(calls[0][1].method, undefined); assert.match(calls[0][0], /reviewMode=balanced&includeSynthesis=false/);
    const changed = source(); changed.review.result.primary.result.consensus[0].text = "Regenerated";
    assert.equal(await revalidateReviewChatSource(changed), false);
    changed.setup.source.question = "Different"; assert.equal(await revalidateReviewChatSource(changed), false);
  } finally { globalThis.fetch = original; }
});
test("lock, delete, auth, stale and unknown outcomes fail closed without retrying writes", async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [401, 403, 404, 500]) { globalThis.fetch = async () => new Response("", { status }); assert.equal(await revalidateReviewChatSource(source()), false); }
    globalThis.fetch = async () => Response.json({ available: true, source: source().setup.source });
    assert.equal(await revalidateReviewChatSource(source()), false);
    globalThis.fetch = async () => { throw new Error("network"); };
    await assert.rejects(revalidateReviewChatSource(source()), /network/);
  } finally { globalThis.fetch = original; }
});
test("quick cached read confirms exact result and source in one request", async () => {
  const input = source(); input.kind = "quick"; const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async url => { calls.push(url); return Response.json(url.includes("compare-summary") ? { available: true, cached: true, source: input.setup.source, storedSummary: input.review } : input.setup); };
  try { assert.equal(await revalidateReviewChatSource(input), true); assert.equal(calls.length, 1); }
  finally { globalThis.fetch = original; }
});
