import type { ImportPreview } from "@/lib/externalImportPipeline";
import type { ExternalImportProvider } from "@/lib/externalImportProviders";

/**
 * Pure state machine for the external conversation import wizard.
 *
 * docs/policy/external-conversation-import-and-memory.md §5.2–§5.5, §18, §22.
 *
 * Everything the wizard decides lives here so it can be unit-tested without
 * React: which step the user is on, which conversations are selected, which
 * truncation approvals were given, and — the part that keeps the server
 * contracts intact — how a failure is recovered from.
 *
 * Three rules this module exists to enforce:
 *
 *   * selection is owned by state, never by the rendered DOM window. The list
 *     is virtualized, so "select every normal conversation" has to mean every
 *     row matching the filter, not every row currently mounted;
 *   * truncation approval is per conversation and opt-in (§5.4). There is no
 *     global switch that pulls shortened conversations into the selection;
 *   * a quota refusal and a network blip are different failures with different
 *     recoveries. Resending the same payload fixes one and can never fix the
 *     other, so `planFailureRecovery()` — not the UI — decides which
 *     affordance the user is offered.
 *
 * Nothing here talks to the network. The React layer performs effects and
 * feeds the outcome back in as an action.
 */

/**
 * Which provider's recipe the guide shows. Advisory only -- the format that
 * actually gets used is whatever `detect()` reports -- but it is the same set,
 * so it is the same list.
 */
export type ExternalImportGuidanceProvider = ExternalImportProvider;

/** How the user answered "do you already have an export file?" (§ PR1 guide). */
export type ExternalImportGuidanceEntry = "needs_export" | "has_file";

export type ConversationEligibility =
    | { kind: "importable" }
    | { kind: "requires_truncation_approval"; truncatedMessageCount: number }
    | { kind: "blocked_oversized_message"; oversizedMessageCount: number };

export type ConversationSelectionRow = {
    /** The raw provider-side conversation id — the client-side row key. */
    id: string;
    title: string;
    messageCount: number;
    estimatedStoredBytes: number;
    /** ISO 8601 or null. Used by the date filter and the default ordering. */
    sourceUpdatedAt: string | null;
    sourceCreatedAt: string | null;
    eligibility: ConversationEligibility;
};

/**
 * Aggregate counts the preview must surface (§5.6): what normalization left
 * behind, and how many conversations are shortened or excluded. Displayed
 * once above the list; the per-row reasons stay on the rows themselves.
 */
export type ParseWarningTotals = {
    skippedNonConversationMessages: number;
    skippedNonTextParts: number;
    additionalBranches: number;
    skippedNestedArchives: number;
    /** Turns the export named no conversation for (A2 §5). */
    unassignedTurns: number;
    /** Attachments referenced but absent from the archive (A2 §4.1). */
    missingAttachments: number;
    /** Messages stored once per branch because the chat was branched (§2.2). */
    duplicatedBranchMessages: number;
    /** Answers dropped because their markup could not be rendered (A2 §5). */
    skippedUnrecognizedAnswers: number;
    requiresTruncationApproval: number;
    notImportable: number;
};

export const emptyParseWarningTotals = (): ParseWarningTotals => ({
    skippedNonConversationMessages: 0,
    skippedNonTextParts: 0,
    additionalBranches: 0,
    skippedNestedArchives: 0,
    unassignedTurns: 0,
    missingAttachments: 0,
    duplicatedBranchMessages: 0,
    skippedUnrecognizedAnswers: 0,
    requiresTruncationApproval: 0,
    notImportable: 0,
});

export type ConversationFilter = {
    query: string;
    /** Inclusive ISO date (YYYY-MM-DD) lower bound, or null. */
    from: string | null;
    /** Inclusive ISO date (YYYY-MM-DD) upper bound, or null. */
    to: string | null;
};

export const EMPTY_CONVERSATION_FILTER: ConversationFilter = {
    query: "",
    from: null,
    to: null,
};

export type StagedConversationSummary = {
    stagedConversationId: string;
    rawExternalConversationId: string;
    title: string;
    conversationDigest: string;
    messageCount: number;
    contentBytes: number;
    truncatedMessageCount: number;
};

