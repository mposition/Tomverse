import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { geminiAdapter } from "../lib/externalImportAdapters/gemini.ts";
import {
    detectExternalImportAdapter,
    EXTERNAL_IMPORT_ADAPTERS,
} from "../lib/externalImportAdapters/index.ts";
import { buildImportPreview, parseConversationItems } from "../lib/externalImportPipeline.ts";

// docs/policy/external-import-gemini-a2.md §2.2, §3.1, §4, §4.1, §5.
//
// Driven by tests/fixtures/geminiTakeout, whose structure was checked against
// a real export and whose every value is synthetic (see
// tests/geminiTakeoutFixture.test.mjs). Both locale payloads are run through
// the same assertions: a rule that keyed on a translated string would pass for
// one and fail for the other, which is the point of having two.

const FIXTURES = new URL("./fixtures/geminiTakeout/", import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));

const KO = load("activity-ko.json");
const EN = load("activity-en.json");
const LAYOUT = load("archive-layout.json");
const LOCALES = [
    ["ko", KO],
    ["en", EN],
];

const parse = (items) => geminiAdapter.parseAll(items);
const byId = (result, id) =>
    result.conversations.find((c) => c.rawExternalConversationId === id);

/* ------------------------------------------------------------- detection - */

test("an export is recognised by its shape, in either locale", () => {
    for (const [name, items] of LOCALES) {
        assert.equal(geminiAdapter.detect(items), true, `${name} must be detected`);
        assert.equal(
            detectExternalImportAdapter(items)?.provider,
            "gemini",
            `${name} must route to the Gemini adapter`
        );
    }
});

test("detection survives an entry that carries no chat link", () => {
    // A real export had two such entries. Reading only the first entry would
    // make detection depend on where they happen to land in the file.
    const orphanFirst = [...KO].sort((a, b) => (a.details ? 1 : 0) - (b.details ? 1 : 0));
    assert.equal(orphanFirst[0].details, undefined);
    assert.equal(geminiAdapter.detect(orphanFirst), true);
});

test("detection does not fire on the other providers' exports", () => {
    const chatgpt = [{ mapping: {}, title: "x", create_time: 1 }];
    const claude = [{ uuid: "c", name: "x", chat_messages: [] }];
    assert.equal(geminiAdapter.detect(chatgpt), false);
    assert.equal(geminiAdapter.detect(claude), false);
    assert.equal(geminiAdapter.detect([]), false);
    assert.equal(geminiAdapter.detect({ conversations: [] }), false);
});

test("no rule keys on a translated string", () => {
    // §3.1: `header`, `products`, `activityControls` and every subtitle are
    // localised. Only the chat URL is the same everywhere, so the two locale
    // payloads must produce identical conversations.
    const ko = parse(KO);
    const en = parse(EN);
    const shape = (result) =>
        result.conversations
            .map((c) => `${c.rawExternalConversationId}:${c.messages.length}`)
            .sort();
    assert.deepEqual(shape(ko), shape(en));
    assert.deepEqual(ko.extras.unassignedTurns, en.extras.unassignedTurns);
    assert.deepEqual(
        [...ko.extras.attachmentReferences].sort(),
        [...en.extras.attachmentReferences].sort()
    );
});

/* --------------------------------------------------------------- grouping - */

test("turns are grouped into conversations by the chat the export names", () => {
    const result = parse(KO);
    // Five chats, and the orphan entry is in none of them.
    assert.equal(result.conversations.length, 5);
    assert.equal(result.extras.unassignedTurns, 1);
});

test("a branched turn is stored in every branch it belongs to", () => {
    // §2.2, the decision this adapter exists to implement. The shared opening
    // turns appear in all four branches; keeping only the longest would drop
    // whatever lives on a shorter one.
    const result = parse(KO);
    const openingPrompt = KO.find((e) => (e.details ?? []).length === 4).title;
    const carrying = result.conversations.filter((c) =>
        c.messages.some((m) => m.role === "user" && m.content === openingPrompt)
    );
    assert.equal(carrying.length, 4);
});

