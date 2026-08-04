import assert from "node:assert/strict";
import { test } from "node:test";
import {
    EXTERNAL_IMPORT_ANALYTICS_STEPS,
    analyticsStepFor,
    classifyExternalImportFailure,
    emptyParseWarningTotals,
    externalImportWizardReducer as reduce,
    filteredRows,
    initialExternalImportWizardState,
    isRowSelectable,
    planQuotaRecovery,
    projectQuota,
    providerGuidanceMismatch,
    selectedHiddenCount,
    selectionRowsFromPreview,
    selectionTotals,
    wizardStepId,
    wizardStepNumber,
} from "../lib/externalImportWizard.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §5.3–§5.5, §22.
 *
 * The wizard's rules live in a pure module precisely so they can be checked
 * here rather than through a rendered tree: truncation consent, the
 * filter-wide meaning of "select all", and — the one that protects the server
 * contracts — the different recoveries a quota refusal and a network blip get.
 */

const row = (id, overrides = {}) => ({
    id,
    title: `Conversation ${id}`,
    messageCount: 10,
    estimatedStoredBytes: 1000,
    sourceUpdatedAt: "2026-05-02T00:00:00.000Z",
    sourceCreatedAt: "2026-05-01T00:00:00.000Z",
    eligibility: { kind: "importable" },
    ...overrides,
});

const truncationRow = (id) =>
    row(id, {
        eligibility: {
            kind: "requires_truncation_approval",
            truncatedMessageCount: 3,
        },
    });

const blockedRow = (id) =>
    row(id, {
        eligibility: { kind: "blocked_oversized_message", oversizedMessageCount: 1 },
    });

const parsed = (rows) =>
    reduce(initialExternalImportWizardState(), {
        type: "parse_succeeded",
        provider: "chatgpt",
        rows,
        warnings: emptyParseWarningTotals(),
    });

/* ---------------------------------------------------------------- steps -- */

test("the five user-facing steps map onto every status", () => {
    const statuses = [
        { kind: "guide" },
        { kind: "file_selection" },
        { kind: "parsing", conversationsFound: 0 },
        { kind: "parse_failed", reason: "unreadable_archive" },
        { kind: "desktop_recommended" },
        { kind: "conversation_selection" },
        { kind: "preparing_review", sentBatches: 0, totalBatches: 2 },
        { kind: "upload_failed", errorCode: null, failure: "transient" },
        { kind: "server_review" },
        { kind: "finalizing" },
        {
            kind: "quota_revision",
            origin: "upload",
            plan: { kind: "revise_selection_same_import" },
        },
        { kind: "expired", origin: "finalize" },
        { kind: "completed", finalizedConversations: 3 },
    ];
    for (const status of statuses) {
        const step = wizardStepId(status);
        assert.ok(step, `${status.kind} must map to a step`);
        assert.ok(wizardStepNumber(status) >= 1);
        assert.ok(wizardStepNumber(status) <= 5);
    }
});

test("preparing_review, server_review and finalizing are three different states", () => {
    // The whole point of splitting them: only one is a progress screen, one
    // is a decision point, and one is the atomic save.
    assert.equal(
        analyticsStepFor({
            kind: "preparing_review",
            sentBatches: 1,
            totalBatches: 3,
        }),
        null,
        "preparing_review is a moment inside a step, not a step"
    );
    assert.equal(analyticsStepFor({ kind: "server_review" }), "server_review");
    assert.equal(analyticsStepFor({ kind: "finalizing" }), null);

    assert.equal(
        wizardStepId({ kind: "preparing_review", sentBatches: 0, totalBatches: 1 }),
        "select_conversations"
    );
    assert.equal(wizardStepId({ kind: "server_review" }), "confirm_import");
    assert.equal(wizardStepId({ kind: "finalizing" }), "confirm_import");
});

test("every analytics step label is in the closed enum", () => {
    const statuses = [
        { kind: "guide" },
        { kind: "file_selection" },
        { kind: "parsing", conversationsFound: 0 },
        { kind: "desktop_recommended" },
        { kind: "conversation_selection" },
        { kind: "server_review" },
        { kind: "completed", finalizedConversations: 1 },
        {
            kind: "quota_revision",
            origin: "finalize",
            plan: { kind: "revise_selection_same_import" },
        },
    ];
    for (const status of statuses) {
        const step = analyticsStepFor(status);
        assert.ok(step);
        assert.ok(
            EXTERNAL_IMPORT_ANALYTICS_STEPS.includes(step),
            `${step} must be a declared import_step value`
        );
    }
});

/* ----------------------------------------------------------- truncation -- */

test("only conversations importable as-is start selected", () => {
    const state = parsed([row("a"), truncationRow("b"), blockedRow("c")]);
    assert.deepEqual([...state.selectedIds], ["a"]);
    assert.equal(state.truncationApprovals.size, 0);
});