/**
 * What the client has actually managed to hand to the server so far. The
 * accepted-batch count is the pivot of the quota recovery decision: with zero
 * accepted batches the same import can be re-driven from sequence 0 with a
 * smaller selection; with one or more, the staged rows already on the server
 * belong to a selection the user has since changed, so the import has to be
 * discarded and a new one started (§5.5 batch ledger).
 */
export type UploadProgress = {
    importId: string | null;
    totalBatches: number;
    acceptedBatches: number;
    staged: StagedConversationSummary[];
    duplicatesSkipped: number;
    truncatedMessages: number;
};

export const emptyUploadProgress = (): UploadProgress => ({
    importId: null,
    totalBatches: 0,
    acceptedBatches: 0,
    staged: [],
    duplicatesSkipped: 0,
    truncatedMessages: 0,
});

/**
 * The server-confirmed result the user reviews before the final save. Seal
 * (§ PR4) fixes only that the upload is complete and matches what the server
 * stored; the finalize selection stays editable, which is why
 * `selectedStagedIds` lives beside `sealed` rather than inside it.
 */
export type ServerReview = {
    importId: string;
    staged: StagedConversationSummary[];
    duplicatesSkipped: number;
    truncatedMessages: number;
    selectedStagedIds: ReadonlySet<string>;
    sealed: boolean;
    /** Digest of the whole sealed staged set, as returned by seal. */
    sealedSelectionDigest: string | null;
    /** Earlier of the idle and absolute TTL, server-computed. */
    effectiveExpiresAt: string | null;
};

export type ExternalImportFailureKind =
    | "quota"
    | "transient"
    | "expired"
    | "selection_changed"
    | "fatal";

export type QuotaRecoveryPlan =
    | { kind: "revise_selection_same_import" }
    | { kind: "restart_with_new_import" };

export type FailureOrigin = "upload" | "finalize";

export type ExternalImportWizardStatus =
    | { kind: "guide" }
    | { kind: "file_selection" }
    | { kind: "parsing"; conversationsFound: number }
    | { kind: "parse_failed"; reason: string }
    | { kind: "desktop_recommended" }
    | { kind: "conversation_selection" }
    | { kind: "preparing_review"; sentBatches: number; totalBatches: number }
    | {
          kind: "upload_failed";
          /** Server error code, or null for a transport-level failure. */
          errorCode: string | null;
          failure: Exclude<ExternalImportFailureKind, "quota">;
      }
    | { kind: "server_review" }
    | { kind: "finalizing" }
    | {
          kind: "quota_revision";
          origin: FailureOrigin;
          plan: QuotaRecoveryPlan;
      }
    | { kind: "expired"; origin: FailureOrigin }
    | { kind: "completed"; finalizedConversations: number };

export type ExternalImportWizardState = {
    status: ExternalImportWizardStatus;
    guidanceProvider: ExternalImportGuidanceProvider | null;
    guidanceEntry: ExternalImportGuidanceEntry | null;
    /** What the worker adapters' detect() actually said — the only authority. */
    detectedProvider: ExternalImportGuidanceProvider | null;
    rows: readonly ConversationSelectionRow[];
    warnings: ParseWarningTotals;
    selectedIds: ReadonlySet<string>;
    truncationApprovals: ReadonlySet<string>;
    filter: ConversationFilter;
    upload: UploadProgress;
    review: ServerReview | null;
};

export const initialExternalImportWizardState = (): ExternalImportWizardState => ({
    status: { kind: "guide" },
    guidanceProvider: null,
    guidanceEntry: null,
    detectedProvider: null,
    rows: [],
    warnings: emptyParseWarningTotals(),
    selectedIds: new Set(),
    truncationApprovals: new Set(),
    filter: EMPTY_CONVERSATION_FILTER,
    upload: emptyUploadProgress(),
    review: null,
});

