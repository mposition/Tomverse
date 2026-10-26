/**
 * How a memory extraction run's progress reads on screen
 * (docs/policy/external-conversation-import-and-memory.md §11, §21).
 *
 * This module used to hold the launch screen's selection and estimate gates
 * too. Since 2026-10-24 runs start by themselves when an import finishes, for
 * free (lib/memoryExtractionAuto.ts), so only the progress view is left.
 *
 * Pure, so it is testable without a browser
 * (tests/memoryExtractionLaunch.test.mjs).
 */

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
