import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// docs/policy/external-import-gemini-a2.md §2.2, §3.1, §4.1, §5, §9.
//
// The A2 parser does not exist yet, and this file is what makes it safe to
// write one: it holds the fixture to the shape of a real Google Takeout so a
// parser proved against the fixture is proved against something.
//
// The fixture is synthetic. A real export was measured on 2026-08-14 to learn
// the structure and was never committed -- it carried a business plan, source
// code, work email drafts and 91 photographs, and git history is permanent.
// What survives that measurement is the structural signature asserted here.
//
// Each case below is a way a parser can be wrong while its own tests stay
// green, which is why they are pinned in the fixture rather than left to
// whoever writes the parser to remember.

const FIXTURE_DIR = new URL("./fixtures/geminiTakeout/", import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8"));

const ko = load("activity-ko.json");
const en = load("activity-en.json");
const layout = load("archive-layout.json");

const CHAT_URL = /^https:\/\/gemini\.google\.com\/app\/([0-9a-f]{16})$/;

/** The chat IDs one activity entry belongs to. A branched turn belongs to several. */
const chatIdsOf = (entry) =>
    new Set(
        (entry.details ?? [])
            .map((detail) => CHAT_URL.exec(detail.url)?.[1])
            .filter(Boolean)
    );

/** Entry indices per chat ID, which is what makes branch relationships visible. */
const membership = (entries) => {
    const byChat = new Map();
    entries.forEach((entry, index) => {
        for (const id of chatIdsOf(entry)) {
            if (!byChat.has(id)) byChat.set(id, new Set());
            byChat.get(id).add(index);
        }
    });
    return byChat;
};

const isSubset = (a, b) => a.size < b.size && [...a].every((value) => b.has(value));
const intersects = (a, b) => [...a].some((value) => b.has(value));

/** Every leaf path with its type: two payloads with the same signature agree. */
const signature = (value, path = "", into = new Set()) => {
    if (Array.isArray(value)) {
        for (const item of value) signature(item, `${path}[]`, into);
    } else if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) signature(item, `${path}.${key}`, into);
    } else {
        into.add(`${path}:${typeof value}`);
    }
    return into;
};

test("an activity entry is one user turn and one assistant turn", () => {
    // `title` is the whole prompt, not a preview of it, and the answer arrives
    // as rendered HTML. A parser that stored the title separately would count
    // the same text twice against the user's quota.
    for (const entry of ko) {
        assert.equal(typeof entry.title, "string");
        assert.ok(entry.title.length > 0);
        assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        for (const item of entry.safeHtmlItem ?? []) {
            assert.equal(typeof item.html, "string");
        }
    }
});

test("a branched turn belongs to more than one conversation", () => {
    // The finding that changed the design: in the measured export 231 of 819
    // entries carried between two and four chat IDs. A parser that assumes one
    // entry means one conversation silently drops every branch.
    const widest = Math.max(...ko.map((entry) => chatIdsOf(entry).size));
    assert.ok(widest >= 4, `the fixture must exercise a multi-branch turn, saw ${widest}`);
});

test("the fixture carries nested branches and crossing ones", () => {
    // Two different shapes, and a parser can handle one while breaking on the
    // other. Nested: a branch that is a prefix of a longer chat. Crossing: two
    // chats that share a prefix and then diverge, so neither contains the other.
    const byChat = [...membership(ko).values()];
    const nested = byChat.some((a) => byChat.some((b) => isSubset(a, b)));
    const crossing = byChat.some((a) =>
        byChat.some((b) => a !== b && intersects(a, b) && !isSubset(a, b) && !isSubset(b, a))
    );
    assert.ok(nested, "no nested branch pair in the fixture");
    assert.ok(crossing, "no crossing branch pair in the fixture");
});

test("an entry the export does not assign to any chat is present", () => {
    // Two such entries existed in the measured export. §5: they are neither
    // dropped nor attached to a neighbouring conversation by proximity.
    const orphans = ko.filter((entry) => chatIdsOf(entry).size === 0);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].details, undefined);
});

test("an attachment can be referenced without being in the archive", () => {
    // 37 of 183 references were absent from the measured export, so this is
    // the normal case rather than a corrupt-archive case. §4.1 counts it
    // separately from what we chose to skip.
    const referenced = ko.flatMap((entry) => entry.attachedFiles ?? []);
    assert.ok(referenced.length > 0);
    for (const missing of layout.missingAttachments) {
        assert.ok(referenced.includes(missing), `${missing} must be referenced`);
        assert.ok(
            !layout.siblingFiles.includes(missing),
            `${missing} must not also be present in the archive`
        );
    }
    const present = referenced.filter((name) => layout.siblingFiles.includes(name));
    assert.ok(present.length > 0, "the fixture also needs an attachment that resolves");
});

test("the archive contains a nested archive, because real exports do", () => {
    // §3.2: a user attaching a .zip is what makes today's planner refuse the
    // whole export. The fixture keeps that entry so the decision cannot be
    // implemented around without meeting it.
    assert.ok(layout.siblingFiles.some((name) => name.endsWith(".zip")));
});

test("nothing may be recognised by a translated string", () => {
    // §3.1: the path and every label inside the payload are translated to the
    // account's language. The two locale payloads differ in exactly those
    // strings and in nothing structural, so a rule that keys on one of them
    // passes for one locale and fails for the other.
    assert.equal(ko.length, en.length);
    assert.deepEqual([...signature(ko)].sort(), [...signature(en)].sort());
    assert.notEqual(layout.ko.activityPath, layout.en.activityPath);
    for (const locale of [layout.ko, layout.en]) {
        assert.match(locale.activityPath, /^Takeout\//);
    }

    // The chat link is the one thing that is the same in both, which is why
    // recognition is by content shape.
    const chatIds = (entries) => entries.map((entry) => [...chatIdsOf(entry)].sort().join(","));
    assert.deepEqual(chatIds(ko), chatIds(en));
});

test("entry order in the file is not the conversation order", () => {
    // The measured export was not globally sorted, so a parser that trusts
    // file order builds conversations with their turns out of sequence.
    const times = ko.map((entry) => entry.time);
    assert.notDeepEqual(times, [...times].sort());
    assert.notDeepEqual(times, [...times].sort().reverse());
});

test("a Gem is named as a subtitle and is not a message", () => {
    // §4: storing it as a system turn is what §5.6 forbids. It is detected by
    // the link, never by the sentence wrapped around it.
    const gemLinks = ko.flatMap((entry) =>
        (entry.subtitles ?? []).filter((subtitle) =>
            subtitle.url?.startsWith("https://gemini.google.com/gems/")
        )
    );
    assert.ok(gemLinks.length > 0);
});
