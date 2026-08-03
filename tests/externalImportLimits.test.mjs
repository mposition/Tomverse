import assert from "node:assert/strict";
import { test } from "node:test";
import {
    EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS,
    EXTERNAL_IMPORT_STORAGE_LIMITS,
    EXTERNAL_IMPORT_TRUNCATION_MARKER,
    computeExternalImportExpiries,
    countCodePoints,
    planExternalMessageTruncation,
    truncateExternalMessageContent,
    utf8ByteLength,
} from "../lib/externalImportLimits.ts";

// docs/policy/external-conversation-import-and-memory.md §5.2–§5.4. The
// numbers themselves are policy decisions — a change here must first change
// the approved policy document.

test("server-authoritative storage limits match the approved policy", () => {
    assert.equal(
        EXTERNAL_IMPORT_STORAGE_LIMITS.maxNormalizedTextBytesPerAccount,
        50 * 1024 * 1024
    );
    assert.equal(
        EXTERNAL_IMPORT_STORAGE_LIMITS.maxExternalConversationsPerAccount,
        2_000
    );
    assert.equal(
        EXTERNAL_IMPORT_STORAGE_LIMITS.maxExternalMessagesPerAccount,
        100_000
    );
    assert.equal(
        EXTERNAL_IMPORT_STORAGE_LIMITS.maxStoredMessageCodePoints,
        100_000
    );
    assert.equal(
        EXTERNAL_IMPORT_STORAGE_LIMITS.maxInboundMessageCodePoints,
        1_000_000
    );
    assert.equal(
        EXTERNAL_IMPORT_STORAGE_LIMITS.stagingIdleTtlMs,
        24 * 60 * 60 * 1000
    );
    assert.equal(
        EXTERNAL_IMPORT_STORAGE_LIMITS.stagingAbsoluteMaxLifetimeMs,
        72 * 60 * 60 * 1000
    );
});

test("client archive safety limits match the approved policy", () => {
    assert.equal(
        EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxArchiveContainerBytes,
        1024 * 1024 * 1024
    );
    assert.equal(EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxArchiveEntries, 50_000);
    assert.equal(EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxNestedArchiveDepth, 0);
    assert.equal(
        EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxParsedEntryBytes,
        250 * 1024 * 1024
    );
    assert.equal(
        EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxParsedTextTotalBytes,
        300 * 1024 * 1024
    );
    assert.equal(
        EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxParsedEntryCompressionRatio,
        100
    );
    assert.equal(
        EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxSyncJsonParseBytes,
        16 * 1024 * 1024
    );
});

test("code points and UTF-8 bytes are counted per contract", () => {
    assert.equal(countCodePoints("abc"), 3);
    assert.equal(countCodePoints("한글"), 2);
    assert.equal(countCodePoints("👍"), 1); // one code point, two UTF-16 units
    assert.equal(utf8ByteLength("a"), 1);
    assert.equal(utf8ByteLength("한"), 3);
    assert.equal(utf8ByteLength("👍"), 4);
});

test("messages at or under the stored cap are stored verbatim", () => {
    assert.deepEqual(planExternalMessageTruncation(0), {
        kind: "store_verbatim",
    });
    assert.deepEqual(
        planExternalMessageTruncation(
            EXTERNAL_IMPORT_STORAGE_LIMITS.maxStoredMessageCodePoints
        ),
        { kind: "store_verbatim" }
    );
});

test("messages between the caps require truncation that fits the stored cap", () => {
    const plan = planExternalMessageTruncation(
        EXTERNAL_IMPORT_STORAGE_LIMITS.maxStoredMessageCodePoints + 1
    );
    assert.equal(plan.kind, "requires_truncation");
    const markerCodePoints = countCodePoints(EXTERNAL_IMPORT_TRUNCATION_MARKER);
    assert.equal(
        plan.headCodePoints + plan.tailCodePoints + markerCodePoints,
        EXTERNAL_IMPORT_STORAGE_LIMITS.maxStoredMessageCodePoints
    );
    // §5.4: about 75% head, 25% tail.
    const retained = plan.headCodePoints + plan.tailCodePoints;
    assert.ok(Math.abs(plan.headCodePoints / retained - 0.75) < 0.01);
});

test("messages beyond the inbound hard limit are not truncatable", () => {
    assert.deepEqual(
        planExternalMessageTruncation(
            EXTERNAL_IMPORT_STORAGE_LIMITS.maxInboundMessageCodePoints + 1
        ),
        { kind: "exceeds_inbound_limit" }
    );
});

test("planning rejects invalid counts", () => {
    assert.throws(() => planExternalMessageTruncation(-1));
    assert.throws(() => planExternalMessageTruncation(1.5));
});

