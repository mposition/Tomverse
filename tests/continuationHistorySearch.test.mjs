import assert from "node:assert/strict";
import test from "node:test";
import { historyMatchPassages, validHistoryQueries } from "../lib/continuationHistorySearch.ts";
import { planRetrievedContinuationSeed, planContinuationSeed } from "../lib/externalContinuationSeedCore.ts";
import { continuationReceipt, deliveryReceipt, parseContinuationReceipt } from "../lib/continuationReceipt.ts";

test("history terms are bounded literal data, including regex metacharacters and Korean", () => {
    for (const value of [null, [""], ["a".repeat(81)], ["a", "b", "c", "d"], [2]]) assert.equal(validHistoryQueries(value), false);
    assert.equal(validHistoryQueries([]), true);
    const rows = [{ ordinal: 3, content: "Use [A+B] only. 예산 70달러." }, { ordinal: 4, content: "unrelated" }];
    assert.equal(historyMatchPassages(rows, ["[A+B]"])[0].ordinal, 3);
    assert.equal(historyMatchPassages(rows, ["예산"])[0].ordinal, 3);
    assert.deepEqual(historyMatchPassages(rows, [".*"]), []);
});

for (const [language, fact, correction, query] of [
    ["English", "Final destination: Kyoto. Do not book Osaka.", "Latest: leave on Friday, not Thursday.", "Kyoto"],
    ["Korean", "확정 목적지는 교토. 오사카는 예약하지 마세요.", "최신 정정: 목요일이 아니라 금요일 출발.", "교토"],
]) test(`${language} buried history and latest correction survive one final bounded input`, () => {
    const history = { role: "user", ordinal: 17, content: "padding ".repeat(100) + fact + " suffix".repeat(100), truncated: false };
    const recent = { role: "user", ordinal: 999, content: correction, truncated: false };
    const passages = historyMatchPassages([history], [query]);
    assert.equal(passages[0].end - passages[0].start <= 500, true);
    const baseline = planContinuationSeed({ messages: [recent], sourceMessageCount: 1000 });
    assert.doesNotMatch(baseline.turns.map(t => t.text).join(""), new RegExp(query));
    const plan = planRetrievedContinuationSeed({ messages: [recent], selectedMessages: [], passages: null,
        retrievedMessages: [history], retrievedPassages: passages, sourceMessageCount: 1000 });
    const input = plan.turns.map(t => t.text).join("\n");
    assert.ok(input.includes(fact)); assert.ok(input.includes(correction));
    assert.ok(plan.estimatedTokens <= 3000);
    assert.equal(plan.turns.filter(t => t.retrievedRanges?.length).length, 1);
    assert.equal(plan.turns.filter(t => t.recentRanges?.length).length, 1);
    const receipt = continuationReceipt({ traceId: "trace", assistantMessageId: "answer", selected: false,
        outcome: "seeded", status: "dispatched", plan: { ...plan, historyOutcome: "matched" } });
    assert.equal(receipt.retrievedCount, 1); assert.equal(receipt.recentCount, 1); assert.equal(receipt.uniqueMessageCount, 2);
    assert.deepEqual(parseContinuationReceipt(JSON.stringify(receipt)), receipt);
    assert.equal(deliveryReceipt({ ...receipt, status: "not_sent" }).retrievedCount, 0);
});

test("manual, retrieved and recent ranges deduplicate without displacing manual evidence", () => {
    const row = { role: "user", ordinal: 8, content: "😀".repeat(2500) + " closing decision", truncated: false };
    const passage = { ordinal: 8, start: 0, end: 500 };
    const plan = planRetrievedContinuationSeed({ messages: [row], selectedMessages: [row], passages: [passage],
        retrievedMessages: [row], retrievedPassages: [passage] });
    assert.equal(plan.turns.length, 1);
    assert.equal(plan.turns[0].text.startsWith("😀".repeat(250)), true);
    assert.equal(plan.turns[0].text.endsWith("closing decision"), true);
    assert.ok(Array.from(plan.turns[0].text).length <= 4000);
    assert.ok(plan.estimatedTokens <= 3000);
    assert.deepEqual(plan.turns[0].selectedRanges, [passage].map(({ start, end }) => ({ start, end })));
    assert.equal(planRetrievedContinuationSeed({ messages: [row], selectedMessages: [row], passages: [],
        retrievedMessages: [row], retrievedPassages: [passage] }).turns.length, 0);
});