export type ExternalImportWizardAction =
    | { type: "choose_guidance_provider"; provider: ExternalImportGuidanceProvider }
    | { type: "choose_guidance_entry"; entry: ExternalImportGuidanceEntry }
    | { type: "open_file_selection" }
    | { type: "back_to_guide" }
    | { type: "file_accepted" }
    | { type: "parse_progress"; conversationsFound: number }
    | {
          type: "parse_succeeded";
          provider: ExternalImportGuidanceProvider;
          rows: readonly ConversationSelectionRow[];
          warnings: ParseWarningTotals;
      }
    | { type: "parse_failed"; reason: string }
    | { type: "device_limit_reached" }
    | { type: "toggle_conversation"; id: string }
    | { type: "set_truncation_approval"; id: string; approved: boolean }
    | { type: "select_all_matching_filter" }
    | { type: "clear_all_matching_filter" }
    | { type: "set_filter"; filter: Partial<ConversationFilter> }
    | { type: "prepare_review_started"; totalBatches: number }
    | {
          type: "batch_accepted";
          importId: string;
          sequence: number;
          staged: readonly StagedConversationSummary[];
          duplicatesSkipped: number;
      }
    | { type: "prepare_review_failed"; errorCode: string | null }
    | {
          type: "review_ready";
          importId: string;
          staged: readonly StagedConversationSummary[];
          duplicatesSkipped: number;
          truncatedMessages: number;
      }
    | {
          type: "review_sealed";
          selectionDigest: string;
          effectiveExpiresAt: string | null;
      }
    | { type: "toggle_staged_conversation"; stagedConversationId: string }
    | { type: "back_to_selection" }
    | { type: "finalize_started" }
    | { type: "finalize_failed"; errorCode: string | null }
    | { type: "finalize_succeeded"; finalizedConversations: number }
    | { type: "restart_after_quota"; importId: string | null }
    | { type: "reset" };

/**
 * Maps a server error code onto the recovery family it belongs to. The
 * distinction the UI must never blur is quota vs transient: a transient
 * failure is fixed by resending the identical payload under the same
 * sequence, and a quota refusal cannot be — the account's stored total is
 * unchanged, so the identical request fails identically (§5.3 all-or-nothing).
 */
export function classifyExternalImportFailure(
    errorCode: string | null | undefined
): ExternalImportFailureKind {
    switch (errorCode) {
        case "EXTERNAL_IMPORT_QUOTA_EXCEEDED":
            return "quota";
        case "EXTERNAL_IMPORT_STAGING_EXPIRED":
            return "expired";
        case "EXTERNAL_IMPORT_SELECTION_CHANGED":
            return "selection_changed";
        case null:
        case undefined:
            // No code at all is a transport failure: the request may never
            // have reached the server, so the same sequence is resent.
            return "transient";
        default:
            return "fatal";
    }
}

/**
 * Quota recovery at upload time (§ quota path 2). Zero accepted batches means
 * the server holds nothing from this import yet, so the same import can carry
 * a reduced selection from sequence 0. Once a batch is accepted, appending a
 * changed payload to the existing sequence would splice two different
 * selections into one staging set, so the staging is discarded and a new
 * import starts — the user's local selection and truncation approvals are
 * preserved across that restart.
 */
export function planQuotaRecovery(acceptedBatches: number): QuotaRecoveryPlan {
    return acceptedBatches > 0
        ? { kind: "restart_with_new_import" }
        : { kind: "revise_selection_same_import" };
}

/** True when the row can be selected given the approvals granted so far. */
export function isRowSelectable(
    row: ConversationSelectionRow,
    truncationApprovals: ReadonlySet<string>
): boolean {
    if (row.eligibility.kind === "blocked_oversized_message") return false;
    if (row.eligibility.kind === "requires_truncation_approval") {
        return truncationApprovals.has(row.id);
    }
    return true;
}

const rowDate = (row: ConversationSelectionRow): string | null =>
    row.sourceUpdatedAt ?? row.sourceCreatedAt;

export function matchesConversationFilter(
    row: ConversationSelectionRow,
    filter: ConversationFilter
): boolean {
    const query = filter.query.trim().toLocaleLowerCase();
    if (query && !row.title.toLocaleLowerCase().includes(query)) return false;
    if (filter.from || filter.to) {
        const date = rowDate(row);
        // A row without any source timestamp cannot satisfy a date bound; it
        // stays visible only while no date filter is active.
        if (!date) return false;
        const day = date.slice(0, 10);
        if (filter.from && day < filter.from) return false;
        if (filter.to && day > filter.to) return false;
    }
    return true;
}

export function filteredRows(
    state: ExternalImportWizardState
): ConversationSelectionRow[] {
    return state.rows.filter((row) =>
        matchesConversationFilter(row, state.filter)
    );
}