test("messages are ordered by time, not by position in the file", () => {
    // The measured export was not globally sorted, and per-chat order in it
    // was newest-first. A parser trusting file order builds the conversation
    // backwards.
    for (const conversation of parse(KO).conversations) {
        const stamps = conversation.messages.map((m) => m.sourceTimestamp);
        assert.deepEqual(stamps, [...stamps].sort());
        assert.deepEqual(
            conversation.messages.map((m) => m.ordinal),
            conversation.messages.map((_, index) => index)
        );
    }
});

test("an entry becomes one user message and one assistant message", () => {
    const result = parse(KO);
    for (const conversation of result.conversations) {
        // Every fixture entry carries an answer, so the roles alternate and
        // the message count is twice the turn count.
        assert.equal(conversation.messages.length % 2, 0);
        assert.deepEqual(
            conversation.messages.map((m) => m.role),
            conversation.messages.map((_, i) => (i % 2 === 0 ? "user" : "assistant"))
        );
    }
    // The prompt is stored verbatim; the answer arrives as HTML and is stored
    // as Markdown, because that is what the product renders.
    const answers = result.conversations.flatMap((c) =>
        c.messages.filter((m) => m.role === "assistant")
    );
    assert.ok(answers.length > 0);
    assert.ok(!answers.some((m) => /<\/?(p|strong|table|pre)\b/.test(m.content)));
});

/* ------------------------------------------------------------- identity --- */

test("identity comes from the provider's chat id, never a position or a length", () => {
    // §2.2 items 1 and 2. Reordering the file and adding a whole new branch
    // must leave every existing id untouched: an id that moves makes a
    // re-import a different lineage.
    const before = parse(KO);
    const reordered = parse([...KO].reverse());
    const idsOf = (result) =>
        result.conversations
            .flatMap((c) => c.messages.map((m) => m.rawExternalMessageId))
            .sort();
    assert.deepEqual(idsOf(reordered), idsOf(before));

    const withNewBranch = parse([
        ...KO,
        {
            ...KO.find((e) => (e.details ?? []).length === 4),
            details: [
                {
                    name: "https://gemini.google.com/app/f60718293041526a",
                    url: "https://gemini.google.com/app/f60718293041526a",
                },
            ],
        },
    ]);
    for (const id of idsOf(before)) {
        assert.ok(idsOf(withNewBranch).includes(id), `${id} must survive a new branch`);
    }
});

test("a turn that shows up earlier does not renumber the ones after it", () => {
    // The case a position-based id fails and file-order shuffling does not.
    // Two exports of the same account need not contain the same turns: one may
    // predate a deletion, or Takeout may simply include more. If identity
    // counted position within the conversation, every turn after the newcomer
    // would land as a fresh message and the account would hold both copies.
    const target = KO.find((e) => (e.details ?? []).length === 1 && e.safeHtmlItem);
    const chatId = /app\/([0-9a-f]+)$/.exec(target.details[0].url)[1];
    const idsFor = (items) =>
        new Map(
            byId(parse(items), chatId).messages.map((m) => [
                m.rawExternalMessageId,
                m.content,
            ])
        );

    const before = idsFor(KO);
    const withEarlier = idsFor([
        ...KO,
        {
            ...target,
            title: "이 대화의 더 이른 질문입니다.",
            // Earlier than every existing turn in this chat.
            time: "2026-01-01T00:00:00.000Z",
        },
    ]);

    assert.equal(withEarlier.size, before.size + 2);
    // What matters is the pairing, not the presence: a positional id survives
    // as a *string* while sliding onto a different message, which is the
    // failure that would silently duplicate an account's history.
    for (const [id, content] of before) {
        assert.equal(
            withEarlier.get(id),
            content,
            `${id} must still name the same message after an earlier turn arrives`
        );
    }
});

