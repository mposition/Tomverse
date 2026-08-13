// Release C1: what a profile version snapshot promises.
//
// The three properties under test are the ones §14 and §43 make contractual,
// and each is a thing that degrades silently if it breaks: a published version
// that can be edited, a stale editor that wins, and a manifest that appears to
// still have a deleted file. None of those produce an error at the time --
// they produce a profile whose history is wrong, discovered much later.

import assert from "node:assert/strict";
import test from "node:test";

import {
    ASSISTANT_PROFILE_LIMITS,
    ASSISTANT_PROFILE_VERSION_STALE,
    normalizeProfileIdentity,
    normalizeProfileVersionDraft,
    planProfileVersionPublish,
    profileIdentityProblems,
    profileVersionProblems,
    resolveKnowledgeManifest,
} from "../lib/assistantProfileVersioning.ts";

const draft = (overrides = {}) => ({
    instructions: "Answer in Korean, and prefer short examples.",
    modelIds: ["gpt-5-6-luna"],
    toolPolicy: { webSearch: false, deepResearch: false },
    memoryPolicy: { useAccountMemory: true },
    starters: ["오늘 일정 정리해줘"],
    knowledgeManifest: [],
    ...overrides,
});

const publishedState = (revision, content) => ({
    currentRevision: revision,
    currentDraft: content,
});

/* ------------------------------------------------- a first publication */

test("a profile with no version publishes revision 1", () => {
    const plan = planProfileVersionPublish({
        state: { currentRevision: null, currentDraft: null },
        draft: draft(),
        expectedRevision: null,
    });
    assert.equal(plan.outcome, "publish");
    assert.equal(plan.revision, 1);
});

test("an edit publishes the next revision rather than changing the current one", () => {
    // The plan never carries a version id, because there is no shape of return
    // value here that could express "update the row you already have".
    const plan = planProfileVersionPublish({
        state: publishedState(4, draft()),
        draft: draft({ instructions: "Answer in Korean, with longer examples." }),
        expectedRevision: 4,
    });
    assert.equal(plan.outcome, "publish");
    assert.equal(plan.revision, 5);
});

/* ------------------------------------------------------ a stale editor */

test("publishing from a revision that is no longer current is refused", () => {
    const plan = planProfileVersionPublish({
        state: publishedState(6, draft()),
        draft: draft({ instructions: "Something else entirely." }),
        expectedRevision: 4,
    });
    assert.equal(plan.outcome, "stale");
    assert.equal(plan.code, ASSISTANT_PROFILE_VERSION_STALE);
    assert.equal(plan.currentRevision, 6);
});

test("staleness is decided before validity", () => {
    // A stale editor's content is not worth reporting on: the user has to
    // re-read and redo the edit regardless, and two errors for one cause is
    // how a client ends up showing the wrong one.
    const plan = planProfileVersionPublish({
        state: publishedState(2, draft()),
        draft: draft({ modelIds: [] }),
        expectedRevision: 1,
    });
    assert.equal(plan.outcome, "stale");
});

test("claiming a revision on a profile that has none is stale, not a first publish", () => {
    const plan = planProfileVersionPublish({
        state: { currentRevision: null, currentDraft: null },
        draft: draft(),
        expectedRevision: 3,
    });
    assert.equal(plan.outcome, "stale");
    assert.equal(plan.currentRevision, 0);
});

/* ------------------------------------------------- no-op republication */

test("republishing identical content creates no revision", () => {
    const plan = planProfileVersionPublish({
        state: publishedState(3, draft()),
        draft: draft(),
        expectedRevision: 3,
    });
    assert.equal(plan.outcome, "unchanged");
    assert.equal(plan.revision, 3);
});

test("whitespace and line endings alone are not an edit", () => {
    // Otherwise "Save" from a different editor publishes a revision that
    // changed nothing, and every one of those is a snapshot a conversation
    // could pin to.
    const plan = planProfileVersionPublish({
        state: publishedState(1, draft({ instructions: "Line one\nLine two" })),
        draft: draft({ instructions: "  Line one\r\nLine two  " }),
        expectedRevision: 1,
    });
    assert.equal(plan.outcome, "unchanged");
});

test("reordering the knowledge manifest is not an edit, but changing a digest is", () => {
    const entries = [
        { fileId: "f-b", name: "b.pdf", digest: "22" },
        { fileId: "f-a", name: "a.pdf", digest: "11" },
    ];
    const stored = draft({ knowledgeManifest: entries });
    assert.equal(
        planProfileVersionPublish({
            state: publishedState(1, stored),
            draft: draft({ knowledgeManifest: [...entries].reverse() }),
            expectedRevision: 1,
        }).outcome,
        "unchanged"
    );
    assert.equal(
        planProfileVersionPublish({
            state: publishedState(1, stored),
            draft: draft({
                knowledgeManifest: [
                    { fileId: "f-a", name: "a.pdf", digest: "11" },
                    { fileId: "f-b", name: "b.pdf", digest: "different" },
                ],
            }),
            expectedRevision: 1,
        }).outcome,
        "publish"
    );
});