/**
 * Selected conversations that the active filter is hiding. Surfaced verbatim
 * to the user ("12 of the 428 selected are not shown by this filter") so a
 * narrowed view never reads as a shrunken selection.
 */
export function selectedHiddenCount(state: ExternalImportWizardState): number {
    let hidden = 0;
    for (const row of state.rows) {
        if (!state.selectedIds.has(row.id)) continue;
        if (!matchesConversationFilter(row, state.filter)) hidden += 1;
    }
    return hidden;
}

export type SelectionTotals = {
    conversations: number;
    messages: number;
    bytes: number;
};

export function selectionTotals(
    state: ExternalImportWizardState
): SelectionTotals {
    const totals: SelectionTotals = { conversations: 0, messages: 0, bytes: 0 };
    for (const row of state.rows) {
        if (!state.selectedIds.has(row.id)) continue;
        totals.conversations += 1;
        totals.messages += row.messageCount;
        totals.bytes += row.estimatedStoredBytes;
    }
    return totals;
}

export type CapacityRemaining = {
    normalizedTextBytes: number;
    externalConversations: number;
    externalMessages: number;
};

export type QuotaProjection = {
    exceeded: boolean;
    selected: SelectionTotals;
    remaining: CapacityRemaining;
};

/**
 * The client-side quota preview (§5.3). Display only — the server re-decides
 * under its per-account lock, and this projection never gates the server.
 */
export function projectQuota(
    state: ExternalImportWizardState,
    remaining: CapacityRemaining | null
): QuotaProjection | null {
    if (!remaining) return null;
    const selected = selectionTotals(state);
    return {
        selected,
        remaining,
        exceeded:
            selected.bytes > remaining.normalizedTextBytes ||
            selected.conversations > remaining.externalConversations ||
            selected.messages > remaining.externalMessages,
    };
}

/**
 * The guidance provider is a teaching aid, not a gate: whatever the worker's
 * detect() reports wins, and a mismatch is reported as a non-blocking notice
 * rather than a failure.
 */
export function providerGuidanceMismatch(state: ExternalImportWizardState): {
    guidance: ExternalImportGuidanceProvider;
    detected: ExternalImportGuidanceProvider;
} | null {
    const { guidanceProvider, detectedProvider } = state;
    if (!guidanceProvider || !detectedProvider) return null;
    if (guidanceProvider === detectedProvider) return null;
    return { guidance: guidanceProvider, detected: detectedProvider };
}

/** Steps the user can walk back from without losing server-held state. */
export function canGoBack(state: ExternalImportWizardState): boolean {
    switch (state.status.kind) {
        case "file_selection":
        case "parse_failed":
        case "desktop_recommended":
        case "conversation_selection":
        case "server_review":
        case "quota_revision":
            return true;
        default:
            return false;
    }
}

/* -------------------------------------------------------------------------
 * Step indicator
 * ---------------------------------------------------------------------- */

export const EXTERNAL_IMPORT_WIZARD_STEPS = [
    "prepare_export",
    "inspect_file",
    "select_conversations",
    "confirm_import",
    "done",
] as const;

export type ExternalImportWizardStepId =
    (typeof EXTERNAL_IMPORT_WIZARD_STEPS)[number];

/** Which of the five user-facing steps the current status belongs to. */
export function wizardStepId(
    status: ExternalImportWizardStatus
): ExternalImportWizardStepId {
    switch (status.kind) {
        case "guide":
            return "prepare_export";
        case "file_selection":
        case "parsing":
        case "parse_failed":
        case "desktop_recommended":
            return "inspect_file";
        case "conversation_selection":
        case "preparing_review":
        case "upload_failed":
            return "select_conversations";
        case "quota_revision":
            // A quota refusal at finalize leaves the staged set intact, so the
            // recovery happens on the confirmation screen (narrow the subset,
            // finalize again). A refusal during upload sends the user back to
            // the conversation list instead.
            return status.origin === "finalize"
                ? "confirm_import"
                : "select_conversations";
        case "server_review":
        case "finalizing":
        case "expired":
            return "confirm_import";
        case "completed":
            return "done";
    }
}

export const wizardStepNumber = (status: ExternalImportWizardStatus): number =>
    EXTERNAL_IMPORT_WIZARD_STEPS.indexOf(wizardStepId(status)) + 1;

/* -------------------------------------------------------------------------
 * Analytics
 * ---------------------------------------------------------------------- */

