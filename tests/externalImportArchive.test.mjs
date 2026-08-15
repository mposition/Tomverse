import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ExternalImportArchiveError,
    classifyArchiveEntry,
    planArchiveEntries,
    readArchiveEntryItems,
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

test("traversal, absolute paths and encrypted entries are refused", () => {
    // `kind` is asserted alongside `reason` on purpose: a decision keeps its
    // reason when it moves between refusing and skipping, so a test that reads
    // only the reason cannot tell the two apart. That is how the nested-archive
    // change below went unnoticed by this file until it was looked for.
    assert.deepEqual(decisionFor("../../etc/passwd.json"), {
        kind: "reject",
        reason: "path_traversal",
    });
    assert.deepEqual(decisionFor("a/../../b/conversations.json"), {
        kind: "reject",
        reason: "path_traversal",
    });
    assert.deepEqual(decisionFor("/etc/shadow.json"), {
        kind: "reject",
        reason: "absolute_path",
    });
    assert.deepEqual(decisionFor("C:\\Windows\\x.json"), {
        kind: "reject",
        reason: "absolute_path",
    });
    assert.deepEqual(decisionFor("conversations.json", 1_000, { encrypted: true }), {
        kind: "reject",
        reason: "encrypted",
    });
});

test("a nested archive is skipped, never opened and never refused", () => {
    // §5.2, decided 2026-08-14. Extraction depth stays 0 — the entry is not
    // opened, enumerated or inspected — but it no longer refuses the export it
    // arrived in. A real Google Takeout carries one whenever the user attached
    // a .zip to a chat, and refusing the entry refused the whole export.
    assert.deepEqual(decisionFor("inner.zip"), {
        kind: "skip",
        reason: "nested_archive",
    });
    assert.deepEqual(decisionFor("bundle.tgz"), {
        kind: "skip",
        reason: "nested_archive",
    });
});

test("a nested archive does not stop the conversation payload being parsed", () => {
    // The case that motivated the change: an ordinary export with an attached
    // archive beside the payload.
    const plan = planArchiveEntries(
        [
            entry("Takeout/My Activity/Gemini Apps/attachment-1.zip", 5_000),
            entry("conversations.json", 2_000),
            entry("Takeout/My Activity/Gemini Apps/photo.jpg", 900_000),
        ],
        { archiveBytes: 1_000_000 }
    );
    assert.deepEqual(
        plan.parse.map((planned) => planned.entry.name),
        ["conversations.json"],
        "the nested archive must never reach the parse list"
    );
    assert.equal(plan.skipped.nested_archive, 1);
    assert.equal(
        plan.skipped.unsupported_extension,
        0,
        "it must be counted under its own reason, not folded into another"
    );
});

test("an HTML export says so, instead of reading as unreadable", () => {
    // §6 / A2 §6: Takeout offers My Activity as JSON or HTML and only JSON is
    // supported. This is the one failure the user can fix in a minute, so it
    // has to be told apart from an export we simply could not read.
    assert.throws(
        () =>
            planArchiveEntries(
                [
                    entry("Takeout/My Activity/Gemini Apps/MyActivity.html", 40_000),
                    entry("Takeout/My Activity/Gemini Apps/photo.jpg", 900_000),
                ],
                { archiveBytes: 1_000_000 }
            ),
        (error) =>
            error instanceof ExternalImportArchiveError &&
            error.reason === "html_export_unsupported"
    );

    // Detected by extension, never by a path segment: Takeout translates the
    // directory and the filename to the account's language, so a Korean
    // export's `내 활동/Gemini 앱/내활동.html` has to reach the same answer.
    assert.throws(
        () =>
            planArchiveEntries(
                [entry("Takeout/내 활동/Gemini 앱/내활동.html", 40_000)],
                { archiveBytes: 100_000 }
            ),
        (error) => error.reason === "html_export_unsupported"
    );
});

test("HTML beside a readable payload changes nothing", () => {
    // Every ChatGPT export ships chat.html next to conversations.json. The
    // HTML reason is only for an export with nothing else to read.
    const plan = planArchiveEntries(
        [entry("chat.html", 40_000), entry("conversations.json", 2_000)],
        { archiveBytes: 100_000 }
    );
    assert.deepEqual(
        plan.parse.map((planned) => planned.entry.name),
        ["conversations.json"]
    );
});

test("an archive of nothing but nested archives has no conversation data", () => {
    // Skipping is not the same as accepting: with the payload gone, the export
    // is still refused — with the reason that says what is actually wrong.
    assert.throws(
        () =>
            planArchiveEntries(
                [entry("one.zip", 5_000), entry("two.tar", 5_000)],
                { archiveBytes: 20_000 }
            ),
        (error) =>
            error instanceof ExternalImportArchiveError &&
            error.reason === "no_conversation_data"
    );
});

test("a nested archive does not soften the refusals around it", () => {
    // Each of these still refuses the whole archive, and the nested entry
    // beside them changes nothing.
    for (const bad of [
        entry("../../etc/passwd.json"),
        entry("/etc/shadow.json"),
        entry("conversations.json", 1_000, { encrypted: true }),
    ]) {
        assert.throws(
            () =>
                planArchiveEntries([entry("attachment.zip", 5_000), bad], {
                    archiveBytes: 100_000,
                }),
            ExternalImportArchiveError,
            `${bad.name} must still refuse the archive`
        );
    }
});

