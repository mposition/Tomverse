import assert from "node:assert/strict";
import test from "node:test";

import {
    SEARCH_RESULT_LIMIT,
    SEARCH_RESULTS_PER_CONVERSATION,
    SEARCH_CANDIDATE_ROW_LIMIT,
    escapeLikePattern,
    isStatementTimeout,
    rankSearchHits,
} from "../lib/conversationSearchResults.ts";
import { parseAroundMessageId } from "../lib/continuationFocus.ts";
import {
    CONTINUATION_FOCUS_ARRIVAL_MS,
    clearContinuationFocus,
    continuationFocusSnapshot,
    noteContinuationFocusConversation,
    requestContinuationFocus,
    subscribeContinuationFocus,
} from "../lib/continuationFocusHandoff.ts";

/** CONT-SEARCH-01: ordering, caps and the literal-substring contract. */

const hit = (conversationId, updatedAt, kind, recency, key = `${conversationId}:${kind}:${recency}`) => ({
    conversationId,
    conversationUpdatedAt: new Date(updatedAt),
    kind,
    recency,
    key,
    value: key,
});

test("LIKE metacharacters are escaped so a query is a literal substring", () => {
    assert.equal(escapeLikePattern("100%_done\\"), "100\\%\\_done\\\\");
    assert.equal(escapeLikePattern("배포 일정"), "배포 일정");
});

test("hits order by conversation activity, native before imported, newest first", () => {
    const { results, truncated } = rankSearchHits(
        [
            hit("old", "2026-09-01", "native", 5),
            hit("new", "2026-09-10", "imported", 3),
            hit("new", "2026-09-10", "native", 1),
            hit("new", "2026-09-10", "imported", 9),
        ],
        { candidatesExhausted: true }
    );
    assert.deepEqual(results, ["new:native:1", "new:imported:9", "new:imported:3", "old:native:5"]);
    assert.equal(truncated, false);
});

test("one conversation cannot fill the list, and the cap is reported", () => {
    const many = Array.from({ length: 12 }, (_, index) => hit("busy", "2026-09-10", "imported", index));
    const { results, truncated } = rankSearchHits(
        [...many, hit("quiet", "2026-09-01", "native", 1)],
        { candidatesExhausted: true }
    );
    assert.equal(results.length, SEARCH_RESULTS_PER_CONVERSATION + 1);
    assert.equal(results.at(-1), "quiet:native:1");
    assert.equal(truncated, true);
});

test("the overall limit and an unread candidate budget both mark the answer incomplete", () => {
    const hits = Array.from({ length: 40 }, (_, index) =>
        hit(`c${String(index).padStart(2, "0")}`, "2026-09-10", "native", 1)
    );
    const capped = rankSearchHits(hits, { candidatesExhausted: true });
    assert.equal(capped.results.length, SEARCH_RESULT_LIMIT);
    assert.equal(capped.truncated, true);

    const unread = rankSearchHits(hits.slice(0, 2), { candidatesExhausted: false });
    assert.equal(unread.results.length, 2);
    assert.equal(unread.truncated, true);
});

test("the ranking is independent of input order", () => {
    const hits = [
        hit("a", "2026-09-10", "native", 2),
        hit("b", "2026-09-10", "native", 2),
        hit("a", "2026-09-10", "imported", 7),
    ];
    const forward = rankSearchHits(hits, { candidatesExhausted: true }).results;
    const backward = rankSearchHits([...hits].reverse(), { candidatesExhausted: true }).results;
    assert.deepEqual(forward, backward);
});

test("the candidate row limit covers one more group than can be shown", () => {
    assert.equal(SEARCH_CANDIDATE_ROW_LIMIT, (SEARCH_RESULT_LIMIT + 1) * (SEARCH_RESULTS_PER_CONVERSATION + 1));
});

