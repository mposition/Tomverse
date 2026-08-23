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
    importApprovalPayload,
    importStepNumber,
    initialImportState,
    keepFileIds,
    resolveImportDraft,
    stepWritesToServer,
    unwaivedFindings,
} from "../lib/assistantPackageImportWizard.ts";
import {
    ASSISTANT_PACKAGE_KNOWLEDGE_EXTENSIONS,
    ASSISTANT_PACKAGE_LIMITS,
} from "../lib/assistantPackageLimits.ts";
import { knowledgeMimeForExtension } from "../lib/assistantKnowledgeLimits.ts";
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
        target: { kind: "merge", profileId: "p1" },
    });
    assert.deepEqual(blockKinds(chosen), ["upload_unacknowledged"]);
    assert.equal(
        canAdvance(reduce(chosen, { type: "upload_acknowledged" })),
        true
    );
    assert.deepEqual(blockKinds(at("target")), ["no_target", "upload_unacknowledged"]);
});

test("a merge target carries the profile id and nothing else", () => {
    // The revision to publish from is deliberately absent: the server reads
    // the target's own revision when the import is created and checks it again
    // at publish, so a copy held here could only ever be the stale one.
    const chosen = reduce(at("target"), {
        type: "target_chosen",
        target: { kind: "merge", profileId: "p1" },
    });
    assert.deepEqual(chosen.target, { kind: "merge", profileId: "p1" });
});

test("changing the target takes back the boundary acknowledgement", () => {
    // The box says what continuing stores, and that is a different sentence
    // for a create than for a merge. Keeping the tick across a change would
    // record an agreement to text the owner never saw.
    const acknowledged = reduce(
        reduce(at("target"), { type: "target_chosen", target: { kind: "new" } }),
        { type: "upload_acknowledged" }
    );
    assert.equal(acknowledged.uploadAcknowledged, true);
    const merged = reduce(acknowledged, {
        type: "target_chosen",
        target: { kind: "merge", profileId: "p1" },
    });
    assert.equal(merged.uploadAcknowledged, false);
    assert.deepEqual(blockKinds(merged), ["upload_unacknowledged"]);
});

test("re-choosing the target already chosen keeps the acknowledgement", () => {
    // A radio that is already checked does not fire a change, so this is not
    // a path a click takes -- but a reducer that cleared on every dispatch
    // would make a re-render of the same choice look like a new one.
    const ready = reduce(
        reduce(at("target"), {
            type: "target_chosen",
            target: { kind: "merge", profileId: "p1" },
        }),
        { type: "upload_acknowledged" }
    );
    const again = reduce(ready, {
        type: "target_chosen",
        target: { kind: "merge", profileId: "p1" },
    });
    assert.equal(again.uploadAcknowledged, true);
});

test("choosing a different target replaces the previous one", () => {
    // One radio group on screen, so two targets can never both be chosen --
    // but the state has to say so as well, or a merge left behind by an
    // earlier click would be sent alongside a create.
    const merged = reduce(at("target"), {
        type: "target_chosen",
        target: { kind: "merge", profileId: "p1" },
    });
    const other = reduce(merged, {
        type: "target_chosen",
        target: { kind: "merge", profileId: "p2" },
    });
    assert.deepEqual(other.target, { kind: "merge", profileId: "p2" });
    const back = reduce(other, { type: "target_chosen", target: { kind: "new" } });
    assert.deepEqual(back.target, { kind: "new" });
});

test("restarting returns to an untouched first step", () => {
    const state = reduce(at("target"), { type: "restarted" });
    assert.deepEqual(state, initialImportState());
});

/* ------------------------------------------------------- steps 7 and 8 */

const uploads = (...statuses) =>
    statuses.map((status, index) => ({
        path: `references/${index}.md`,
        name: `${index}.md`,
        status,
        fileId: status === "waiting" ? null : `f${index}`,
        failureCode: null,
    }));

const running = (run, uploadRows) => ({
    ...at("upload"),
    run,
    uploads: uploadRows,
});

test("creating the import moves the run to uploading and lists the documents", () => {
    const state = reduce(at("upload"), {
        type: "import_created",
        importId: "imp1",
        uploads: uploads("waiting", "waiting"),
    });
    assert.deepEqual(state.run, { kind: "uploading", importId: "imp1" });
    assert.equal(state.uploads.length, 2);
});

test("progress touches one document and leaves the others alone", () => {
    const state = reduce(running({ kind: "uploading", importId: "i" }, uploads("waiting", "waiting")), {
        type: "upload_progressed",
        path: "references/0.md",
        status: "processing",
        fileId: "server-id",
    });
    assert.equal(state.uploads[0].status, "processing");
    assert.equal(state.uploads[0].fileId, "server-id");
    assert.equal(state.uploads[1].status, "waiting");
});

test("the server's reading replaces the browser's, and only for its own states", () => {
    // A row that has no server id yet cannot be overwritten from here: the
    // browser is the only one that knows an upload is in flight.
    const state = reduce(
        running({ kind: "uploading", importId: "i" }, uploads("processing", "waiting")),
        {
            type: "processing_observed",
            files: [{ id: "f0", processingStatus: "ready", failureCode: null }],
        }
    );
    assert.equal(state.uploads[0].status, "ready");
    assert.equal(state.uploads[1].status, "waiting");
    assert.equal(state.run.kind, "processing");
});

