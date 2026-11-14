import assert from "node:assert/strict";
import test from "node:test";
import { planContinuationSeed, planSelectedContinuationSeed, CONTINUATION_SEED_TOKEN_BUDGET } from "../lib/externalContinuationSeedCore.ts";
import { buildContinuationSeedPrompt } from "../lib/externalContinuationSeedPrompt.ts";
import { continuationReceipt, receiptForAttempt } from "../lib/continuationReceipt.ts";
import { estimateTextTokens } from "../lib/chatTokenEstimate.ts";
import { buildChatStreamTrailerChunk, parseChatStreamTrailer, splitSearchMetadataTrailer } from "../lib/webSearchStreamTrailer.ts";
import { CONTINUATION_FIDELITY_CASES, FIDELITY_ARMS } from "../lib/continuationFidelityCases.ts";
import { continuationFidelityProbe, assessContinuationFidelity } from "../lib/continuationFidelityProbe.ts";
import { toChatRequestMessage, toGuestPersistableMessage } from "../lib/chatMessageSerialization.ts";

const row = (ordinal, content, role = "user") => ({ ordinal, content, role, truncated: false });
const compose = (messages, selectedMessages, passages, tokenBudget) => planSelectedContinuationSeed({ messages, selectedMessages, passages, tokenBudget });

test("selected past evidence and recent correction share one bounded source plan", () => {
    const old = row(0, "Budget: 100. The trip is to Tokyo.");
    const recent = row(250, "Correction: budget is 70, Tokyo stays.");
    const plan = compose([recent], [old], [{ ordinal: 0, start: 0, end: old.content.length }]);
    const prompt = buildContinuationSeedPrompt({ provider: "chatgpt", importedAt: null, plan });
    assert.match(prompt.transcriptText, /Budget: 100.*\n.*budget is 70/s);
    assert.equal(plan.estimatedTokens, plan.turns.reduce((sum, turn) => sum + estimateTextTokens(turn.text), 0));
    assert.ok(plan.estimatedTokens <= CONTINUATION_SEED_TOKEN_BUDGET);
    const receipt = continuationReceipt({ traceId: "trace", assistantMessageId: "answer", selected: true, outcome: "seeded", plan });
    assert.deepEqual([receipt.selectedCount, receipt.recentCount, receipt.uniqueMessageCount], [1, 1, 2]);
    assert.equal(receipt.status, "not_sent", "planning alone is not dispatch");
});

test("overlap is deduplicated by ordinal and coordinates, not matching words", () => {
    const messages = [row(0, "same repeated words"), row(1, "same repeated words")];
    const plan = compose(messages, [messages[0]], [{ ordinal: 0, start: 5, end: 13 }]);
    assert.equal(plan.turns.length, 2);
    assert.equal(plan.turns[0].text, messages[0].content);
    assert.deepEqual(plan.turns[0].selectedRanges, [{ start: 5, end: 13 }]);
    assert.deepEqual(plan.turns[0].ranges, [{ start: 0, end: messages[0].content.length }]);
    const r = continuationReceipt({ traceId: "t", assistantMessageId: "a", selected: true, outcome: "seeded", plan });
    assert.deepEqual([r.selectedCount, r.recentCount, r.uniqueMessageCount], [1, 2, 2]);
});

test("selected middle and v2 ending survive under per-message and total caps including gap markers", () => {
    const content = "😀".repeat(2600) + "SELECTED_MIDDLE" + "한글".repeat(2600) + "\nLATEST_CORRECTION";
    const message = row(2, content);
    const start = content.indexOf("SELECTED_MIDDLE");
    const plan = compose([message], [message], [{ ordinal: 2, start, end: start + 15 }]);
    assert.match(plan.turns[0].text, /SELECTED_MIDDLE/);
    assert.match(plan.turns[0].text, /LATEST_CORRECTION$/);
    assert.ok(Array.from(plan.turns[0].text).length <= 4000);
    assert.ok(plan.estimatedTokens <= 3000);
    assert.equal(plan.estimatedTokens, estimateTextTokens(plan.turns[0].text));
    assert.equal(plan.turns[0].shortened, true);
});

test("invalid, empty, missing and blank selected coordinates do not become automatic success", () => {
    const messages = [row(1, "real recent evidence"), row(2, "   ")];
    for (const passages of [[], [{ ordinal: 0, start: 0, end: 2 }], [{ ordinal: 1, start: 0, end: 501 }],
        [{ ordinal: 2, start: 0, end: 2 }], [{ ordinal: 1, start: 0, end: 2 }, { ordinal: 9, start: 0, end: 2 }]]) {
        assert.equal(compose(messages, messages, passages).turns.length, 0);
    }
    assert.ok(planContinuationSeed({ messages }).turns.length > 0);
});