test("truncation consent is per conversation and reversible", () => {
    let state = parsed([truncationRow("b"), truncationRow("c")]);
    assert.equal(state.selectedIds.size, 0);

    state = reduce(state, {
        type: "set_truncation_approval",
        id: "b",
        approved: true,
    });
    assert.deepEqual([...state.selectedIds], ["b"]);
    assert.equal(
        state.selectedIds.has("c"),
        false,
        "approving one shortened conversation must not approve the others"
    );

    state = reduce(state, {
        type: "set_truncation_approval",
        id: "b",
        approved: false,
    });
    assert.equal(state.selectedIds.has("b"), false);
    assert.equal(state.truncationApprovals.has("b"), false);
});

test("a shortened conversation cannot be ticked without its own consent", () => {
    let state = parsed([truncationRow("b")]);
    state = reduce(state, { type: "toggle_conversation", id: "b" });
    assert.equal(state.selectedIds.has("b"), false);
    assert.equal(isRowSelectable(state.rows[0], state.truncationApprovals), false);
});

test("a conversation past the inbound limit can never be selected", () => {
    let state = parsed([blockedRow("c")]);
    state = reduce(state, { type: "toggle_conversation", id: "c" });
    assert.equal(state.selectedIds.size, 0);
    state = reduce(state, {
        type: "set_truncation_approval",
        id: "c",
        approved: true,
    });
    assert.equal(state.selectedIds.size, 0);
});

test("select-all never pulls in shortened or blocked conversations", () => {
    let state = parsed([row("a"), truncationRow("b"), blockedRow("c")]);
    state = reduce(state, { type: "clear_all_matching_filter" });
    state = reduce(state, { type: "select_all_matching_filter" });
    assert.deepEqual([...state.selectedIds], ["a"]);
});

/* ------------------------------------------------------ provider guidance -- */

test("guidance provider never overrides the detected provider", () => {
    let state = initialExternalImportWizardState();
    state = reduce(state, {
        type: "choose_guidance_provider",
        provider: "chatgpt",
    });
    state = reduce(state, {
        type: "parse_succeeded",
        provider: "claude",
        rows: [row("a")],
        warnings: emptyParseWarningTotals(),
    });
    assert.equal(state.detectedProvider, "claude");
    assert.equal(state.status.kind, "conversation_selection");
    assert.deepEqual(providerGuidanceMismatch(state), {
        guidance: "chatgpt",
        detected: "claude",
    });
});

test("a matching guidance choice produces no notice", () => {
    let state = initialExternalImportWizardState();
    state = reduce(state, {
        type: "choose_guidance_provider",
        provider: "claude",
    });
    state = reduce(state, {
        type: "parse_succeeded",
        provider: "claude",
        rows: [row("a")],
        warnings: emptyParseWarningTotals(),
    });
    assert.equal(providerGuidanceMismatch(state), null);
});

/* ---------------------------------------------------- filters + selection -- */

const dated = (id, day) =>
    row(id, {
        title: `${id} title`,
        sourceUpdatedAt: `2026-05-${day}T00:00:00.000Z`,
        sourceCreatedAt: `2026-05-${day}T00:00:00.000Z`,
    });

test("select-all applies to the whole filtered dataset, not a rendered window", () => {
    // 2,000 rows: no view could ever have mounted them all.
    const rows = Array.from({ length: 2000 }, (_, index) =>
        row(`c${index}`, { title: index % 2 === 0 ? "keep me" : "other" })
    );
    let state = parsed(rows);
    state = reduce(state, { type: "clear_all_matching_filter" });
    state = reduce(state, { type: "set_filter", filter: { query: "keep me" } });
    state = reduce(state, { type: "select_all_matching_filter" });
    assert.equal(state.selectedIds.size, 1000);
    assert.equal(filteredRows(state).length, 1000);
});

test("changing the filter preserves selections that scroll out of view", () => {
    let state = parsed([dated("a", "01"), dated("b", "20")]);
    assert.equal(state.selectedIds.size, 2);
    state = reduce(state, { type: "set_filter", filter: { from: "2026-05-15" } });
    assert.equal(filteredRows(state).length, 1);
    assert.equal(state.selectedIds.size, 2, "off-screen selection survives");
    assert.equal(selectedHiddenCount(state), 1);

    // Removing the filter restores the previous selection exactly.
    state = reduce(state, { type: "set_filter", filter: { from: null } });
    assert.equal(filteredRows(state).length, 2);
    assert.equal(selectedHiddenCount(state), 0);
    assert.deepEqual([...state.selectedIds].sort(), ["a", "b"]);
});