test("the same shared turn gets a different id in each branch", () => {
    // Scoping message ids to the conversation is what keeps four copies of a
    // shared turn from collapsing into one, or being judged duplicates.
    const result = parse(KO);
    const opening = KO.find((e) => (e.details ?? []).length === 4);
    const ids = result.conversations
        .flatMap((c) => c.messages)
        .filter((m) => m.role === "user" && m.content === opening.title)
        .map((m) => m.rawExternalMessageId);
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4);
});

test("re-parsing the same export produces the same ids", () => {
    const first = parse(KO);
    const second = parse(KO);
    assert.deepEqual(
        first.conversations.map((c) => c.messages.map((m) => m.rawExternalMessageId)),
        second.conversations.map((c) => c.messages.map((m) => m.rawExternalMessageId))
    );
});

/* --------------------------------------------------------------- counts --- */

test("shared messages are counted, because they are stored once per branch", () => {
    const preview = buildImportPreview("gemini", parse(KO).conversations);
    assert.ok(
        preview.totals.duplicatedBranchMessages > 0,
        "the preview has to say what branching costs"
    );
    // Every counted message really is in the stored set: the count is about
    // what the user is about to pay for, not a hypothetical.
    assert.ok(preview.totals.duplicatedBranchMessages <= preview.totals.messages);
});

test("attachments are counted and never copied, and the archive says which are missing", () => {
    // §4.1: what we chose not to copy and what Google did not include are two
    // different facts, and only the caller holding the listing knows the second.
    const result = parse(KO);
    assert.ok(result.extras.attachmentReferences.length > 0);
    for (const missing of LAYOUT.missingAttachments) {
        assert.ok(result.extras.attachmentReferences.includes(missing));
    }
    const absent = result.extras.attachmentReferences.filter(
        (name) => !LAYOUT.siblingFiles.includes(name)
    );
    assert.deepEqual(absent, LAYOUT.missingAttachments);

    const preview = buildImportPreview("gemini", result.conversations, {
        missingAttachments: absent.length,
    });
    assert.equal(preview.totals.missingAttachments, LAYOUT.missingAttachments.length);
    assert.ok(preview.totals.skippedNonTextParts >= result.extras.attachmentReferences.length);
});

test("an entry the export assigns to no conversation is reported, not placed", () => {
    // §2 forbids inferring a conversation from timing, so the only honest
    // outcome is a count.
    const result = parse(KO);
    assert.equal(result.extras.unassignedTurns, 1);
    const orphan = KO.find((entry) => !entry.details);
    for (const conversation of result.conversations) {
        assert.ok(
            !conversation.messages.some((m) => m.content === orphan.title),
            "an unassigned turn must not be attached to a neighbour"
        );
    }
    const preview = buildImportPreview("gemini", result.conversations, {
        unassignedTurns: result.extras.unassignedTurns,
    });
    assert.equal(preview.totals.unassignedTurns, 1);
});

test("an answer whose markup we cannot render is dropped and counted", () => {
    // §5: a half-converted answer is worse than a counted absence. The prompt
    // is plain text and is understood, so it stays.
    const entry = KO.find((e) => (e.details ?? []).length === 1 && e.safeHtmlItem);
    const result = parse([
        { ...entry, safeHtmlItem: [{ html: "<p>fine</p><video src='x'></video>" }] },
    ]);
    assert.equal(result.conversations.length, 1);
    const [conversation] = result.conversations;
    assert.deepEqual(
        conversation.messages.map((m) => m.role),
        ["user"]
    );
    assert.equal(conversation.warnings.skippedUnrecognizedContent, 1);
});

/* ------------------------------------------------------------ conversation */

