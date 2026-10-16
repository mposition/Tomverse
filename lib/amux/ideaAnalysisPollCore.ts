/**
 * How the Ideas flow watches an analysis after the execution approval, so the
 * plan approval screen opens on its own and nobody presses "check the analysis
 * result" (pure: no clock, no timers, no fetch).
 *
 * The result read is limited to 10 reads a minute and 100 a day per owner
 * (app/api/admin/amux/ideas/analysis-result/route.ts), and the plan approval
 * screen reads every page of the result too, so the watch is gentle and bounded:
 * every 15 s for the first 3 minutes, every 30 s for the next 8, every 60 s for
 * the next 20, then it stops (48 reads, about 31 minutes) and leaves the manual
 * button. It also stops on any terminal state, on a refused or failed read
 * (a 429 must never be answered with more reads), and it does not count or
 * issue reads while the tab is hidden (the caller pauses on visibility).
 */

export const ANALYSIS_POLL_SCHEDULE: ReadonlyArray<{ reads: number; everyMs: number }> = [
  { reads: 12, everyMs: 15_000 },
  { reads: 16, everyMs: 30_000 },
  { reads: 20, everyMs: 60_000 },
];

export const ANALYSIS_POLL_MAX_READS = ANALYSIS_POLL_SCHEDULE.reduce((total, step) => total + step.reads, 0);

/** The wait before the next read after `readsDone` reads, or null once the watch is over. */
export function analysisPollDelayMs(readsDone: number): number | null {
  let remaining = readsDone;
  for (const step of ANALYSIS_POLL_SCHEDULE) {
    if (remaining < step.reads) return step.everyMs;
    remaining -= step.reads;
  }
  return null;
}

/** Only an analysis still running (or not read yet) is worth another read. */
export const analysisPollWanted = (state: string | null): boolean => state === null || state === "pending";