export const EXTERNAL_IMPORT_ANALYTICS_STEPS = [
    "provider_guide",
    "file_selection",
    "parsing",
    "conversation_selection",
    "server_review",
    "completed",
    "desktop_recommended",
] as const;

export type ExternalImportAnalyticsStep =
    (typeof EXTERNAL_IMPORT_ANALYTICS_STEPS)[number];

/**
 * The content-free step label for `external_import_step_entered` /
 * `_abandoned` (§22). Working states with no user decision in them
 * (`preparing_review`, `finalizing`) and error states map to null: they are
 * moments inside a step, not steps, and counting them would make the
 * step-to-step drop-off unreadable. `quota_revision` maps back onto
 * `conversation_selection` because it *is* the selection step with a reason
 * attached; the emitter only fires on a change of label, so it does not
 * double-count.
 */
export function analyticsStepFor(
    status: ExternalImportWizardStatus
): ExternalImportAnalyticsStep | null {
    switch (status.kind) {
        case "guide":
            return "provider_guide";
        case "file_selection":
            return "file_selection";
        case "parsing":
            return "parsing";
        case "desktop_recommended":
            return "desktop_recommended";
        case "conversation_selection":
            return "conversation_selection";
        case "quota_revision":
            return status.origin === "finalize"
                ? "server_review"
                : "conversation_selection";
        case "server_review":
            return "server_review";
        case "completed":
            return "completed";
        default:
            return null;
    }
}

/* -------------------------------------------------------------------------
 * Preview adapter
 * ---------------------------------------------------------------------- */

/** Turns worker preview output into the rows the state machine reasons about. */
export function selectionRowsFromPreview(
    preview: ImportPreview
): ConversationSelectionRow[] {
    return preview.conversations.map((row) => ({
        id: row.conversation.rawExternalConversationId,
        title: row.conversation.title,
        messageCount: row.conversation.messages.length,
        estimatedStoredBytes: row.estimatedStoredBytes,
        sourceUpdatedAt: row.conversation.sourceUpdatedAt,
        sourceCreatedAt: row.conversation.sourceCreatedAt,
        eligibility:
            row.importability.kind === "importable"
                ? { kind: "importable" }
                : row.importability.kind === "requires_truncation_approval"
                  ? {
                        kind: "requires_truncation_approval",
                        truncatedMessageCount:
                            row.importability.truncatedMessageCount,
                    }
                  : {
                        kind: "blocked_oversized_message",
                        oversizedMessageCount:
                            row.importability.oversizedMessageCount,
                    },
    }));
}

export function parseWarningTotalsFromPreview(
    preview: ImportPreview
): ParseWarningTotals {
    return {
        skippedNonConversationMessages:
            preview.totals.skippedNonConversationMessages,
        skippedNonTextParts: preview.totals.skippedNonTextParts,
        additionalBranches: preview.totals.additionalBranches,
        skippedNestedArchives: preview.totals.skippedNestedArchives,
        unassignedTurns: preview.totals.unassignedTurns,
        missingAttachments: preview.totals.missingAttachments,
        duplicatedBranchMessages: preview.totals.duplicatedBranchMessages,
        skippedUnrecognizedAnswers: preview.totals.skippedUnrecognizedAnswers,
        requiresTruncationApproval: preview.totals.requiresTruncationApproval,
        notImportable: preview.totals.notImportable,
    };
}

/* -------------------------------------------------------------------------
 * Reducer
 * ---------------------------------------------------------------------- */

const withoutId = (source: ReadonlySet<string>, id: string) => {
    const next = new Set(source);
    next.delete(id);
    return next;
};

const withId = (source: ReadonlySet<string>, id: string) => {
    const next = new Set(source);
    next.add(id);
    return next;
};

/**
 * Applies one action. Unknown transitions are no-ops rather than throws: a
 * late worker message arriving after the user cancelled must not crash the
 * wizard.
 */
