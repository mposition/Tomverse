import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LEGACY_CONTINUATION_TITLE } from "../lib/continuationDisplayTitle.ts";
import {
    PRESERVE_TITLES_PARAM,
    SOURCE_TITLE_PRESERVATION_STALE,
    isReservedContinuationTitle,
    judgeTitlePreservation,
    readTitlePreservationRequest,
    summarizeTitleImpact,
    titlePreservability,
    wantsTitleImpact,
} from "../lib/continuationTitlePreservation.ts";
import {
    isStaleTitlePreservation,
    sourceDeletionQuery,
} from "../lib/externalSourceDeletionRequest.ts";

/**
 * CONT-TITLE-01, step 4: D1 (the placeholder is not a name a continuation can
 * be given) and D3 (keeping a shown name is an explicit, transactional choice
 * made with the source's deletion). The transaction itself is exercised
 * against PostgreSQL in
 * tests/integration/external-conversation-continuation.db.test.ts.
 */

const code = (path) => readFileSync(path, "utf8");

const target = (overrides = {}) => ({
    conversationId: "conv_b",
    conversationTitle: LEGACY_CONTINUATION_TITLE,
    conversationLocked: false,
    sourceTitle: "여행 계획",
    sourceLocked: false,
    ...overrides,
});

/* ------------------------------------------------------------------- D1 */

test("a continuation cannot be named the placeholder, spaces or not", () => {
    for (const title of [LEGACY_CONTINUATION_TITLE, `  ${LEGACY_CONTINUATION_TITLE} `]) {
        assert.equal(isReservedContinuationTitle({ title, isContinuation: true }), true);
    }
    // Only the exact words, and only for a continuation.
    assert.equal(
        isReservedContinuationTitle({ title: `${LEGACY_CONTINUATION_TITLE}!`, isContinuation: true }),
        false
    );
    assert.equal(
        isReservedContinuationTitle({ title: LEGACY_CONTINUATION_TITLE, isContinuation: false }),
        false
    );
});

test("the rename API refuses it before writing, and the page says why", () => {
    const route = code("app/api/conversations/[conversationId]/route.ts");
    const refusal = route.indexOf("isReservedContinuationTitle({");
    const write = route.indexOf("updateData.title = title;");
    assert.ok(refusal > 0 && refusal < write);
    assert.match(route, /isContinuation: existingConv\.continuationBridge !== null/);
    assert.match(route, /code: "CONVERSATION_TITLE_RESERVED"/);

    const client = code("app/(site)/(application)/chat/ChatPageClient.tsx");
    assert.match(client, /code === "CONVERSATION_TITLE_RESERVED"\s*\?\s*"chat\.chatRenameReserved"/);
});

/* --------------------------------------------------------- request shape */

test("preserve ids are parsed, deduplicated, validated and capped", () => {
    const url = new URL(
        `https://tomverse.test/x?${PRESERVE_TITLES_PARAM}=b,a,a,,bad%20id&${PRESERVE_TITLES_PARAM}=c`
    );
    assert.deepEqual(readTitlePreservationRequest(url), ["b", "a", "c"]);
    const many = Array.from({ length: 150 }, (_, i) => `id${i}`).join(",");
    assert.equal(
        readTitlePreservationRequest(new URL(`https://tomverse.test/x?${PRESERVE_TITLES_PARAM}=${many}`)).length,
        100
    );
    assert.deepEqual(readTitlePreservationRequest(new URL("https://tomverse.test/x")), []);
});

test("the title preview is opt-in", () => {
    assert.equal(wantsTitleImpact(new URL("https://t.test/?include=memoryImpact,titleImpact")), true);
    assert.equal(wantsTitleImpact(new URL("https://t.test/?include=memoryImpact")), false);
});