test("truncation preserves code point boundaries and the stored cap", () => {
    const limits = {
        maxStoredMessageCodePoints: 1_000,
        maxInboundMessageCodePoints: 10_000,
    };
    // Surrogate pairs throughout: a split inside one would produce a lone
    // surrogate and an ill-formed string.
    const content = "👍".repeat(1_500);
    const plan = planExternalMessageTruncation(
        countCodePoints(content),
        limits
    );
    assert.equal(plan.kind, "requires_truncation");
    const result = truncateExternalMessageContent(content, plan);

    assert.ok(result.content.isWellFormed());
    assert.equal(
        countCodePoints(result.content),
        limits.maxStoredMessageCodePoints
    );
    assert.equal(
        result.retainedCharacterCount,
        limits.maxStoredMessageCodePoints
    );
    assert.ok(result.content.includes(EXTERNAL_IMPORT_TRUNCATION_MARKER));
    assert.ok(result.content.startsWith("👍"));
    assert.ok(result.content.endsWith("👍"));
});

test("truncation output is deterministic for preview/server parity", () => {
    // §5.4: the worker preview and the server re-validation must agree
    // byte-for-byte on what the user approved.
    const limits = {
        maxStoredMessageCodePoints: 500,
        maxInboundMessageCodePoints: 10_000,
    };
    const content = "가나다라마바사".repeat(200);
    const plan = planExternalMessageTruncation(
        countCodePoints(content),
        limits
    );
    assert.equal(plan.kind, "requires_truncation");
    const first = truncateExternalMessageContent(content, plan);
    const second = truncateExternalMessageContent(content, plan);
    assert.equal(first.content, second.content);
});

test("the quota decision is all-or-nothing arithmetic over every axis", async () => {
    const { externalImportQuotaExceeded } = await import(
        "../lib/externalImportLimits.ts"
    );
    const limits = {
        maxNormalizedTextBytesPerAccount: 100,
        maxExternalConversationsPerAccount: 2,
        maxExternalMessagesPerAccount: 10,
    };
    const usage = { conversations: 1, messages: 5, bytes: 50 };
    const fits = { conversations: 1, messages: 5, bytes: 50 };
    assert.equal(externalImportQuotaExceeded(usage, fits, limits), false);
    assert.equal(
        externalImportQuotaExceeded(
            usage,
            { ...fits, conversations: 2 },
            limits
        ),
        true
    );
    assert.equal(
        externalImportQuotaExceeded(usage, { ...fits, messages: 6 }, limits),
        true
    );
    assert.equal(
        externalImportQuotaExceeded(usage, { ...fits, bytes: 51 }, limits),
        true
    );
});

test("the rollout flag fails closed on any value but the explicit opt-in", async () => {
    const { externalImportEnabledFromValue } = await import(
        "../lib/externalImportAccess.ts"
    );
    assert.equal(externalImportEnabledFromValue("true"), true);
    assert.equal(externalImportEnabledFromValue("false"), false);
    assert.equal(externalImportEnabledFromValue(""), false);
    assert.equal(externalImportEnabledFromValue("TRUE"), false);
    assert.equal(externalImportEnabledFromValue(null), false);
    assert.equal(externalImportEnabledFromValue(undefined), false);
});

/**
 * §5.5 staging TTLs. Both open statuses (`staging` and `preview_ready`) run on
 * the same two clocks, and the effective deadline is whichever comes first —
 * so a long-lived import expires on its absolute lifetime even while it is
 * being touched, and an idle one expires well before that.
 */
test("the effective expiry is the earlier of the idle and absolute deadlines", () => {
    const createdAt = new Date("2026-08-01T00:00:00.000Z");

    // Freshly touched, hours old: the 24h idle clock is still further out
    // than nothing, but the 72h absolute clock is further still.
    const active = computeExternalImportExpiries({
        createdAt,
        updatedAt: new Date("2026-08-01T02:00:00.000Z"),
    });
    assert.equal(active.idleExpiresAt, "2026-08-02T02:00:00.000Z");
    assert.equal(active.absoluteExpiresAt, "2026-08-04T00:00:00.000Z");
    assert.equal(active.effectiveExpiresAt, active.idleExpiresAt);

    // Touched at the very end of its life: the absolute deadline wins, so
    // continued activity cannot extend the import indefinitely.
    const elderly = computeExternalImportExpiries({
        createdAt,
        updatedAt: new Date("2026-08-03T23:00:00.000Z"),
    });
    assert.equal(elderly.effectiveExpiresAt, elderly.absoluteExpiresAt);
    assert.equal(elderly.effectiveExpiresAt, "2026-08-04T00:00:00.000Z");
});
