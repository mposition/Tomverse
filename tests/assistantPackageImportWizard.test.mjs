// The import wizard's rules, decided without a browser (Slice 4).
//
// docs/policy/assistant-package-import.md §5.
//
// The two that matter most here are the ones a screenshot cannot show: that
// steps 1 to 6 write nothing and the wizard knows exactly where that stops
// being true, and that a credential finding blocks the import until the owner
// has actually said something about it.

import assert from "node:assert/strict";
import test from "node:test";

import {
    ASSISTANT_PACKAGE_IMPORT_STEPS,
    FIRST_SERVER_WRITE_STEP,
    IMPORT_FIELDS,
    IMPORT_STEP_COUNT,
    advanceProblems,
    assistantPackageImportReducer as reduce,
    canAdvance,
    canGoBack,
    importStepNumber,
    initialImportState,
    resolveImportDraft,
    stepWritesToServer,
    unwaivedFindings,
} from "../lib/assistantPackageImportWizard.ts";
import { ASSISTANT_PACKAGE_LIMITS } from "../lib/assistantPackageLimits.ts";
import { ASSISTANT_PROFILE_LIMITS } from "../lib/assistantProfileVersioning.ts";

const proposed = (value, disposition = "automatic") => ({
    value,
    disposition,
    note: null,
});

const review = (overrides = {}) => ({
    kind: "agent-skill",
    adapterVersion: "assistant-package-v1",
    identity: {
        name: proposed("code-reviewer", "needs_review"),
        icon: proposed(null),
        description: proposed("Reviews diffs."),
    },
    instructions: proposed("Read the diff.", "needs_review"),
    starters: proposed([]),
    modelIds: proposed([], "needs_review"),
    toolPolicy: proposed({ webSearch: false, deepResearch: false }),
    memoryPolicy: proposed({ useAccountMemory: false }),
    knowledgeCandidates: [],
    losses: [],
    skips: [],
    instructionUrls: { count: 0, hosts: [] },
    secretFindings: [],
    declaredProvenance: null,
    ...overrides,
});

const finding = (offset = 4) => ({
    ruleId: "github-token",
    source: "instructions",
    offset,
    matchDigest: "a".repeat(64),
});

/** A state parked on `step`, with a package parsed and a model chosen. */
const at = (step, overrides = {}) => ({
    ...initialImportState(),
    step,
    file: { name: "skill.zip", bytes: 1024 },
    parse: { kind: "parsed" },
    review: review(),
    edits: { modelIds: ["gpt-5-6-luna"] },
    ...overrides,
});

const blockKinds = (state) => advanceProblems(state).map((block) => block.kind);

/* ------------------------------------------------------------ the boundary */

test("there are eight steps and they are numbered for a person", () => {
    assert.equal(IMPORT_STEP_COUNT, 8);
    assert.equal(ASSISTANT_PACKAGE_IMPORT_STEPS.length, 8);
    assert.equal(importStepNumber("source"), 1);
    assert.equal(importStepNumber("confirm"), 8);
});

test("nothing before step 7 writes to the server, and step 7 does", () => {
    // The cancellation contract rests on this line being in one place: before
    // it there is nothing to undo, after it there is.
    assert.equal(FIRST_SERVER_WRITE_STEP, "upload");
    for (const step of ["source", "detect", "inventory", "fields", "losses", "target"]) {
        assert.equal(stepWritesToServer(step), false, step);
    }
    for (const step of ["upload", "confirm"]) {
        assert.equal(stepWritesToServer(step), true, step);
    }
});

test("back is available while nothing is written and not after", () => {
    assert.equal(canGoBack(at("source")), false);
    assert.equal(canGoBack(at("fields")), true);
    assert.equal(canGoBack(at("target")), true);
    // A plain back here would abandon a staged upload with nothing pointing
    // at it; leaving from step 7 is its own contract.
    assert.equal(canGoBack(at("upload")), false);
    assert.equal(canGoBack(at("confirm")), false);
});