test("both confirmations send the same query", () => {
    assert.equal(
        sourceDeletionQuery({ keepMemories: false, preserveTitleConversationIds: [] }),
        "derivedMemories=delete"
    );
    assert.equal(
        sourceDeletionQuery({ keepMemories: true, preserveTitleConversationIds: ["a", "b"] }),
        "derivedMemories=suspend&preserveTitles=a%2Cb"
    );
    for (const path of [
        "components/imports/ExternalImportManagement.tsx",
        "components/imports/ExternalConversationViewer.tsx",
    ]) {
        const source = code(path);
        assert.match(source, /sourceDeletionQuery\(\{/, path);
        // Keeping titles is off until the owner ticks it.
        assert.match(source, /const \[keepTitles, setKeepTitles\] = useState\(false\)/, path);
        assert.match(source, /preserveTitleConversationIds: keepTitles\s*\?/, path);
        assert.match(source, /isStaleTitlePreservation\(response\)/, path);
    }
});

test("a stale refusal is recognised by its code, and bodies are consumed", async () => {
    const json = (status, body) =>
        new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    assert.equal(
        await isStaleTitlePreservation(json(409, { code: SOURCE_TITLE_PRESERVATION_STALE })),
        true
    );
    assert.equal(await isStaleTitlePreservation(json(409, { code: "OTHER" })), false);
    const ok = json(200, { outcome: "deleted" });
    assert.equal(await isStaleTitlePreservation(ok), false);
    assert.equal(ok.bodyUsed, true);
});

/* ---------------------------------------------------------------- judging */

test("preservability names each reason a title cannot be kept", () => {
    assert.equal(titlePreservability(target()), "preservable");
    assert.equal(titlePreservability(target({ conversationTitle: "사업 계획" })), "named");
    assert.equal(titlePreservability(target({ conversationLocked: true })), "conversation_locked");
    assert.equal(titlePreservability(target({ sourceLocked: true })), "source_locked");
    for (const sourceTitle of [null, "", "   ", LEGACY_CONTINUATION_TITLE, "x".repeat(121)]) {
        assert.equal(
            titlePreservability(target({ sourceTitle })),
            "source_title_unusable",
            JSON.stringify(sourceTitle)
        );
    }
    assert.equal(titlePreservability(target({ sourceTitle: "x".repeat(120) })), "preservable");
});

test("the preview counts changing names and preservable ones separately", () => {
    const impact = summarizeTitleImpact([
        target({ conversationId: "c3" }),
        target({ conversationId: "c1" }),
        target({ conversationId: "c2", sourceLocked: true }),
        target({ conversationId: "c4", conversationTitle: "이미 이름 있음" }),
    ]);
    assert.deepEqual(impact, { changingCount: 3, preservableConversationIds: ["c1", "c3"] });
    // No title is part of the preview.
    assert.doesNotMatch(JSON.stringify(impact), /여행/);
});

test("judging skips what is out of scope or renamed, and refuses what went stale", () => {
    const targets = [
        target({ conversationId: "c1" }),
        target({ conversationId: "c2", conversationTitle: "renamed meanwhile" }),
    ];
    assert.deepEqual(judgeTitlePreservation(["c2", "c1", "not-mine"], targets), {
        kind: "accepted",
        writes: [{ conversationId: "c1", title: "여행 계획" }],
    });
    for (const change of [
        { conversationLocked: true },
        { sourceLocked: true },
        { sourceTitle: "" },
    ]) {
        assert.deepEqual(
            judgeTitlePreservation(["c1"], [target({ conversationId: "c1", ...change })]),
            { kind: "refused", reason: "stale" },
            JSON.stringify(change)
        );
    }
});

test("a trimmed source title is what gets saved", () => {
    const judgement = judgeTitlePreservation(["c1"], [target({ conversationId: "c1", sourceTitle: "  여행 계획 " })]);
    assert.deepEqual(judgement.writes, [{ conversationId: "c1", title: "여행 계획" }]);
});

/* ------------------------------------------------------ transaction order */

test("both deletions judge and keep titles after their locks and before any other write", () => {
    const service = code("lib/externalImportService.ts");
    for (const name of ["deleteExternalConversationSnapshot", "deleteExternalImport"]) {
        const start = service.indexOf(`export async function ${name}(`);
        const body = service.slice(start, service.indexOf("\nexport ", start + 1));
        const keep = body.indexOf("preserveContinuationTitles(");
        assert.ok(keep > 0, `${name} keeps titles`);
        const lock = Math.max(
            body.indexOf("lockSnapshotForDeletion("),
            body.indexOf("lockImportSnapshotsForDeletion(")
        );
        assert.ok(lock > 0 && lock < keep, `${name}: locks first`);
        for (const write of ["applySourceDeletionToMemories(", "markContinuationSourcesDeleted("]) {
            assert.ok(keep < body.indexOf(write), `${name}: titles before ${write}`);
        }
    }

    const helperStart = service.indexOf("async function preserveContinuationTitles(");
    const helper = service.slice(helperStart, service.indexOf("\nexport ", helperStart));
    const conversationLock = helper.indexOf('FROM "Conversation" WHERE "userId" = ${userId} AND id IN');
    const judge = helper.indexOf("judgeTitlePreservation(");
    const update = helper.indexOf("tx.conversation.updateMany(");
    assert.ok(conversationLock > 0 && conversationLock < judge && judge < update);
    assert.match(helper, /ORDER BY id FOR UPDATE/);
    assert.match(helper, /title: LEGACY_CONTINUATION_TITLE,/);
    assert.match(helper, /updated\.count !== 1/);
});

test("both delete routes pass the request through, and both previews are opt-in", () => {
    for (const path of [
        "app/api/imports/external/[importId]/route.ts",
        "app/api/external-conversations/[conversationId]/route.ts",
    ]) {
        const source = code(path);
        assert.match(source, /readTitlePreservationRequest\(url\)/, path);
        assert.match(source, /wantsTitleImpact\(/, path);
        assert.match(source, /previewContinuationTitleImpact\(/, path);
    }
});