test("UTF-16 selection drops partial emoji and preserves chronological source ranges", () => {
    const message = row(1, "a😀b😀c");
    const plan = compose([], [message], [{ ordinal: 1, start: 2, end: 5 }]);
    assert.equal(plan.turns[0].text, "b");
    assert.deepEqual(plan.turns[0].selectedRanges, [{ start: 3, end: 4 }]);
});

test("tiny budgets report recent omissions and never discard a valid selected passage silently", () => {
    const old = row(0, "old");
    const messages = [row(1, "recent cannot fit into a tiny budget")];
    const plan = compose(messages, [old], [{ ordinal: 0, start: 0, end: 3 }], 2);
    assert.equal(plan.turns[0].text, "old");
    assert.ok(plan.estimatedTokens <= 2);
    assert.ok(plan.omittedByBudgetCount > 0 || plan.truncatedCount > 0);
});

test("receipt transport binds trace, response identity and monotonically increasing attempt", () => {
    const r = continuationReceipt({ traceId: "t", assistantMessageId: "a", selected: false, outcome: "locked" });
    const final = { ...r, attempt: 1, status: "dispatched" };
    const chunk = buildChatStreamTrailerChunk({ searchMetadata: null, continuationReceipt: final });
    const parsed = parseChatStreamTrailer(splitSearchMetadataTrailer(chunk).searchMetadataJson);
    assert.deepEqual(receiptForAttempt(parsed.continuationReceipt, "t", "a", r), final);
    assert.equal(receiptForAttempt(r, "other", "a"), undefined);
    assert.equal(receiptForAttempt(r, "t", "other"), undefined);
    assert.equal(receiptForAttempt(r, "t", "a", final), undefined);
    assert.equal(receiptForAttempt(null, "t", "a"), undefined);
    assert.equal(receiptForAttempt({ ...r, recentCount: -1 }, "t", "a"), undefined);
});

test("receipts are excluded from provider history and persisted browser transcripts", () => {
    const receipt = continuationReceipt({ traceId: "t", assistantMessageId: "a", selected: false, outcome: "locked" });
    const message = { id: "a", role: "assistant", content: "Native answer", continuationReceipt: receipt };
    assert.equal(toChatRequestMessage(message).continuationReceipt, undefined);
    assert.equal(toGuestPersistableMessage(message).continuationReceipt, undefined);
});

test("24 independent bilingual fixtures declare per-field final-input coverage for all three arms", () => {
    assert.equal(CONTINUATION_FIDELITY_CASES.length, 24);
    assert.equal(new Set(CONTINUATION_FIDELITY_CASES.map(f => f.id)).size, 24);
    for (const fixture of CONTINUATION_FIDELITY_CASES) for (const arm of FIDELITY_ARMS) {
        const probe = continuationFidelityProbe(fixture, arm);
        assert.deepEqual(probe.coverage, probe.expectedCoverage, `${fixture.id}/${arm}`);
        assert.ok(probe.plan.estimatedTokens <= 3000);
        assert.ok(probe.plan.turns.every(turn => Array.from(turn.text).length <= 4000));
        assert.match(probe.promptDigest, /^[a-f0-9]{64}$/);
    }
});

test("quality grading separates partial evidence fields and source truth from justified abstention", () => {
    const fixture = CONTINUATION_FIDELITY_CASES.find(f => f.id === "long-middle-en");
    const probe = continuationFidelityProbe(fixture, "automatic");
    const grade = assessContinuationFidelity(probe, '{"A":"UNKNOWN","B":"NO"}');
    assert.deepEqual(grade.fields.map(f => f.visibleCorrect), [true, true]);
    assert.deepEqual(grade.fields.map(f => f.originalCorrect), [false, true]);
    assert.deepEqual(grade.fields.map(f => f.necessaryAbstention), [true, false]);
    assert.equal(assessContinuationFidelity(probe, '{"A":"DAYS90","B":"NO"}').fields[0].unsupportedAssertion, true);
    const candidate = continuationFidelityProbe(fixture, "automatic", "source-order-v1");
    assert.deepEqual(candidate.plan, probe.plan);
    assert.notEqual(candidate.promptDigest, probe.promptDigest);
});