test("clear-all is scoped to the filter too", () => {
    let state = parsed([dated("a", "01"), dated("b", "20")]);
    state = reduce(state, { type: "set_filter", filter: { from: "2026-05-15" } });
    state = reduce(state, { type: "clear_all_matching_filter" });
    assert.deepEqual([...state.selectedIds], ["a"]);
});

test("the quota projection is a client mirror, computed over the selection", () => {
    const state = parsed([row("a"), row("b")]);
    assert.deepEqual(selectionTotals(state), {
        conversations: 2,
        messages: 20,
        bytes: 2000,
    });
    const projection = projectQuota(state, {
        normalizedTextBytes: 1500,
        externalConversations: 100,
        externalMessages: 100,
    });
    assert.equal(projection.exceeded, true);
    assert.equal(projectQuota(state, null), null);
});

/* ------------------------------------------------------------- recovery -- */

test("quota and transport failures are different families", () => {
    assert.equal(
        classifyExternalImportFailure("EXTERNAL_IMPORT_QUOTA_EXCEEDED"),
        "quota"
    );
    assert.equal(classifyExternalImportFailure(null), "transient");
    assert.equal(
        classifyExternalImportFailure("EXTERNAL_IMPORT_STAGING_EXPIRED"),
        "expired"
    );
    assert.equal(
        classifyExternalImportFailure("EXTERNAL_IMPORT_SELECTION_CHANGED"),
        "selection_changed"
    );
    assert.equal(
        classifyExternalImportFailure("EXTERNAL_IMPORT_BATCH_CONFLICT"),
        "fatal"
    );
});

test("a transport failure keeps the retry path and the accepted batches", () => {
    let state = parsed([row("a")]);
    state = reduce(state, { type: "prepare_review_started", totalBatches: 3 });
    state = reduce(state, {
        type: "batch_accepted",
        importId: "imp_1",
        sequence: 0,
        staged: [],
        duplicatesSkipped: 0,
    });
    state = reduce(state, { type: "prepare_review_failed", errorCode: null });
    assert.equal(state.status.kind, "upload_failed");
    assert.equal(state.status.failure, "transient");
    assert.equal(
        state.upload.acceptedBatches,
        1,
        "the ledger position survives so the retry resends the same sequence"
    );
});

test("a quota refusal never offers the same payload again", () => {
    let state = parsed([row("a")]);
    state = reduce(state, { type: "prepare_review_started", totalBatches: 2 });
    state = reduce(state, {
        type: "prepare_review_failed",
        errorCode: "EXTERNAL_IMPORT_QUOTA_EXCEEDED",
    });
    assert.equal(state.status.kind, "quota_revision");
    assert.notEqual(
        state.status.kind,
        "upload_failed",
        "a quota refusal must not land in the retry-the-same-thing state"
    );
});

test("the quota recovery plan turns on whether a batch was accepted", () => {
    assert.deepEqual(planQuotaRecovery(0), {
        kind: "revise_selection_same_import",
    });
    assert.deepEqual(planQuotaRecovery(1), { kind: "restart_with_new_import" });

    let state = parsed([row("a")]);
    state = reduce(state, { type: "prepare_review_started", totalBatches: 2 });
    state = reduce(state, {
        type: "prepare_review_failed",
        errorCode: "EXTERNAL_IMPORT_QUOTA_EXCEEDED",
    });
    assert.equal(state.status.plan.kind, "revise_selection_same_import");

    let staged = parsed([row("a")]);
    staged = reduce(staged, { type: "prepare_review_started", totalBatches: 2 });
    staged = reduce(staged, {
        type: "batch_accepted",
        importId: "imp_1",
        sequence: 0,
        staged: [],
        duplicatesSkipped: 0,
    });
    staged = reduce(staged, {
        type: "prepare_review_failed",
        errorCode: "EXTERNAL_IMPORT_QUOTA_EXCEEDED",
    });
    assert.equal(staged.status.plan.kind, "restart_with_new_import");
});

test("restarting after a quota refusal keeps the local selection and approvals", () => {
    let state = parsed([row("a"), truncationRow("b")]);
    state = reduce(state, {
        type: "set_truncation_approval",
        id: "b",
        approved: true,
    });
    state = reduce(state, { type: "prepare_review_started", totalBatches: 2 });
    state = reduce(state, {
        type: "batch_accepted",
        importId: "imp_1",
        sequence: 0,
        staged: [],
        duplicatesSkipped: 0,
    });
    state = reduce(state, {
        type: "prepare_review_failed",
        errorCode: "EXTERNAL_IMPORT_QUOTA_EXCEEDED",
    });
    state = reduce(state, { type: "restart_after_quota", importId: null });

    assert.equal(state.status.kind, "conversation_selection");
    assert.deepEqual([...state.selectedIds].sort(), ["a", "b"]);
    assert.deepEqual([...state.truncationApprovals], ["b"]);
    assert.equal(state.upload.importId, null);
    assert.equal(state.upload.acceptedBatches, 0);
    assert.equal(state.review, null);
});