test("the title is the opening prompt, shortened, since the export has none", () => {
    // Takeout gives conversations no title. Gemini's own list shows the
    // opening prompt, and this is a label only -- the prompt is stored once,
    // as the first message, so nothing is counted twice.
    const result = parse(KO);
    for (const conversation of result.conversations) {
        const first = conversation.messages[0];
        assert.equal(first.role, "user");
        assert.ok(conversation.title.length > 0);
        assert.ok(
            first.content.startsWith(conversation.title.replace(/…$/, "")),
            `${conversation.title} must come from the opening prompt`
        );
    }

    const long = "가".repeat(300);
    const [only] = parse([
        {
            title: long,
            time: "2026-03-01T00:00:00.000Z",
            details: [
                {
                    name: "https://gemini.google.com/app/aaaaaaaaaaaaaaaa",
                    url: "https://gemini.google.com/app/aaaaaaaaaaaaaaaa",
                },
            ],
            safeHtmlItem: [{ html: "<p>ok</p>" }],
        },
    ]).conversations;
    assert.ok(only.title.length < 100, "a long prompt is shortened for the label");
    assert.equal(only.messages[0].content, long, "but the message keeps all of it");
});

test("timestamps bound the conversation", () => {
    for (const conversation of parse(KO).conversations) {
        assert.equal(conversation.sourceCreatedAt, conversation.messages[0].sourceTimestamp);
        assert.equal(
            conversation.sourceUpdatedAt,
            conversation.messages[conversation.messages.length - 1].sourceTimestamp
        );
        // Takeout records no model per turn; claiming one would be an invention.
        assert.deepEqual(conversation.sourceModelLabels, []);
        assert.ok(conversation.messages.every((m) => m.sourceModelLabel === null));
    }
});

/* ------------------------------------------------------------- refusals --- */

test("a malformed entry is counted, and does not take the export with it", () => {
    const result = parse([
        ...KO,
        null,
        "not an object",
        { title: "no time", details: [] },
        { time: "2026-03-01T00:00:00.000Z" },
    ]);
    assert.equal(result.unparsableCount, 4);
    assert.equal(result.conversations.length, 5);
});

test("a Gem is not a conversation", () => {
    // §4: a Gem is an instruction, and storing one as a message is what §5.6
    // forbids. Only the chat link makes a conversation, so a subtitle naming a
    // Gem contributes nothing on its own.
    const gemOnly = [
        {
            header: "Gemini 앱",
            title: "회의록 초안을 정리해 주세요.",
            time: "2026-03-01T09:00:00.000Z",
            products: ["Gemini 앱"],
            subtitles: [
                {
                    name: "이 채팅에 회의 정리 도우미이 사용되었습니다. Gem을 관리하세요.",
                    url: "https://gemini.google.com/gems/view",
                },
            ],
            activityControls: ["Gemini 앱 활동"],
        },
    ];
    assert.equal(geminiAdapter.detect(gemOnly), false);
    const result = parse(gemOnly);
    assert.deepEqual(result.conversations, []);
    assert.equal(result.extras.unassignedTurns, 1);
});

/* ------------------------------------------------------------ integration - */

test("the pipeline routes a Gemini export through parseAll", () => {
    // parseConversation() cannot serve this provider: one entry is a turn, and
    // a turn is not a conversation. The pipeline has to pick the whole-export
    // path or every entry looks unparsable.
    assert.equal(geminiAdapter.parseConversation(KO[0]), null);
    const viaPipeline = parseConversationItems("gemini", KO);
    assert.equal(viaPipeline.conversations.length, 5);
    assert.equal(viaPipeline.extras.unassignedTurns, 1);
});

test("the adapter is registered, and the other adapters still answer for theirs", () => {
    assert.ok(EXTERNAL_IMPORT_ADAPTERS.some((a) => a.provider === "gemini"));
    const claude = [{ uuid: "c", name: "x", chat_messages: [{ sender: "human", text: "hi" }] }];
    assert.equal(detectExternalImportAdapter(claude)?.provider, "claude");
});
