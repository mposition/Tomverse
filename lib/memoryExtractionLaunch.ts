/**
 * The launch surface's decisions, as pure functions (policy §11, §21).
 *
 * The server already owns every rule that matters — approved pair, plan,
 * budget, one run per account, and the estimate/confirm agreement. What lives
 * here is the part the *screen* has to get right so those rules are never
 * discovered as an error: which button may be pressed, and what number the
 * user is agreeing to when they press it.
 *
 * The one invariant worth naming is estimate freshness. `createMemoryExtraction
 * Run()` answers 409 MEMORY_ESTIMATE_CHANGED when `confirmedCredits` disagrees
 * with a re-computed estimate, and it re-computes over the *current* selection.
 * So an estimate is only meaningful for the exact selection and pair it was
 * asked for, and offering "start" after either has changed would be offering a
 * number the user can see is no longer on screen. `startGate()` refuses that
 * case locally rather than letting the round trip fail.
 *
 * Nothing here fetches, renders or persists, so the whole policy is testable
 * without a browser (tests/memoryExtractionLaunch.test.mjs).
 */

/** Mirrors the request schema in app/api/memories/extraction-runs/route.ts. */
export const MEMORY_EXTRACTION_MAX_SELECTION = 500;

export type ExtractionPairChoice = {
    extractionModelId: string;
    promptVersion: string;
};

/**
 * The separator both signatures below join on. NUL is used because it cannot
 * occur in a conversation id, a model id or a prompt version, so no value can
 * forge a boundary and make two different inputs share one signature.
 *
 * Written as an escape, not as a literal NUL byte. It was a literal one until
 * 2026-08-04, and a single unprintable byte made the whole module binary as
 * far as git is concerned: `git diff` rendered every change to it as
 * "Binary files ... differ", `--stat` reported `Bin 7375 -> 7382 bytes` with
 * 0 insertions and 0 deletions, and GitHub showed a pull request touching it
 * with no viewable diff at all. This module decides whether a launch is the
 * same launch -- the idempotency of a run that spends credits -- so a change
 * to it landing unreviewable is the last place that should happen.
 * `npm run check:encoding:strict` now fails on a control byte in a source
 * file, so it cannot come back.
 */
const SEPARATOR = "\u0000";

/**
 * Identity of an estimate's inputs. Two different selections must never
 * produce the same key, and re-ordering the same selection must never produce
 * a different one — the server sorts before planning for the same reason.
 */
export function selectionSignature(ids: Iterable<string>): string {
    return [...new Set(ids)].sort().join(SEPARATOR);
}

export function pairSignature(pair: ExtractionPairChoice | null): string {
    if (!pair) return "";
    return `${pair.extractionModelId}${SEPARATOR}${pair.promptVersion}`;
}

export type LaunchEstimate = {
    /** The selection this estimate was computed for. */
    selection: string;
    /** The pair it was computed for. */
    pair: string;
    chunkCount: number;
    conversationCount: number;
    estimatedCredits: number;
};

export type LaunchInput = {
    /** False once any endpoint has answered MEMORY_FEATURE_DISABLED. */
    featureEnabled: boolean;
    /** Approved, plan-allowed pairs the account may run today. */
    availablePairs: readonly ExtractionPairChoice[];
    selectedPair: ExtractionPairChoice | null;
    selectedConversationIds: readonly string[];
    /** A run this account already has open, if any. */
    activeRunId: string | null;
    /** True while an estimate or a create request is in flight. */
    busy: boolean;
};

export type LaunchBlockReason =
    | "feature_disabled"
    | "no_approved_pair"
    | "no_pair_selected"
    | "no_selection"
    | "selection_too_large"
    | "run_in_progress"
    | "busy";

export type StartBlockReason = LaunchBlockReason | "estimate_missing" | "estimate_stale";

type Gate<Reason> = { allow: true } | { allow: false; reason: Reason };

const commonBlock = (input: LaunchInput): LaunchBlockReason | null => {
    if (!input.featureEnabled) return "feature_disabled";
    // An account with no approved pair is not a broken account: §12.4 keeps
    // extraction closed until a pair passes eval, and the screen says so
    // instead of offering a control that can only fail.
    if (input.availablePairs.length === 0) return "no_approved_pair";
    if (input.activeRunId) return "run_in_progress";
    if (!input.selectedPair) return "no_pair_selected";
    if (input.selectedConversationIds.length === 0) return "no_selection";
    if (input.selectedConversationIds.length > MEMORY_EXTRACTION_MAX_SELECTION) {
        return "selection_too_large";
    }
    if (input.busy) return "busy";
    return null;
};

