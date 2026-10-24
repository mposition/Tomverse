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
  /**
   * Already released: a merged main pull request names it, or was cut from a
   * branch with the same name (`hotfix/2026-10-21-x` for `claude/to-develop/x`),
   * which is how a hotfix that names no number is recognised.
   */
  | "on_main"
  /** Brings main into develop: it has nothing to release. */
  | "back_merge"
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

/**
 * Pull request numbers a release pull request carries: those its title or
 * body names (`#2873`). A train's body (lib/qaReleaseTrainCore.ts) also names
 * what it left out and what it skipped as already on main, so when the body
 * has an `## Included` section only that section counts (2026-10-23: #2906
 * marked seventeen left-out pull requests as on main).
 */
export function qaReleaseTrainReferencedNumbers(pull: Json): number[] {
  const body = typeof pull.body === "string" ? pull.body : "";
  const included = /^## Included\b[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body);
  const text = `${typeof pull.title === "string" ? pull.title : ""}\n${included ? included[1] : body}`;
  return [...new Set([...text.matchAll(/#(\d{1,7})\b/g)].map((match) => Number(match[1])))];
}

/**
 * The candidates, newest merge first: develop pull requests merged within the
 * window, each with why it can or cannot ride. `files` holds the changed paths
 * read for a pull request; one missing is "unchecked".
 */
/** A back-merge: main itself, or a branch or title that says it brings main back. */
export const qaReleaseTrainIsBackMerge = (headRef: string, title: string): boolean =>
  headRef === "main" || /back-?merge/i.test(headRef) || /back-?merge/i.test(title);

/** The last segment of a branch name: `claude/to-develop/x` → `x`. */
const branchTail = (ref: string): string => ref.slice(ref.lastIndexOf("/") + 1);

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
  const branches = (pulls: Json[], merged: boolean) => {
    const byTail = new Map<string, number>();
    for (const pull of pulls) {
      if (merged && typeof pull.merged_at !== "string") continue;
      const ref = String(record(pull.head)?.ref ?? "");
      if (typeof pull.number !== "number" || !/^(hotfix|release)\//.test(ref)) continue;
      const tail = ref.replace(/^(hotfix|release)\//, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
      if (tail !== "" && !byTail.has(tail)) byTail.set(tail, pull.number);
    }
    return byTail;
  };
  const onMainBranches = branches(list(input.mergedMainJson), true);
  const inMainPullBranches = branches(list(input.openMainJson), false);
  return list(input.mergedDevelopJson)
    .filter((pull) => record(pull.base)?.ref === "develop" && typeof pull.merged_at === "string" && typeof pull.number === "number")
    .filter((pull) => Date.parse(pull.merged_at as string) >= since)
    .sort((a, b) => Date.parse(b.merged_at as string) - Date.parse(a.merged_at as string))
    .map((pull) => {
      const number = pull.number as number;
      const files = input.files.get(number);
      const headRef = String(record(pull.head)?.ref ?? "");
      const mainNumber = onMain.get(number) ?? onMainBranches.get(branchTail(headRef));
      const mainPullNumber = inMainPull.get(number) ?? inMainPullBranches.get(branchTail(headRef));
      const status: QaReleaseTrainCargoStatus = qaReleaseTrainIsBackMerge(headRef, String(pull.title ?? ""))
        ? "back_merge"
        : mainNumber !== undefined
        ? "on_main"
        : mainPullNumber !== undefined
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
        mainPullRequest: mainNumber ?? mainPullNumber ?? null,
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

/**
 * Why a pull request the last train took rides the next one without a new
 * pick (owner request 2026-10-24: a left-out pull request must not drop out
 * of sight): it conflicted on main, the train was full, or the train failed
 * before its pull request opened. A workflow change never rides a train and
 * is not carried.
 */
export type QaReleaseTrainCarryReason = "conflict" | "over_capacity" | "train_failed";
export type QaReleaseTrainCarried = { number: number; reason: QaReleaseTrainCarryReason; predecessors: number[] };
export type QaReleaseTrainLastTrain = { slot: string; pullRequestNumber: number | null; carried: QaReleaseTrainCarried[] };

/** The last train's report (its audit metadata) as what it carries forward; null when it does not parse. */
export function qaReleaseTrainLastTrainFrom(report: unknown): QaReleaseTrainLastTrain | null {
  const value = record(report);
  if (!value || typeof value.slot !== "string" || typeof value.outcome !== "string" || !Array.isArray(value.picks)) return null;
  const isNumber = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) < 10_000_000;
  const carried: QaReleaseTrainCarried[] = [];
  for (const pick of list(value.picks)) {
    if (!isNumber(pick.number) || carried.some((c) => c.number === pick.number)) continue;
    const reason: QaReleaseTrainCarryReason | null =
      pick.outcome === "conflict" || pick.outcome === "over_capacity"
        ? pick.outcome
        : pick.outcome === "included" && value.outcome !== "opened"
          ? "train_failed"
          : null;
    if (reason === null) continue;
    const predecessors = Array.isArray(pick.predecessors) ? pick.predecessors.filter(isNumber) : [];
    carried.push({ number: pick.number, reason, predecessors });
  }
  return {
    slot: value.slot,
    pullRequestNumber: isNumber(value.pullRequestNumber) ? value.pullRequestNumber : null,
    carried: carried.slice(0, QA_RELEASE_TRAIN_CARGO_MAX),
  };
}

export type QaReleaseTrainSelection = {
  /** The numbers the next train carries: the newest pick, or once a train took it, what that train carried forward. */
  numbers: number[];
  savedAt: string | null;
  savedBy: string | null;
  /** The departure that took the newest pick, when one did. */
  departedWith: string | null;
  /** The newest train's report, for Admin to name what it left out. */
  lastTrain: QaReleaseTrainLastTrain | null;
};

/**
 * The selection from the newest saved pick, the newest admission and the
 * newest train report: a pick belongs to the first train admitted after it.
 * Once that train reports, what it left out (above) is the next train's
 * cargo until the operator saves a new pick; a train still running carries
 * nothing yet.
 */
export function qaReleaseTrainSelectionFrom(input: {
  pick: { numbers: unknown; at: Date; by: string | null } | null;
  admission: { slot: string; at: Date } | null;
  lastTrain: QaReleaseTrainLastTrain | null;
}): QaReleaseTrainSelection {
  const { pick, admission, lastTrain } = input;
  if (!pick) return { numbers: [], savedAt: null, savedBy: null, departedWith: null, lastTrain };
  const numbers = parseQaReleaseTrainCargoPick(pick.numbers) ?? [];
  const spent = admission !== null && admission.at.getTime() > pick.at.getTime();
  const carried = spent && lastTrain?.slot === admission.slot ? lastTrain.carried.map((c) => c.number) : [];
  return {
    numbers: spent ? carried : numbers,
    savedAt: pick.at.toISOString(),
    savedBy: pick.by,
    departedWith: spent ? admission.slot : null,
    lastTrain,
  };
}