test("a quota refusal at finalize keeps the staged set for a smaller retry", () => {
    let state = parsed([row("a"), row("b")]);
    state = reduce(state, {
        type: "review_ready",
        importId: "imp_1",
        staged: [
            {
                stagedConversationId: "s1",
                rawExternalConversationId: "a",
                title: "a",
                conversationDigest: "d1",
                messageCount: 2,
                contentBytes: 10,
                truncatedMessageCount: 0,
            },
            {
                stagedConversationId: "s2",
                rawExternalConversationId: "b",
                title: "b",
                conversationDigest: "d2",
                messageCount: 2,
                contentBytes: 10,
                truncatedMessageCount: 0,
            },
        ],
        duplicatesSkipped: 0,
        truncatedMessages: 0,
    });
    assert.equal(state.review.selectedStagedIds.size, 2);

    state = reduce(state, { type: "finalize_started" });
    state = reduce(state, {
        type: "finalize_failed",
        errorCode: "EXTERNAL_IMPORT_QUOTA_EXCEEDED",
    });
    assert.equal(state.status.kind, "quota_revision");
    assert.equal(state.status.origin, "finalize");
    assert.equal(state.review.staged.length, 2, "staged rows survive");

    // Narrowing the subset is a plain selection change; no re-upload.
    state = reduce(state, {
        type: "toggle_staged_conversation",
        stagedConversationId: "s2",
    });
    assert.deepEqual([...state.review.selectedStagedIds], ["s1"]);
    assert.equal(wizardStepId(state.status), "confirm_import");
});

test("an expired staging lands in expired, not in the retry state", () => {
    let state = parsed([row("a")]);
    state = reduce(state, {
        type: "prepare_review_failed",
        errorCode: "EXTERNAL_IMPORT_STAGING_EXPIRED",
    });
    assert.equal(state.status.kind, "expired");
});

test("seal records the sealed digest without freezing the selection", () => {
    let state = parsed([row("a")]);
    state = reduce(state, {
        type: "review_ready",
        importId: "imp_1",
        staged: [
            {
                stagedConversationId: "s1",
                rawExternalConversationId: "a",
                title: "a",
                conversationDigest: "d1",
                messageCount: 1,
                contentBytes: 1,
                truncatedMessageCount: 0,
            },
        ],
        duplicatesSkipped: 0,
        truncatedMessages: 0,
    });
    state = reduce(state, {
        type: "review_sealed",
        selectionDigest: "sealed-digest",
        effectiveExpiresAt: "2026-08-05T00:00:00.000Z",
    });
    assert.equal(state.review.sealed, true);
    assert.equal(state.review.sealedSelectionDigest, "sealed-digest");

    state = reduce(state, {
        type: "toggle_staged_conversation",
        stagedConversationId: "s1",
    });
    assert.equal(
        state.review.selectedStagedIds.size,
        0,
        "a sealed import still allows the finalize subset to change"
    );
    assert.equal(state.review.sealed, true);
});

/* -------------------------------------------------------- preview adapter -- */

test("preview rows carry the eligibility the pipeline computed", () => {
    const preview = {
        provider: "chatgpt",
        conversations: [
            {
                conversation: {
                    rawExternalConversationId: "x",
                    title: "X",
                    sourceModelLabels: [],
                    sourceCreatedAt: null,
                    sourceUpdatedAt: null,
                    messages: [{}, {}],
                    warnings: {},
                },
                importability: {
                    kind: "requires_truncation_approval",
                    truncatedMessageCount: 2,
                },
                estimatedStoredBytes: 42,
            },
        ],
        totals: {},
    };
    const [converted] = selectionRowsFromPreview(preview);
    assert.equal(converted.id, "x");
    assert.equal(converted.estimatedStoredBytes, 42);
    assert.deepEqual(converted.eligibility, {
        kind: "requires_truncation_approval",
        truncatedMessageCount: 2,
    });
});

test("stepping back from the selection list returns to the file picker", () => {
    let state = parsed([row("a")]);
    state = reduce(state, { type: "open_file_selection" });
    assert.equal(state.status.kind, "file_selection");

    // But not once the server holds staged rows: that exit is a discard.
    let staged = parsed([row("a")]);
    staged = reduce(staged, {
        type: "review_ready",
        importId: "imp_1",
        staged: [],
        duplicatesSkipped: 0,
        truncatedMessages: 0,
    });
    const unchanged = reduce(staged, { type: "open_file_selection" });
    assert.equal(unchanged.status.kind, "server_review");
});