export function externalImportWizardReducer(
    state: ExternalImportWizardState,
    action: ExternalImportWizardAction
): ExternalImportWizardState {
    switch (action.type) {
        case "choose_guidance_provider":
            return { ...state, guidanceProvider: action.provider };

        case "choose_guidance_entry":
            return { ...state, guidanceEntry: action.entry };

        case "open_file_selection":
            // Reachable from the guide, from a failed read, and by stepping
            // back out of the selection list to choose a different file.
            // Not from anything the server already knows about: once an
            // import exists, leaving is a discard, not a step back.
            if (
                state.status.kind !== "guide" &&
                state.status.kind !== "parse_failed" &&
                state.status.kind !== "desktop_recommended" &&
                state.status.kind !== "conversation_selection"
            ) {
                return state;
            }
            return { ...state, status: { kind: "file_selection" } };

        case "back_to_guide":
            return { ...state, status: { kind: "guide" } };

        case "file_accepted":
            return {
                ...state,
                detectedProvider: null,
                rows: [],
                warnings: emptyParseWarningTotals(),
                selectedIds: new Set(),
                truncationApprovals: new Set(),
                filter: EMPTY_CONVERSATION_FILTER,
                status: { kind: "parsing", conversationsFound: 0 },
            };

        case "parse_progress":
            if (state.status.kind !== "parsing") return state;
            return {
                ...state,
                status: {
                    kind: "parsing",
                    conversationsFound: action.conversationsFound,
                },
            };

        case "parse_succeeded": {
            // Only conversations importable as-is start selected. Anything
            // needing truncation joins the selection one explicit approval at
            // a time (§5.4) — there is deliberately no bulk approval here.
            const selected = new Set<string>();
            for (const row of action.rows) {
                if (row.eligibility.kind === "importable") selected.add(row.id);
            }
            return {
                ...state,
                detectedProvider: action.provider,
                rows: action.rows,
                warnings: action.warnings,
                selectedIds: selected,
                truncationApprovals: new Set(),
                filter: EMPTY_CONVERSATION_FILTER,
                status: { kind: "conversation_selection" },
            };
        }

        case "parse_failed":
            return {
                ...state,
                status: { kind: "parse_failed", reason: action.reason },
            };

        case "device_limit_reached":
            return { ...state, status: { kind: "desktop_recommended" } };

        case "toggle_conversation": {
            const row = state.rows.find((candidate) => candidate.id === action.id);
            if (!row) return state;
            if (!isRowSelectable(row, state.truncationApprovals)) return state;
            return {
                ...state,
                selectedIds: state.selectedIds.has(action.id)
                    ? withoutId(state.selectedIds, action.id)
                    : withId(state.selectedIds, action.id),
            };
        }

        case "set_truncation_approval": {
            const row = state.rows.find((candidate) => candidate.id === action.id);
            if (!row || row.eligibility.kind !== "requires_truncation_approval") {
                return state;
            }
            if (action.approved) {
                return {
                    ...state,
                    truncationApprovals: withId(
                        state.truncationApprovals,
                        action.id
                    ),
                    selectedIds: withId(state.selectedIds, action.id),
                };
            }
            // Withdrawing consent removes the conversation from the selection
            // in the same step — a shortened conversation is never carried
            // forward on a stale approval.
            return {
                ...state,
                truncationApprovals: withoutId(
                    state.truncationApprovals,
                    action.id
                ),
                selectedIds: withoutId(state.selectedIds, action.id),
            };
        }

        case "select_all_matching_filter": {
            // Applies to the whole filtered dataset, not the rendered window,
            // and covers only conversations importable as-is: pulling in
            // truncation candidates would be the bulk approval §5.4 forbids.
            const next = new Set(state.selectedIds);
            for (const row of state.rows) {
                if (row.eligibility.kind !== "importable") continue;
                if (!matchesConversationFilter(row, state.filter)) continue;
                next.add(row.id);
            }
            return { ...state, selectedIds: next };
        }

        case "clear_all_matching_filter": {
            // Symmetrically scoped: rows outside the filter keep their state,
            // so narrowing the view can never silently drop a selection.
            const next = new Set(state.selectedIds);
            for (const row of state.rows) {
                if (!matchesConversationFilter(row, state.filter)) continue;
                next.delete(row.id);
            }
            return { ...state, selectedIds: next };
        }

        case "set_filter":
            return {
                ...state,
                filter: { ...state.filter, ...action.filter },
            };

        case "prepare_review_started":
            return {
                ...state,
                upload: {
                    ...state.upload,
                    totalBatches: action.totalBatches,
                },
                status: {
                    kind: "preparing_review",
                    sentBatches: state.upload.acceptedBatches,
                    totalBatches: action.totalBatches,
                },
            };

        case "batch_accepted": {
            const acceptedBatches = action.sequence + 1;
            const upload: UploadProgress = {
                importId: action.importId,
                totalBatches: state.upload.totalBatches,
                acceptedBatches,
                staged: [...state.upload.staged, ...action.staged],
                duplicatesSkipped:
                    state.upload.duplicatesSkipped + action.duplicatesSkipped,
                truncatedMessages:
                    state.upload.truncatedMessages +
                    action.staged.reduce(
                        (total, row) => total + row.truncatedMessageCount,
                        0
                    ),
            };
            return {
                ...state,
                upload,
                status:
                    state.status.kind === "preparing_review"
                        ? {
                              kind: "preparing_review",
                              sentBatches: acceptedBatches,
                              totalBatches: state.status.totalBatches,
                          }
                        : state.status,
            };
        }

        case "prepare_review_failed": {
            const failure = classifyExternalImportFailure(action.errorCode);
            if (failure === "quota") {
                return {
                    ...state,
                    status: {
                        kind: "quota_revision",
                        origin: "upload",
                        plan: planQuotaRecovery(state.upload.acceptedBatches),
                    },
                };
            }
            if (failure === "expired") {
                return {
                    ...state,
                    status: { kind: "expired", origin: "upload" },
                };
            }
            return {
                ...state,
                status: {
                    kind: "upload_failed",
                    errorCode: action.errorCode,
                    failure,
                },
            };
        }

        case "review_ready":
            return {
                ...state,
                upload: {
                    ...state.upload,
                    importId: action.importId,
                },
                review: {
                    importId: action.importId,
                    staged: [...action.staged],
                    duplicatesSkipped: action.duplicatesSkipped,
                    truncatedMessages: action.truncatedMessages,
                    selectedStagedIds: new Set(
                        action.staged.map((row) => row.stagedConversationId)
                    ),
                    sealed: false,
                    sealedSelectionDigest: null,
                    effectiveExpiresAt: null,
                },
                status: { kind: "server_review" },
            };

        case "review_sealed":
            if (!state.review) return state;
            return {
                ...state,
                review: {
                    ...state.review,
                    sealed: true,
                    sealedSelectionDigest: action.selectionDigest,
                    effectiveExpiresAt: action.effectiveExpiresAt,
                },
            };

        case "toggle_staged_conversation": {
            if (!state.review) return state;
            const selected = state.review.selectedStagedIds;
            return {
                ...state,
                review: {
                    ...state.review,
                    selectedStagedIds: selected.has(action.stagedConversationId)
                        ? withoutId(selected, action.stagedConversationId)
                        : withId(selected, action.stagedConversationId),
                },
            };
        }

        case "back_to_selection":
            return { ...state, status: { kind: "conversation_selection" } };

        case "finalize_started":
            if (state.status.kind === "finalizing") return state;
            return { ...state, status: { kind: "finalizing" } };

        case "finalize_failed": {
            const failure = classifyExternalImportFailure(action.errorCode);
            if (failure === "quota") {
                // Nothing was written (§5.3 all-or-nothing), so the staged
                // rows and the import survive: the user narrows the staged
                // subset and finalizes again without re-uploading.
                return {
                    ...state,
                    status: {
                        kind: "quota_revision",
                        origin: "finalize",
                        plan: { kind: "revise_selection_same_import" },
                    },
                };
            }
            if (failure === "expired") {
                return {
                    ...state,
                    status: { kind: "expired", origin: "finalize" },
                };
            }
            return {
                ...state,
                status: {
                    kind: "upload_failed",
                    errorCode: action.errorCode,
                    failure,
                },
            };
        }

        case "finalize_succeeded":
            return {
                ...state,
                status: {
                    kind: "completed",
                    finalizedConversations: action.finalizedConversations,
                },
            };

        case "restart_after_quota":
            // The local selection and every truncation approval survive; only
            // the server-side staging identity is dropped.
            return {
                ...state,
                upload: emptyUploadProgress(),
                review: null,
                status: { kind: "conversation_selection" },
            };

        case "reset":
            return {
                ...initialExternalImportWizardState(),
                guidanceProvider: state.guidanceProvider,
            };
    }
}