test("advancing is refused while a step is blocked", () => {
    const blocked = at("target", { target: null });
    assert.equal(reduce(blocked, { type: "advanced" }).step, "target");
    const ready = reduce(
        reduce(blocked, { type: "target_chosen", target: { kind: "new" } }),
        { type: "upload_acknowledged" }
    );
    assert.equal(reduce(ready, { type: "advanced" }).step, "upload");
});

/* ------------------------------------------------------------------ source */

test("a package must be chosen and parsed before anything else", () => {
    assert.deepEqual(blockKinds(initialImportState()), ["no_file"]);
    const chosen = reduce(initialImportState(), {
        type: "file_selected",
        file: { name: "skill.zip", bytes: 10 },
    });
    assert.deepEqual(blockKinds(chosen), ["parsing"]);
});

test("choosing another file starts over rather than reusing the decisions", () => {
    // One package's field choices applied to another's fields would be a
    // silent mismatch, and the fields are what the owner is approving.
    const decided = reduce(at("fields"), {
        type: "field_decided",
        field: "description",
        decision: "exclude",
    });
    const restarted = reduce(decided, {
        type: "file_selected",
        file: { name: "other.zip", bytes: 20 },
    });
    assert.equal(restarted.step, "source");
    assert.equal(restarted.review, null);
    assert.equal(restarted.decisions.description, "use");
});

test("a parsed package selects every knowledge candidate to begin with", () => {
    const parsed = reduce(initialImportState(), {
        type: "parse_succeeded",
        review: review({
            knowledgeCandidates: [
                { path: "a.md", name: "a.md", bytes: 1, digest: "sha256:a", scannedAsText: true },
                { path: "b.md", name: "b.md", bytes: 1, digest: "sha256:b", scannedAsText: true },
            ],
        }),
    });
    assert.equal(parsed.step, "detect");
    assert.deepEqual(parsed.knowledgeSelection, ["a.md", "b.md"]);
});

test("a refused package cannot be advanced past detection", () => {
    const refused = reduce(initialImportState(), {
        type: "parse_refused",
        code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
        cause: "no_manifest_or_skill_document",
    });
    assert.equal(refused.step, "detect");
    assert.deepEqual(blockKinds(refused), ["package_refused"]);
});

/* ------------------------------------------------------------ A5: secrets */

test("a credential finding blocks the import until it is waived", () => {
    const found = at("inventory", { review: review({ secretFindings: [finding()] }) });
    assert.deepEqual(blockKinds(found), ["unwaived_secret"]);
    assert.equal(unwaivedFindings(found).length, 1);

    const waived = reduce(found, { type: "secret_waived", finding: finding() });
    assert.equal(canAdvance(waived), true);

    const reinstated = reduce(waived, { type: "secret_unwaived", finding: finding() });
    assert.deepEqual(blockKinds(reinstated), ["unwaived_secret"]);
});

test("waiving one finding does not waive another at a different position", () => {
    // Two occurrences of the same credential are two decisions: the owner may
    // recognise one as a placeholder and not the other.
    const found = at("inventory", {
        review: review({ secretFindings: [finding(4), finding(80)] }),
    });
    const partly = reduce(found, { type: "secret_waived", finding: finding(4) });
    assert.equal(unwaivedFindings(partly).length, 1);
    assert.deepEqual(blockKinds(partly), ["unwaived_secret"]);
});

test("waiving the same finding twice is not two waivers", () => {
    const state = reduce(
        reduce(at("inventory"), { type: "secret_waived", finding: finding() }),
        { type: "secret_waived", finding: finding() }
    );
    assert.equal(state.secretWaivers.length, 1);
});

/* --------------------------------------------------------------- knowledge */

test("knowledge selection can be toggled and stops at the limit", () => {
    const candidates = Array.from(
        { length: ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles },
        (_, index) => `${index}.md`
    );
    let state = at("inventory", { knowledgeSelection: candidates });
    const dropped = reduce(state, { type: "knowledge_toggled", path: "0.md" });
    assert.equal(dropped.knowledgeSelection.includes("0.md"), false);

    // Adding an eleventh is refused, and refusing it must not quietly remove
    // somebody else's file to make room.
    state = reduce(state, { type: "knowledge_toggled", path: "extra.md" });
    assert.deepEqual(state.knowledgeSelection, candidates);
});