test("reordering models IS an edit", () => {
    // The first model is the profile's default, so the order carries meaning
    // that the manifest's order does not.
    const plan = planProfileVersionPublish({
        state: publishedState(1, draft({ modelIds: ["a", "b"] })),
        draft: draft({ modelIds: ["b", "a"] }),
        expectedRevision: 1,
    });
    assert.equal(plan.outcome, "publish");
});

/* ---------------------------------------------------------- validation */

test("a version must name at least one model and at most the limit", () => {
    assert.deepEqual(
        planProfileVersionPublish({
            state: { currentRevision: null, currentDraft: null },
            draft: draft({ modelIds: [] }),
            expectedRevision: null,
        }).outcome,
        "invalid"
    );
    const tooMany = Array.from(
        { length: ASSISTANT_PROFILE_LIMITS.maxModels + 1 },
        (_, index) => `model-${index}`
    );
    assert.equal(
        profileVersionProblems(
            normalizeProfileVersionDraft(draft({ modelIds: tooMany }))
        ).some((problem) => problem.field === "modelIds"),
        true
    );
});

test("duplicate model ids collapse rather than counting toward the limit", () => {
    const normalized = normalizeProfileVersionDraft(
        draft({ modelIds: ["a", "a", " a ", "b"] })
    );
    assert.deepEqual(normalized.modelIds, ["a", "b"]);
});

test("the same file listed twice in a manifest is refused", () => {
    const problems = profileVersionProblems(
        normalizeProfileVersionDraft(
            draft({
                knowledgeManifest: [
                    { fileId: "f-a", name: "a.pdf", digest: "11" },
                    { fileId: "f-a", name: "a again.pdf", digest: "11" },
                ],
            })
        )
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0].reason, /twice/);
});

test("an icon may not carry a URL", () => {
    // Rendering a profile list must not become a request to a host the icon
    // names. Each of these is a different way to write one.
    for (const icon of [
        "https://example.invalid/a.png",
        "//example.invalid/a.png",
        "data:image/png;base64,AAAA",
        "/uploads/a.png",
    ]) {
        const problems = profileIdentityProblems(
            normalizeProfileIdentity({ name: "Helper", icon, description: null })
        );
        assert.equal(
            problems.some((problem) => problem.field === "icon"),
            true,
            `${icon} was accepted as an icon`
        );
    }
    assert.deepEqual(
        profileIdentityProblems(
            normalizeProfileIdentity({ name: "Helper", icon: "🧭", description: null })
        ),
        []
    );
});

test("an empty name is refused and an empty icon becomes absent", () => {
    const identity = normalizeProfileIdentity({
        name: "   ",
        icon: "  ",
        description: "  ",
    });
    assert.equal(identity.icon, null);
    assert.equal(identity.description, null);
    assert.equal(
        profileIdentityProblems(identity).some((p) => p.field === "name"),
        true
    );
});

/* --------------------------------------------------- knowledge manifest */

test("a manifest entry whose file is gone is unavailable, never substituted", () => {
    const manifest = [
        { fileId: "f-kept", name: "kept.pdf", digest: "11" },
        { fileId: "f-deleted", name: "deleted.pdf", digest: "22" },
    ];
    const resolved = resolveKnowledgeManifest(manifest, [
        { fileId: "f-kept", digest: "11", processed: true },
    ]);
    assert.equal(resolved.availableCount, 1);
    assert.equal(resolved.unavailableCount, 1);
    // The deleted entry is still listed, and still named: a past version has
    // to be able to say *which* file is gone.
    assert.equal(resolved.entries[1].available, false);
    assert.equal(resolved.entries[1].name, "deleted.pdf");
});

test("a re-upload of the same bytes under a new id does not restore an entry", () => {
    const resolved = resolveKnowledgeManifest(
        [{ fileId: "f-old", name: "a.pdf", digest: "11" }],
        [{ fileId: "f-new", digest: "11", processed: true }]
    );
    assert.equal(resolved.availableCount, 0);
});

test("a file whose digest changed is unavailable rather than updated", () => {
    const resolved = resolveKnowledgeManifest(
        [{ fileId: "f-a", name: "a.pdf", digest: "11" }],
        [{ fileId: "f-a", digest: "rewritten", processed: true }]
    );
    assert.equal(resolved.entries[0].available, false);
});

test("a file still processing has nothing to retrieve from", () => {
    const resolved = resolveKnowledgeManifest(
        [{ fileId: "f-a", name: "a.pdf", digest: "11" }],
        [{ fileId: "f-a", digest: "11", processed: false }]
    );
    assert.equal(resolved.entries[0].available, false);
});