test("the container and entry-count limits are unchanged by the skip", () => {
    assert.throws(
        () =>
            planArchiveEntries([entry("conversations.json", 1_000)], {
                archiveBytes:
                    EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxArchiveContainerBytes + 1,
            }),
        (error) => error.reason === "archive_too_large"
    );
    const tooMany = Array.from(
        { length: EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS.maxArchiveEntries + 1 },
        (_, index) => entry(`attachment-${index}.zip`, 10)
    );
    assert.throws(
        () => planArchiveEntries(tooMany, { archiveBytes: 1_000_000 }),
        (error) => error.reason === "too_many_entries"
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

/**
 * A real Claude export, 2026-08, could not be imported at all.
 *
 * Its entries:
 *
 *     conversations.json                      3,051,381 bytes
 *     users.json                                    142
 *     memories.json                               4,444
 *     login_history.json                          6,766
 *     projects/<uuid>.json                       19,351
 *     reflections/<uuid>.json                     3,856
 *
 * Only the first is in `CONVERSATION_FILENAMES`; the metadata skip list names
 * `user.json`, singular, so even that one misses. The other six are opened as
 * candidates, several hold a JSON object rather than an array, and the worker
 * spread the parsed value straight into an array. `push(...{})` throws a bare
 * TypeError, which is none of the typed archive errors, so the whole import
 * ended as `unreadable_archive` — "this file cannot be read" — while three
 * megabytes of readable conversations sat in the same archive.
 *
 * The fix is not a longer filename list. That list will lag every export
 * format change the same way. It is that a candidate is allowed to fail.
 */

const CLAUDE_EXPORT_2026_08 = [
    ["conversations.json", 3_051_381],
    ["users.json", 142],
    ["memories.json", 4_444],
    ["login_history.json", 6_766],
    ["projects/019f7d0c-a3b0-701c-9cfd-db291b34935e.json", 19_351],
    ["reflections/e5538b34-4a60-441e-884e-ba80625a9476.json", 3_856],
];

test("the Claude export that failed still classifies one payload and five candidates", () => {
    // Pinning the classification the fix is built on. If a later change moves
    // any of these to `skip`, the isolation below stops being what protects
    // this export and the next reader should know that from here.
    const roles = CLAUDE_EXPORT_2026_08.map(([name, bytes]) => {
        const decision = decisionFor(name, bytes);
        return [name, decision.kind === "parse" ? decision.role : decision.kind];
    });
    assert.deepEqual(roles, [
        ["conversations.json", "conversations"],
        ["users.json", "candidate"],
        ["memories.json", "candidate"],
        ["login_history.json", "candidate"],
        ["projects/019f7d0c-a3b0-701c-9cfd-db291b34935e.json", "candidate"],
        ["reflections/e5538b34-4a60-441e-884e-ba80625a9476.json", "candidate"],
    ]);
});

test("a candidate holding an object is abandoned, not fatal", () => {
    // The exact shape that killed the import: a single JSON object.
    assert.deepEqual(
        readArchiveEntryItems('{"uuid":"p1","name":"a project"}', "candidate"),
        { skipped: true }
    );
});

test("a candidate that is not JSON at all is abandoned too", () => {
    // An entry named `.json` is not a promise about its bytes.
    assert.deepEqual(readArchiveEntryItems("not json", "candidate"), {
        skipped: true,
    });
    assert.deepEqual(readArchiveEntryItems("", "candidate"), { skipped: true });
});

test("the authoritative conversations entry still fails closed on an object", () => {
    // Fail-closed is kept exactly where it belongs. An import whose payload
    // will not parse has nothing to import, and must say so rather than
    // quietly producing zero conversations.
    assert.throws(
        () => readArchiveEntryItems('{"not":"an array"}', "conversations"),
        (error) =>
            error instanceof ExternalImportArchiveError &&
            error.reason === "no_conversation_data"
    );
});

test("the authoritative conversations entry still fails closed on malformed JSON", () => {
    assert.throws(
        () => readArchiveEntryItems("{oops", "conversations"),
        (error) => error instanceof SyntaxError
    );
});

test("a valid array is returned for either role", () => {
    for (const role of ["conversations", "candidate"]) {
        assert.deepEqual(readArchiveEntryItems('[{"uuid":"c1"}]', role), {
            items: [{ uuid: "c1" }],
        });
    }
});

test("candidate isolation does not reach archive safety refusals", () => {
    // The role only decides what happens to a *parse* failure. Traversal,
    // encryption, nested archives and the size budgets are refused before any
    // entry is opened, and nothing here softens them.
    for (const [name, extra, reason] of [
        ["../escape.json", {}, "path_traversal"],
        ["/abs.json", {}, "absolute_path"],
        ["secret.json", { encrypted: true }, "encrypted"],
    ]) {
        const decision = decisionFor(name, 1_000, extra);
        assert.equal(decision.kind, "reject", name);
        assert.equal(decision.reason, reason);
    }
});