test("a statement timeout is recognised by SQLSTATE wherever the adapter nests it", () => {
    // Prisma 7 + adapter-pg, with no English message to lean on.
    assert.equal(isStatementTimeout({ meta: { driverAdapterError: { cause: { originalCode: "57014" } } } }), true);
    assert.equal(isStatementTimeout({ cause: { code: "57014" } }), true);
    assert.equal(isStatementTimeout({ code: "P2028", message: "statement timeout" }), false);
    assert.equal(isStatementTimeout({ meta: { driverAdapterError: { cause: { originalCode: "40P01" } } } }), false);
    const loop = {};
    loop.cause = loop;
    assert.equal(isStatementTimeout(loop), false);
});

test("equal recency breaks toward the larger key, as the candidate SQL does", () => {
    const hits = ["a1", "a3", "a2"].map((id) => hit("c", "2026-09-10", "native", 1, `native:${id}`));
    assert.deepEqual(rankSearchHits(hits, { candidatesExhausted: true }).results, ["native:a3", "native:a2", "native:a1"]);
});

test("a focus request survives the page it leaves and is spent once its conversation is left", () => {
    requestContinuationFocus("target", "msg");
    // The page being navigated away from still shows another conversation.
    noteContinuationFocusConversation("previous");
    noteContinuationFocusConversation(null);
    assert.equal(continuationFocusSnapshot()?.conversationId, "target");
    noteContinuationFocusConversation("target");
    assert.equal(continuationFocusSnapshot()?.arrived, true);
    // Leaving for a new chat spends it, so reopening later opens at the end.
    noteContinuationFocusConversation(null);
    assert.equal(continuationFocusSnapshot(), null);

    requestContinuationFocus("target", "msg");
    const { requestedAt } = continuationFocusSnapshot();
    noteContinuationFocusConversation("elsewhere", requestedAt + CONTINUATION_FOCUS_ARRIVAL_MS + 1);
    assert.equal(continuationFocusSnapshot(), null, "a request that never arrived expires");

    requestContinuationFocus("target", "msg");
    const late = continuationFocusSnapshot();
    noteContinuationFocusConversation("target", late.requestedAt + CONTINUATION_FOCUS_ARRIVAL_MS + 1);
    assert.equal(continuationFocusSnapshot(), null, "arriving after the window does not apply it");

    // A hit in the conversation already open has arrived when it is made, so
    // leaving before the read finishes still spends it.
    requestContinuationFocus("open", "msg", { alreadyOpen: true });
    assert.equal(continuationFocusSnapshot()?.arrived, true);
    noteContinuationFocusConversation(null);
    assert.equal(continuationFocusSnapshot(), null);
});

test("an unarrived focus request expires on its own clock", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    requestContinuationFocus("target", "msg");
    t.mock.timers.tick(CONTINUATION_FOCUS_ARRIVAL_MS - 1);
    assert.ok(continuationFocusSnapshot());
    t.mock.timers.tick(2);
    assert.equal(continuationFocusSnapshot(), null);

    requestContinuationFocus("open", "msg", { alreadyOpen: true });
    t.mock.timers.tick(CONTINUATION_FOCUS_ARRIVAL_MS * 2);
    assert.ok(continuationFocusSnapshot(), "an arrived request waits for its list, not the clock");
    clearContinuationFocus();
});

test("around accepts a bare cuid and nothing else", () => {
    assert.equal(parseAroundMessageId("clx0abc123"), "clx0abc123");
    for (const bad of [null, "", "imported:clx0abc123", "../x", "ABC", "a b", "a".repeat(65)]) {
        assert.equal(parseAroundMessageId(bad), null, String(bad));
    }
});

test("the focus handoff notifies, advances its nonce and clears", () => {
    let notified = 0;
    const unsubscribe = subscribeContinuationFocus(() => {
        notified += 1;
    });
    requestContinuationFocus("conv1", "msg1");
    const first = continuationFocusSnapshot();
    requestContinuationFocus("conv1", "msg1");
    const second = continuationFocusSnapshot();
    assert.equal(first.conversationId, "conv1");
    assert.ok(second.nonce > first.nonce, "the same hit twice is two requests");
    clearContinuationFocus();
    assert.equal(continuationFocusSnapshot(), null);
    clearContinuationFocus();
    assert.equal(notified, 3, "clearing nothing does not notify");
    unsubscribe();
});