/* ------------------------------------------------------------------ fields */

test("a field that cannot be excluded refuses the exclusion", () => {
    for (const field of IMPORT_FIELDS.filter((entry) => !entry.excludable)) {
        const state = reduce(at("fields"), {
            type: "field_decided",
            field: field.key,
            decision: "exclude",
        });
        assert.notEqual(state.decisions[field.key], "exclude", field.key);
    }
});

test("excluding a field yields the profile's default, not the package's value", () => {
    const excluded = reduce(at("fields"), {
        type: "field_decided",
        field: "description",
        decision: "exclude",
    });
    assert.equal(resolveImportDraft(excluded).description, null);
    assert.equal(resolveImportDraft(at("fields")).description, "Reviews diffs.");
});

test("choosing edit without typing anything keeps what was proposed", () => {
    const editing = reduce(at("fields"), {
        type: "field_decided",
        field: "instructions",
        decision: "edit",
    });
    assert.equal(resolveImportDraft(editing).instructions, "Read the diff.");
    const typed = reduce(editing, {
        type: "field_edited",
        edits: { instructions: "Read it twice." },
    });
    assert.equal(resolveImportDraft(typed).instructions, "Read it twice.");
});

test("the profile's own validation decides the fields step", () => {
    // Not restated here: a wizard that accepts a draft the editor rejects is
    // a wizard that sends the owner forward to fail at publish.
    const noModel = at("fields", { edits: {} });
    assert.deepEqual(blockKinds(noModel), ["invalid_draft"]);
    assert.equal(advanceProblems(noModel)[0].problem.field, "modelIds");

    const tooLong = at("fields", {
        edits: {
            modelIds: ["gpt-5-6-luna"],
            instructions: "x".repeat(
                ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters + 1
            ),
        },
        decisions: { ...initialImportState().decisions, instructions: "edit" },
    });
    assert.equal(advanceProblems(tooLong)[0].problem.field, "instructions");

    assert.equal(canAdvance(at("fields")), true);
});

test("a name of only whitespace is empty by the time it is stored", () => {
    const blank = at("fields", {
        decisions: { ...initialImportState().decisions, name: "edit" },
        edits: { modelIds: ["gpt-5-6-luna"], name: "   " },
    });
    assert.equal(advanceProblems(blank)[0].problem.field, "name");
});

test("more models than a profile may name is refused here too", () => {
    const many = at("fields", {
        edits: {
            modelIds: Array.from(
                { length: ASSISTANT_PROFILE_LIMITS.maxModels + 1 },
                (_, index) => `model-${index}`
            ),
        },
    });
    assert.equal(advanceProblems(many)[0].problem.field, "modelIds");
});

/* ------------------------------------------------------------------ losses */

test("a loss report must be acknowledged, and an empty one need not be", () => {
    const withLosses = at("losses", {
        review: review({ losses: [{ kind: "scripts", detail: "1 file." }] }),
    });
    assert.deepEqual(blockKinds(withLosses), ["losses_unacknowledged"]);
    assert.equal(
        canAdvance(reduce(withLosses, { type: "losses_acknowledged", acknowledged: true })),
        true
    );
    assert.equal(canAdvance(at("losses")), true);
});

/* ------------------------------------------------------------------ target */

test("the target step needs a target and an explicit yes to uploading", () => {
    const chosen = reduce(at("target"), {
        type: "target_chosen",
        target: { kind: "merge", profileId: "p1", expectedRevision: 3 },
    });
    assert.deepEqual(blockKinds(chosen), ["upload_unacknowledged"]);
    assert.equal(
        canAdvance(reduce(chosen, { type: "upload_acknowledged" })),
        true
    );
    assert.deepEqual(blockKinds(at("target")), ["no_target", "upload_unacknowledged"]);
});

test("restarting returns to an untouched first step", () => {
    const state = reduce(at("target"), { type: "restarted" });
    assert.deepEqual(state, initialImportState());
});