test("every document ready is what makes the run ready", () => {
    const state = reduce(
        running({ kind: "uploading", importId: "i" }, uploads("processing", "processing")),
        {
            type: "processing_observed",
            files: [
                { id: "f0", processingStatus: "ready", failureCode: null },
                { id: "f1", processingStatus: "ready", failureCode: null },
            ],
        }
    );
    assert.deepEqual(state.run, { kind: "ready", importId: "i" });
    assert.equal(canAdvance(state), true);
});

test("a document that could not be read stops the step rather than being dropped", () => {
    // Publishing without it would be the failure the loss report exists to
    // prevent, except invisible.
    const state = reduce(
        running({ kind: "uploading", importId: "i" }, uploads("processing", "processing")),
        {
            type: "processing_observed",
            files: [
                { id: "f0", processingStatus: "ready", failureCode: null },
                { id: "f1", processingStatus: "failed", failureCode: "EXTRACT" },
            ],
        }
    );
    assert.deepEqual(blockKinds(state), ["documents_failed"]);
    assert.equal(state.uploads[1].failureCode, "EXTRACT");
});

test("an import with no documents waits for nothing", () => {
    const state = reduce(running({ kind: "uploading", importId: "i" }, []), {
        type: "processing_observed",
        files: [],
    });
    assert.deepEqual(state.run, { kind: "ready", importId: "i" });
    assert.deepEqual(blockKinds(state), []);
});

test("a failed run blocks the step and says so", () => {
    const state = reduce(running({ kind: "uploading", importId: "i" }, uploads("waiting")), {
        type: "run_failed",
        code: "ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED",
    });
    assert.equal(state.run.kind, "failed");
    assert.equal(state.run.importId, "i");
    assert.deepEqual(
        advanceProblems(state).map((block) => block.kind),
        ["run_failed"]
    );
});

test("publishing can only start from ready, and only finish from publishing", () => {
    const notReady = running({ kind: "processing", importId: "i" }, uploads("processing"));
    assert.equal(reduce(notReady, { type: "publish_started" }).run.kind, "processing");

    const ready = running({ kind: "ready", importId: "i" }, uploads("ready"));
    const publishing = reduce(ready, { type: "publish_started" });
    assert.equal(publishing.run.kind, "publishing");

    // A success that arrives without a publish having started is not a
    // success this wizard asked for.
    assert.equal(
        reduce(ready, {
            type: "publish_succeeded",
            revision: 1,
            unchanged: false,
        }).run.kind,
        "ready"
    );
    const published = reduce(publishing, {
        type: "publish_succeeded",
        revision: 3,
        unchanged: false,
    });
    assert.deepEqual(published.run, {
        kind: "published",
        importId: "i",
        revision: 3,
        unchanged: false,
    });
});

test("only documents the server read are kept", () => {
    const state = running(
        { kind: "ready", importId: "i" },
        [...uploads("ready", "failed"), { path: "x", name: "x", status: "ready", fileId: null, failureCode: null }]
    );
    assert.deepEqual(keepFileIds(state), ["f0"]);
});

test("the approval payload carries the draft, the documents and the waivers", () => {
    const base = running({ kind: "ready", importId: "i" }, uploads("ready"));
    const payload = importApprovalPayload(base);
    assert.match(payload, /digestVersion=1/);
    assert.match(payload, /name=code-reviewer/);
    assert.match(payload, /documents=\["0\.md"\]/);
    assert.match(payload, /waivedSecrets=none/);

    // A waiver is part of what was approved: without it an approval could be
    // replayed against a package whose credentials nobody decided about.
    const waived = reduce(base, { type: "secret_waived", finding: finding() });
    assert.notEqual(importApprovalPayload(waived), payload);

    // And so is every field the owner could have changed.
    const edited = reduce(
        reduce(base, { type: "field_decided", field: "instructions", decision: "edit" }),
        { type: "field_edited", edits: { instructions: "Different." } }
    );
    assert.notEqual(importApprovalPayload(edited), payload);
});

test("there is no way back once anything has been stored", () => {
    assert.equal(canGoBack(running({ kind: "uploading", importId: "i" }, [])), false);
    assert.equal(canGoBack({ ...at("confirm"), run: { kind: "ready", importId: "i" } }), false);
});

test("every extension a package may offer has a media type to send it as", () => {
    // The two lists are separate decisions -- one is what a package may carry,
    // the other is what the knowledge store accepts -- so this is what keeps
    // them from disagreeing. A candidate with no media type would be a
    // document the wizard offers and then cannot upload.
    for (const extension of ASSISTANT_PACKAGE_KNOWLEDGE_EXTENSIONS) {
        assert.equal(
            typeof knowledgeMimeForExtension(extension),
            "string",
            `${extension} has no knowledge media type`
        );
    }
});

test("an unknown extension has no media type rather than a guessed one", () => {
    assert.equal(knowledgeMimeForExtension("exe"), null);
    assert.equal(knowledgeMimeForExtension(""), null);
    // Case is not a different file type.
    assert.equal(knowledgeMimeForExtension("PDF"), "application/pdf");
});
