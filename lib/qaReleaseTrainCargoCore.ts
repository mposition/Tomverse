/**
 * What the next release train carries (owner decision 2026-10-23): the
 * operator picks merged develop pull requests in Admin, and the train reads
 * that pick when it departs. The pick lives in the app (an audited Admin
 * action), not in a GitHub label.
 *
 * Pure: the read and the store pass what they read.
 */

export const QA_RELEASE_TRAIN_CARGO_MAX = 30;
/** How far back merged develop pull requests are offered. */
export const QA_RELEASE_TRAIN_CANDIDATE_DAYS = 14;

export type QaReleaseTrainCargoStatus =
  /** Can ride. */
  | "available"
  /** Waiting in an open main pull request already; picking it would release it twice. */
  | "in_main_pull_request"
  /** A merged main pull request names it: already released. */
  | "on_main"
  /** Changes .github/workflows: the train's App cannot push it. */
  | "changes_workflows"
  /** Its files could not be read; the train itself still leaves a workflow change out. */
  | "unchecked";

export type QaReleaseTrainCargoCandidate = {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
  status: QaReleaseTrainCargoStatus;
  /** The main pull request that names it, for on_main and in_main_pull_request. */
  mainPullRequest: number | null;
};

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(record).filter((item): item is Json => item !== null) : []);

/** Pull request numbers a release pull request names in its title or body (`#2873`). */
export function qaReleaseTrainReferencedNumbers(pull: Json): number[] {
  const text = `${typeof pull.title === "string" ? pull.title : ""}\n${typeof pull.body === "string" ? pull.body : ""}`;
  return [...new Set([...text.matchAll(/#(\d{1,7})\b/g)].map((match) => Number(match[1])))];
}

/**
 * The candidates, newest merge first: develop pull requests merged within the
 * window, each with why it can or cannot ride. `files` holds the changed paths
 * read for a pull request; one missing is "unchecked".
 */
export function qaReleaseTrainCargoCandidates(input: {
  mergedDevelopJson: unknown;
  mergedMainJson: unknown;
  openMainJson: unknown;
  files: ReadonlyMap<number, readonly string[]>;
  nowMs: number;
}): QaReleaseTrainCargoCandidate[] {
  const since = input.nowMs - QA_RELEASE_TRAIN_CANDIDATE_DAYS * 24 * 60 * 60 * 1000;
  const named = (pulls: Json[], merged: boolean) => {
    const byNumber = new Map<number, number>();
    for (const pull of pulls) {
      if (merged && typeof pull.merged_at !== "string") continue;
      if (typeof pull.number !== "number") continue;
      for (const number of qaReleaseTrainReferencedNumbers(pull)) if (!byNumber.has(number)) byNumber.set(number, pull.number);
    }
    return byNumber;
  };
  const onMain = named(list(input.mergedMainJson), true);
  const inMainPull = named(list(input.openMainJson), false);
  return list(input.mergedDevelopJson)
    .filter((pull) => record(pull.base)?.ref === "develop" && typeof pull.merged_at === "string" && typeof pull.number === "number")
    .filter((pull) => Date.parse(pull.merged_at as string) >= since)
    .sort((a, b) => Date.parse(b.merged_at as string) - Date.parse(a.merged_at as string))
    .map((pull) => {
      const number = pull.number as number;
      const files = input.files.get(number);
      const status: QaReleaseTrainCargoStatus = onMain.has(number)
        ? "on_main"
        : inMainPull.has(number)
          ? "in_main_pull_request"
          : files === undefined
            ? "unchecked"
            : files.some((path) => path.startsWith(".github/workflows/"))
              ? "changes_workflows"
              : "available";
      return {
        number,
        title: String(pull.title ?? "").slice(0, 200),
        author: String(record(pull.user)?.login ?? "").slice(0, 60),
        mergedAt: pull.merged_at as string,
        status,
        mainPullRequest: onMain.get(number) ?? inMainPull.get(number) ?? null,
      };
    });
}

/** Whether a candidate may be picked: anything but released, queued in a main PR, or a workflow change. */
export const qaReleaseTrainCargoPickable = (status: QaReleaseTrainCargoStatus) => status === "available" || status === "unchecked";

/** A pick as saved: distinct positive pull request numbers, at most the train's capacity. Null when not one. */
export function parseQaReleaseTrainCargoPick(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > QA_RELEASE_TRAIN_CARGO_MAX) return null;
  if (!value.every((number) => Number.isInteger(number) && number > 0 && number < 10_000_000)) return null;
  return new Set(value).size === value.length ? (value as number[]) : null;
}

export type QaReleaseTrainSelection = {
  /** The numbers the next train carries; empty when nothing is picked or the pick has departed. */
  numbers: number[];
  savedAt: string | null;
  savedBy: string | null;
  /** The departure that took the newest pick, when one did. */
  departedWith: string | null;
};

/**
 * The selection from the newest saved pick and the newest admission: a pick
 * belongs to the first train admitted after it, and is spent then.
 */
export function qaReleaseTrainSelectionFrom(input: {
  pick: { numbers: unknown; at: Date; by: string | null } | null;
  admission: { slot: string; at: Date } | null;
}): QaReleaseTrainSelection {
  const { pick, admission } = input;
  if (!pick) return { numbers: [], savedAt: null, savedBy: null, departedWith: null };
  const numbers = parseQaReleaseTrainCargoPick(pick.numbers) ?? [];
  const spent = admission !== null && admission.at.getTime() > pick.at.getTime();
  return {
    numbers: spent ? [] : numbers,
    savedAt: pick.at.toISOString(),
    savedBy: pick.by,
    departedWith: spent ? admission.slot : null,
  };
}