/** May the user ask what this selection would cost? */
export function estimateGate(input: LaunchInput): Gate<LaunchBlockReason> {
    const blocked = commonBlock(input);
    return blocked ? { allow: false, reason: blocked } : { allow: true };
}

/**
 * May the user start the run, and on exactly which number?
 *
 * The returned `credits` is the figure to send as `confirmedCredits`. It comes
 * from the estimate the user was shown, never re-derived here, because the
 * whole point of the confirmation contract is that the agreed number and the
 * displayed number are the same object.
 */
export function startGate(
    input: LaunchInput & { estimate: LaunchEstimate | null }
): { allow: true; credits: number } | { allow: false; reason: StartBlockReason } {
    const blocked = commonBlock(input);
    if (blocked) return { allow: false, reason: blocked };
    if (!input.estimate) return { allow: false, reason: "estimate_missing" };
    const fresh =
        input.estimate.selection ===
            selectionSignature(input.selectedConversationIds) &&
        input.estimate.pair === pairSignature(input.selectedPair);
    if (!fresh) return { allow: false, reason: "estimate_stale" };
    return { allow: true, credits: input.estimate.estimatedCredits };
}

export type SelectionSummary = {
    count: number;
    contentBytes: number;
    /** Selected rows the current page does not show, for the hidden notice. */
    hiddenCount: number;
};

/**
 * Totals for the confirmation copy. Rows the user has scrolled past are still
 * selected, so the summary counts them and says how many are out of view —
 * the same rule the import wizard's selection step follows.
 */
export function summarizeSelection(
    visibleRows: readonly { id: string; contentBytes: number }[],
    selectedIds: readonly string[]
): SelectionSummary {
    const selected = new Set(selectedIds);
    let contentBytes = 0;
    let visibleSelected = 0;
    for (const row of visibleRows) {
        if (!selected.has(row.id)) continue;
        visibleSelected += 1;
        contentBytes += row.contentBytes;
    }
    return {
        count: selected.size,
        contentBytes,
        hiddenCount: selected.size - visibleSelected,
    };
}

export const MEMORY_EXTRACTION_RUN_STATUSES = [
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
] as const;

export type MemoryExtractionRunStatus =
    (typeof MEMORY_EXTRACTION_RUN_STATUSES)[number];

export type RunView = {
    status: string;
    chunkTotal: number;
    chunkCompleted: number;
    /**
     * Server-derived: the run still reads `running` but no worker holds its
     * lease. Absent on an older response, which reads as "not stalled" —
     * the safe direction, because it keeps the screen showing exactly what it
     * showed before this field existed.
     */
    stalled?: boolean;
};

export type RunProgress = {
    status: MemoryExtractionRunStatus;
    /** 0–100, clamped: a completed run reads 100 even if counters disagree. */
    percent: number;
    terminal: boolean;
    cancellable: boolean;
    /** Whether the screen should keep polling. */
    polling: boolean;
    /**
     * The run is running, but paused between workers.
     *
     * Not a status of its own, and deliberately not a failure: the progress
     * already made is kept, the reclaim sweep hands the run to a new worker,
     * and cancelling stays available the whole time. What it changes is the
     * copy — a bar that has not moved in ten minutes needs a reason, and
     * "still working" would be untrue.
     */
    stalled: boolean;
};

const asStatus = (value: string): MemoryExtractionRunStatus =>
    (MEMORY_EXTRACTION_RUN_STATUSES as readonly string[]).includes(value)
        ? (value as MemoryExtractionRunStatus)
        : "failed";

export function runProgress(run: RunView): RunProgress {
    const status = asStatus(run.status);
    const terminal =
        status === "completed" || status === "failed" || status === "cancelled";
    const ratio =
        run.chunkTotal > 0
            ? Math.min(1, Math.max(0, run.chunkCompleted / run.chunkTotal))
            : 0;
    return {
        status,
        percent: status === "completed" ? 100 : Math.round(ratio * 100),
        terminal,
        cancellable: !terminal,
        // Polling continues while stalled. The recovery this screen is waiting
        // for happens on the server, so stopping would leave the page frozen
        // on the one state that resolves without the user doing anything.
        polling: !terminal,
        // Guarded on `terminal` as well as on the flag: a run that finished
        // between two polls must not be described as paused because a stale
        // response said so.
        stalled: !terminal && run.stalled === true,
    };
}
