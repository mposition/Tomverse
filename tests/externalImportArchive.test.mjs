import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ExternalImportArchiveError,
    classifyArchiveEntry,
    planArchiveEntries,
    requiresStreamingParse,
} from "../lib/externalImportArchive.ts";
import { EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS } from "../lib/externalImportLimits.ts";

// docs/policy/external-conversation-import-and-memory.md §5.1–§5.2.

const entry = (name, uncompressedBytes = 1_000, extra = {}) => ({
    name,
    uncompressedBytes,
    ...extra,
});

const decisionFor = (name, uncompressedBytes, extra) =>
    classifyArchiveEntry(entry(name, uncompressedBytes, extra));

test("the conversation payload is what gets parsed", () => {
    assert.deepEqual(decisionFor("conversations.json"), {
        kind: "parse",
        role: "conversations",
    });
    assert.deepEqual(decisionFor("export/2026/conversations.json"), {
        kind: "parse",
        role: "conversations",
    });
    // Layouts move between export versions, so an unrecognised JSON stays a
    // candidate rather than being dropped on a filename guess.
    assert.deepEqual(decisionFor("some/other/payload.json"), {
        kind: "parse",
        role: "candidate",
    });
});

test("media is skipped without being inflated", () => {
    for (const name of [
        "dalle-generations/img.png",
        "audio/voice.mp3",
        "video/clip.mp4",
        "attachments/scan.pdf",
    ]) {
        const decision = decisionFor(name, 900 * 1024 * 1024);
        assert.deepEqual(
            decision,
            { kind: "skip", reason: "media" },
            `${name} must be skipped even at 900MB`
        );
    }
});

test("known metadata files are skipped, directories too", () => {
    assert.equal(decisionFor("user.json").reason, "metadata");
    assert.equal(decisionFor("message_feedback.json").reason, "metadata");
    assert.equal(decisionFor("shared_conversations.json").reason, "metadata");
    assert.equal(decisionFor("chat/").reason, "directory");
    assert.equal(decisionFor("notes.txt").reason, "unsupported_extension");
    assert.equal(decisionFor("empty.json", 0).reason, "empty");
});

test("traversal, absolute paths and nested archives are refused", () => {
    assert.equal(decisionFor("../../etc/passwd.json").reason, "path_traversal");
    assert.equal(decisionFor("a/../../b/conversations.json").reason, "path_traversal");
    assert.equal(decisionFor("/etc/shadow.json").reason, "absolute_path");
    assert.equal(decisionFor("C:\\Windows\\x.json").reason, "absolute_path");
    assert.equal(decisionFor("inner.zip").reason, "nested_archive");
    assert.equal(decisionFor("bundle.tgz").reason, "nested_archive");
    assert.equal(
        decisionFor("conversations.json", 1_000, { encrypted: true }).reason,
        "encrypted"
    );
});

test("a filename that merely contains '..' is not treated as traversal", () => {
    // Rejecting on a substring would refuse legitimate names; only a whole
    // path segment equal to ".." is traversal.
    assert.equal(decisionFor("my..notes/conversations.json").role, "conversations");
});

test("inflate budgets apply only to entries that would be inflated", () => {
    const oversized = decisionFor(
        "conversations.json",
        EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxParsedEntryBytes + 1
    );
    assert.equal(oversized.reason, "entry_too_large");

    const bomb = classifyArchiveEntry(
        entry("conversations.json", 100 * 1024 * 1024, { compressedBytes: 1_000 })
    );
    assert.equal(bomb.reason, "suspicious_compression_ratio");

    // The same ratio on a media entry never matters: it is not inflated.
    const mediaBomb = classifyArchiveEntry(
        entry("img.png", 100 * 1024 * 1024, { compressedBytes: 1_000 })
    );
    assert.deepEqual(mediaBomb, { kind: "skip", reason: "media" });
});

test("a media-heavy archive still imports its conversation file", () => {
    // The case the policy calls out: a real export is mostly images. Gating
    // on total archive size would reject exactly the heaviest users.
    const entries = [
        entry("conversations.json", 5 * 1024 * 1024, { compressedBytes: 500_000 }),
        ...Array.from({ length: 300 }, (_, index) =>
            entry(`dalle-generations/img-${index}.png`, 2 * 1024 * 1024)
        ),
    ];
    const plan = planArchiveEntries(entries, {
        archiveBytes: 700 * 1024 * 1024,
    });
    assert.equal(plan.parse.length, 1);
    assert.equal(plan.parse[0].role, "conversations");
    assert.equal(plan.skipped.media, 300);
    assert.equal(plan.skippedMediaBytes, 300 * 2 * 1024 * 1024);
});

test("the conversation payload is planned before other candidates", () => {
    const plan = planArchiveEntries(
        [entry("zzz-other.json"), entry("conversations.json")],
        { archiveBytes: 10_000 }
    );
    assert.equal(plan.parse[0].role, "conversations");
});

test("archive-level limits are enforced before any entry work", () => {
    assert.throws(
        () =>
            planArchiveEntries([entry("conversations.json")], {
                archiveBytes:
                    EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxArchiveContainerBytes +
                    1,
            }),
        (error) =>
            error instanceof ExternalImportArchiveError &&
            error.reason === "archive_too_large"
    );

    assert.throws(
        () =>
            planArchiveEntries(
                Array.from(
                    {
                        length:
                            EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxArchiveEntries +
                            1,
                    },
                    (_, index) => entry(`img-${index}.png`)
                ),
                { archiveBytes: 1_000 }
            ),
        (error) =>
            error instanceof ExternalImportArchiveError &&
            error.reason === "too_many_entries"
    );
});

test("the cumulative parse budget is enforced across entries", () => {
    const each = 60 * 1024 * 1024;
    const count =
        Math.ceil(
            EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxParsedTextTotalBytes / each
        ) + 1;
    assert.throws(
        () =>
            planArchiveEntries(
                Array.from({ length: count }, (_, index) =>
                    entry(`part-${index}.json`, each)
                ),
                { archiveBytes: 900 * 1024 * 1024 }
            ),
        (error) =>
            error instanceof ExternalImportArchiveError &&
            error.reason === "parsed_budget_exceeded"
    );
});

test("a hostile entry fails the archive rather than being skipped", () => {
    assert.throws(
        () =>
            planArchiveEntries(
                [entry("conversations.json"), entry("../escape.json")],
                { archiveBytes: 10_000 }
            ),
        (error) =>
            error instanceof ExternalImportArchiveError &&
            error.reason === "path_traversal"
    );
});

test("an archive with nothing parseable is reported, not silently empty", () => {
    assert.throws(
        () =>
            planArchiveEntries([entry("img.png"), entry("readme.txt")], {
                archiveBytes: 10_000,
            }),
        (error) =>
            error instanceof ExternalImportArchiveError &&
            error.reason === "no_conversation_data"
    );
});

test("the streaming threshold matches the policy's 16MB", () => {
    assert.equal(
        requiresStreamingParse(entry("conversations.json", 16 * 1024 * 1024)),
        false
    );
    assert.equal(
        requiresStreamingParse(entry("conversations.json", 16 * 1024 * 1024 + 1)),
        true
    );
});
