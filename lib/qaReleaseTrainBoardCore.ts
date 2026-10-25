/**
 * The release train tab's departure board (owner request 2026-10-25): one row
 * per train, newest first, built from what the app recorded (admissions and
 * reports in the audit chain) and what GitHub says of each train's main pull
 * request. A train admitted but not reported is still on the board.
 *
 * Pure: the read (lib/qaReleaseTrainBoardRead.ts) passes what it read.
 */
import { QA_RELEASE_TRAIN_BRANCH_PREFIX, type QaReleaseTrainPick } from "./qaReleaseTrainCore.ts";

/** How long a train may run between its admission and its report before the board calls it unreported. */
export const QA_RELEASE_TRAIN_BOARD_RUNNING_MS = 30 * 60 * 1000;

export type QaReleaseTrainBoardStatus =
  /** Admitted, assembling; no report yet. */
  | "running"
  /** Admitted long ago and never reported. */
  | "unreported"
  /** Its main pull request is open. */
  | "boarding"
  /** It opened a main pull request whose state GitHub did not give (outside the list read, or the read failed). */
  | "unknown"
  /** Its main pull request was merged. */
  | "arrived"
  /** Its main pull request was closed without merging. */
  | "cancelled"
  /** Nothing it carried could ride. */
  | "empty"
  | "failed";

export type QaReleaseTrainBoardPull = { number: number; title: string };

export type QaReleaseTrainBoardRow = {
  slot: string;
  emergency: boolean;
  admittedAt: string;
  reportedAt: string | null;
  status: QaReleaseTrainBoardStatus;
  pullRequestNumber: number | null;
  /** When its main pull request was merged or closed, from GitHub. */
  settledAt: string | null;
  included: QaReleaseTrainBoardPull[];
  leftOut: (QaReleaseTrainBoardPull & { outcome: Exclude<QaReleaseTrainPick["outcome"], "included" | "already_in_main">; predecessors: number[] | null })[];
  alreadyOnMain: number[];
  /** An emergency train's pull requests already riding an open train. */
  onOpenTrain: number[];
  rcSha: string | null;
  failure: string | null;
};

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null);

/** A main pull request's state as GitHub lists it: `null` when the list did not include it or could not be read. */
export type QaReleaseTrainPullState = { state: "open" | "merged" | "closed"; settledAt: string | null };

/** The open train pull requests in a GitHub list of open main pull requests, newest first. */
export function qaReleaseTrainOpenTrains(openPullsJson: readonly unknown[]): number[] {
  return openPullsJson
    .map(record)
    .filter((pull): pull is Json => pull !== null && typeof pull.number === "number" && String(record(pull.head)?.ref ?? "").startsWith(QA_RELEASE_TRAIN_BRANCH_PREFIX))
    .map((pull) => pull.number as number)
    .sort((a, b) => b - a);
}

/** The train pull requests in a GitHub list of main pull requests, by number. */
export function qaReleaseTrainPullStates(pullsJson: unknown): Map<number, QaReleaseTrainPullState> {
  const states = new Map<number, QaReleaseTrainPullState>();
  for (const pull of Array.isArray(pullsJson) ? pullsJson : []) {
    const value = record(pull);
    if (!value || typeof value.number !== "number") continue;
    const merged = typeof value.merged_at === "string" ? value.merged_at : null;
    const closed = typeof value.closed_at === "string" ? value.closed_at : null;
    states.set(value.number, value.state === "open" ? { state: "open", settledAt: null } : merged ? { state: "merged", settledAt: merged } : { state: "closed", settledAt: closed });
  }
  return states;
}

export function qaReleaseTrainBoardRows(input: {
  admissions: readonly { slot: string; at: Date; emergency: boolean }[];
  reports: readonly { slot: string; at: Date; report: { outcome: string; pullRequestNumber: number | null; rcSha?: string | null; failure: string | null; picks: unknown } }[];
  pullStates: ReadonlyMap<number, QaReleaseTrainPullState>;
  titles: ReadonlyMap<number, string>;
  nowMs: number;
}): QaReleaseTrainBoardRow[] {
  const pull = (number: number): QaReleaseTrainBoardPull => ({ number, title: input.titles.get(number) ?? "" });
  return input.admissions.map((admission) => {
    const found = input.reports.find((r) => r.slot === admission.slot);
    const base = { slot: admission.slot, emergency: admission.emergency, admittedAt: admission.at.toISOString() };
    if (!found) {
      const running = input.nowMs - admission.at.getTime() < QA_RELEASE_TRAIN_BOARD_RUNNING_MS;
      return {
        ...base,
        reportedAt: null,
        status: running ? "running" : "unreported",
        pullRequestNumber: null,
        settledAt: null,
        included: [],
        leftOut: [],
        alreadyOnMain: [],
        onOpenTrain: [],
        rcSha: null,
        failure: null,
      };
    }
    const { report } = found;
    const picks = (Array.isArray(report.picks) ? report.picks : []).map(record).filter((p): p is Json => p !== null && typeof p.number === "number");
    const state = report.pullRequestNumber !== null ? input.pullStates.get(report.pullRequestNumber) : undefined;
    const status: QaReleaseTrainBoardStatus =
      report.outcome === "empty"
        ? "empty"
        : report.outcome === "failed"
          ? "failed"
          : state?.state === "merged"
            ? "arrived"
            : state?.state === "closed"
              ? "cancelled"
              : state?.state === "open"
                ? "boarding"
                : "unknown";
    return {
      ...base,
      reportedAt: found.at.toISOString(),
      status,
      pullRequestNumber: report.pullRequestNumber,
      settledAt: state?.settledAt ?? null,
      included: picks.filter((p) => p.outcome === "included").map((p) => pull(p.number as number)),
      leftOut: picks
        .filter((p) => p.outcome === "conflict" || p.outcome === "over_capacity" || p.outcome === "changes_workflows")
        .map((p) => ({
          ...pull(p.number as number),
          outcome: p.outcome as "conflict" | "over_capacity" | "changes_workflows",
          predecessors: Array.isArray(p.predecessors) ? p.predecessors.filter((n): n is number => Number.isInteger(n) && n > 0) : null,
        })),
      alreadyOnMain: picks.filter((p) => p.outcome === "already_in_main").map((p) => p.number as number),
      onOpenTrain: picks.filter((p) => p.outcome === "in_open_train").map((p) => p.number as number),
      rcSha: typeof report.rcSha === "string" ? report.rcSha : null,
      failure: report.failure,
    };
  });
}
