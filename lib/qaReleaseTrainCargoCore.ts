/**
 * What the next release train carries (owner decision 2026-10-23): the
 * operator picks merged develop pull requests in Admin, and the train reads
 * that pick when it departs. The pick lives in the app (an audited Admin
 * action), not in a GitHub label.
 *
 * Pure: the read and the store pass what they read.
 */
import { QA_RELEASE_TRAIN_REPOSITORY, qaReleaseTrainIncludedNumbers, qaReleaseTrainIsTrainPull } from "./qaReleaseTrainCore.ts";
import type { QaReleaseTrainVerdict } from "./qaReleaseTrainVerdictCore.ts";

export const QA_RELEASE_TRAIN_CARGO_MAX = 30;
/** How far back merged develop pull requests are offered. */
export const QA_RELEASE_TRAIN_CANDIDATE_DAYS = 14;

export type QaReleaseTrainCargoStatus =
  /** Can ride. */
  | "available"
  /** Waiting in an open main pull request already; picking it would release it twice. */
  | "in_main_pull_request"
  /**
   * Already released: a merged main pull request carries it -- its commits or
   * title name it, or hold every one of its own commits -- or was cut from a
   * branch with the same name (`hotfix/2026-10-21-x` for `claude/to-develop/x`),
   * which is how a hotfix that names no number is recognised.
   */
  | "on_main"
  /**
   * Only a main pull request's body mentions it: it may already be on main,
   * or the body only refers to it (2026-10-25: #2941 named the checklist #2940
   * to run on staging, and #2940 read as on main). It can be picked; the train
   * skips it at departure if main already has its change.
   */
  | "mentioned"
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
  /** Its develop merge commit, for the train service's content check. */
  mergeCommitSha?: string;
  /** The content check and the model's judgement (lib/qaReleaseTrainVerdictCore.ts), when the train service sent one. */
  verdict?: QaReleaseTrainVerdict;
  /**
   * For on_main: the train that found its change already on main (its pull
   * request `#3046`, or its slot) when no main pull request names it.
   */
  foundByTrain?: string;
  /** For on_main: the train service's content check found every change of it on main. */
  foundByContent?: boolean;
};

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(record).filter((item): item is Json => item !== null) : []);

/**
 * Pull request numbers a release pull request says it carries, beside its
 * commits: those its title names (`#2873`), and the number leading each item
 * of a train's `## Included` section -- the train service reads riders the
 * same way (qaReleaseTrainIncludedNumbers). Free text in a body, an item's
 * own title included ("follow up on #2988"), is not read: it names what a
 * release refers to as well as what it carries (2026-10-23: #2906's left-out
 * list; 2026-10-25: #2941 named the checklist #2940 to run on staging, and
 * #2940 read as on main).
 */
export function qaReleaseTrainReferencedNumbers(pull: Json): number[] {
  const title = typeof pull.title === "string" ? pull.title : "";
  const fromTitle = [...title.matchAll(/#(\d{1,7})\b/g)].map((match) => Number(match[1]));
  return [...new Set([...fromTitle, ...qaReleaseTrainIncludedNumbers(typeof pull.body === "string" ? pull.body : "")])];
}

/**
 * An open main pull request that can hold a candidate back: one from a
 * branch of this repository. Anyone can open one on the public repository
 * from a fork, with any title or body; a fork's open pull request is not
 * believed. A merged one was merged by a person and is.
 */
const fromThisRepository = (pull: Json): boolean => record(record(pull.head)?.repo)?.full_name === QA_RELEASE_TRAIN_REPOSITORY;

/**
 * What a release pull request really carries, from its commits: a develop pull
 * request rides as its own merge commit, whether merged, cherry-picked with
 * `-x` (`(cherry picked from commit <sha>)`) or picked by the train (the
 * subject `Merge pull request #2978 from ...` kept).
 */
export function qaReleaseTrainCarried(messages: readonly string[]): { numbers: Set<number>; shas: Set<string> } {
  const numbers = new Set<number>();
  const shas = new Set<string>();
  for (const message of messages) {
    const subject = /^Merge pull request #(\d{1,7}) from /.exec(message);
    if (subject) numbers.add(Number(subject[1]));
    for (const picked of message.matchAll(/\(cherry picked from commit ([0-9a-f]{40})\)/g)) shas.add(picked[1]);
  }
  return { numbers, shas };
}

/**
 * The candidates, newest merge first: develop pull requests merged within the
 * window, each with why it can or cannot ride. `files` holds the changed paths
 * read for a pull request; one missing is "unchecked".
 */
/** A back-merge: main itself, or a branch or title that says it brings main back. */
export const qaReleaseTrainIsBackMerge = (headRef: string, title: string): boolean =>
  headRef === "main" || /back-?merge/i.test(headRef) || /back-?merge/i.test(title);

/**
 * A Dependabot package update: never a candidate, since Dependabot opens its
 * own main pull request for the same update (owner 2026-10-27).
 */
export const qaReleaseTrainIsDependabot = (pull: { user?: unknown }): boolean =>
  /^dependabot(\[bot\])?$/i.test(String(record(pull.user)?.login ?? ""));

/** The last segment of a branch name: `claude/to-develop/x` → `x`. */
const branchTail = (ref: string): string => ref.slice(ref.lastIndexOf("/") + 1);

export function qaReleaseTrainCargoCandidates(input: {
  mergedDevelopJson: unknown;
  mergedMainJson: unknown;
  openMainJson: unknown;
  files: ReadonlyMap<number, readonly string[]>;
  /** Each main pull request's commits, as read; what its title names counts too, read or not. */
  mainCommits?: ReadonlyMap<number, readonly { sha: string; message: string }[]>;
  /** Each candidate's own commits (merge commits left out), as read. */
  developCommits?: ReadonlyMap<number, readonly string[]>;
  nowMs: number;
}): QaReleaseTrainCargoCandidate[] {
  const since = input.nowMs - QA_RELEASE_TRAIN_CANDIDATE_DAYS * 24 * 60 * 60 * 1000;
  // What each main pull request carries: develop pull request numbers its
  // commits and title name, and commits it holds or cherry-picked. And what
  // only its body mentions.
  const named = (pulls: Json[], merged: boolean) => {
    const byNumber = new Map<number, number>();
    const bySha = new Map<string, number>();
    const mentioned = new Map<number, number>();
    for (const pull of pulls) {
      if (merged && typeof pull.merged_at !== "string") continue;
      if (typeof pull.number !== "number") continue;
      // A release that cherry-picks a pull request's own commits keeps no
      // merge subject, but names the pull request in its title (#2889, #2901).
      const commits = input.mainCommits?.get(pull.number) ?? [];
      const carried = qaReleaseTrainCarried(commits.map((commit) => commit.message));
      for (const commit of commits) carried.shas.add(commit.sha);
      for (const number of qaReleaseTrainReferencedNumbers(pull)) carried.numbers.add(number);
      for (const number of carried.numbers) if (!byNumber.has(number)) byNumber.set(number, pull.number);
      for (const sha of carried.shas) if (!bySha.has(sha)) bySha.set(sha, pull.number);
      // A train's body is all lists the train wrote: Included is read above,
      // and Left out, already on main and on an open train name pull requests
      // it did not carry (2026-10-27: #3041 left out of #3046 read as mentioned).
      const body = typeof pull.body === "string" && !qaReleaseTrainIsTrainPull(pull) ? pull.body : "";
      for (const match of body.matchAll(/#(\d{1,7})\b/g)) if (!mentioned.has(Number(match[1]))) mentioned.set(Number(match[1]), pull.number);
    }
    return { byNumber, bySha, mentioned };
  };
  const openMain = list(input.openMainJson).filter(fromThisRepository);
  const onMain = named(list(input.mergedMainJson), true);
  const inMainPull = named(openMain, false);
  // Carried: named by number, its merge commit cherry-picked, or every one of
  // its own commits there (merged or cherry-picked one by one).
  const carriedBy = (carried: ReturnType<typeof named>, pull: Json) => {
    const byNumber = carried.byNumber.get(pull.number as number);
    if (byNumber !== undefined) return byNumber;
    if (typeof pull.merge_commit_sha === "string" && carried.bySha.has(pull.merge_commit_sha)) return carried.bySha.get(pull.merge_commit_sha);
    const own = input.developCommits?.get(pull.number as number) ?? [];
    return own.length > 0 && own.every((sha) => carried.bySha.has(sha)) ? carried.bySha.get(own[0]) : undefined;
  };
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
  const inMainPullBranches = branches(openMain, false);
  return list(input.mergedDevelopJson)
    .filter((pull) => record(pull.base)?.ref === "develop" && typeof pull.merged_at === "string" && typeof pull.number === "number")
    .filter((pull) => Date.parse(pull.merged_at as string) >= since && !qaReleaseTrainIsDependabot(pull))
    .sort((a, b) => Date.parse(b.merged_at as string) - Date.parse(a.merged_at as string))
    .map((pull) => {
      const number = pull.number as number;
      const files = input.files.get(number);
      const headRef = String(record(pull.head)?.ref ?? "");
      const mainNumber = carriedBy(onMain, pull) ?? onMainBranches.get(branchTail(headRef));
      const mainPullNumber = carriedBy(inMainPull, pull) ?? inMainPullBranches.get(branchTail(headRef));
      const mentionedBy = onMain.mentioned.get(number) ?? inMainPull.mentioned.get(number);
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
              : mentionedBy !== undefined
                ? "mentioned"
                : "available";
      return {
        number,
        title: String(pull.title ?? "").slice(0, 200),
        author: String(record(pull.user)?.login ?? "").slice(0, 60),
        mergedAt: pull.merged_at as string,
        status,
        mainPullRequest: mainNumber ?? mainPullNumber ?? (status === "mentioned" ? (mentionedBy ?? null) : null),
        ...(typeof pull.merge_commit_sha === "string" && /^[0-9a-f]{40}$/.test(pull.merge_commit_sha) ? { mergeCommitSha: pull.merge_commit_sha } : {}),
      };
    });
}

/** Whether a candidate may be picked: anything but released, queued in a main PR, or a workflow change. */
export const qaReleaseTrainCargoPickable = (status: QaReleaseTrainCargoStatus) =>
  status === "available" || status === "unchecked" || status === "mentioned";

/**
 * Pull requests a train skipped as already on main, by the newest train that
 * did (owner request 2026-10-29). The train cherry-picks and compares content,
 * so it sees a change main got under another commit -- #2979's goldens came in
 * a bot's re-record -- which no number or SHA in a main pull request names.
 */
export function qaReleaseTrainFoundOnMain(
  reports: readonly { slot: string; report: { pullRequestNumber?: unknown; picks?: unknown } }[],
): Map<number, string> {
  const found = new Map<number, string>();
  for (const { slot, report } of reports) {
    const train = Number.isInteger(report.pullRequestNumber) ? `#${report.pullRequestNumber}` : slot;
    for (const pick of list(report.picks)) {
      if (pick.outcome === "already_in_main" && Number.isInteger(pick.number) && !found.has(pick.number as number)) found.set(pick.number as number, train);
    }
  }
  return found;
}

/** Candidates a train found on main read as on main, whatever GitHub's records say. */
export function qaReleaseTrainWithTrainVerdicts(
  candidates: readonly QaReleaseTrainCargoCandidate[],
  found: ReadonlyMap<number, string>,
): QaReleaseTrainCargoCandidate[] {
  return candidates.map((candidate) => {
    const train = found.get(candidate.number);
    return train !== undefined && qaReleaseTrainCargoPickable(candidate.status)
      ? { ...candidate, status: "on_main", mainPullRequest: null, foundByTrain: train }
      : candidate;
  });
}

/**
 * What the train service's content check sends the verdict round: what Admin
 * lists, before any verdict is applied -- one the check found on main stays
 * in it, so its verdict is kept.
 */
export const qaReleaseTrainVerdictWanted = (status: QaReleaseTrainCargoStatus) => qaReleaseTrainCargoPickable(status) || status === "changes_workflows";

/**
 * Each candidate with its verdict (owner, 2026-10-29). One the content check
 * found on main reads as on main, like one a train found there; the rest
 * carry their verdict for Admin to show. Display only.
 */
export function qaReleaseTrainWithContentVerdicts(
  candidates: readonly QaReleaseTrainCargoCandidate[],
  verdicts: readonly QaReleaseTrainVerdict[],
): QaReleaseTrainCargoCandidate[] {
  const byNumber = new Map(verdicts.map((verdict) => [verdict.number, verdict]));
  return candidates.map((candidate) => {
    const verdict = byNumber.get(candidate.number);
    if (!verdict || !qaReleaseTrainVerdictWanted(candidate.status)) return candidate;
    return verdict.content.state === "on_main" && qaReleaseTrainCargoPickable(candidate.status)
      ? { ...candidate, status: "on_main", mainPullRequest: null, foundByContent: true, verdict }
      : { ...candidate, verdict };
  });
}

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
export type QaReleaseTrainCarried = {
  number: number;
  reason: QaReleaseTrainCarryReason;
  /** What the model said a conflict lacks; null when the train did not ask it. */
  why: string | null;
};
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
    carried.push({ number: pick.number, reason, why: typeof pick.why === "string" && pick.why !== "" ? pick.why : null });
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

/*
 * Emergency trains (owner request 2026-10-25): the operator names pull
 * requests and a reason in Admin, and the train service departs with them on
 * its next round instead of waiting for a departure hour. The request is an
 * audited Admin action; the train's emergency admission spends it. An empty
 * request withdraws a pending one.
 */
export const QA_RELEASE_TRAIN_EMERGENCY_REASON_MIN = 5;
export const QA_RELEASE_TRAIN_EMERGENCY_REASON_MAX = 300;

/** A reason as saved: trimmed, one line, within bounds. Null when not one. */
export function parseQaReleaseTrainEmergencyReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.replace(/\s+/g, " ").trim();
  return reason.length >= QA_RELEASE_TRAIN_EMERGENCY_REASON_MIN && reason.length <= QA_RELEASE_TRAIN_EMERGENCY_REASON_MAX ? reason : null;
}

export type QaReleaseTrainEmergency = {
  /**
   * The pending request, or null when none is waiting. `id` is its audit row:
   * the train names it when admitted, so a request replaced meanwhile is
   * never spent by a train assembled from the one before it.
   */
  pending: { id: string; numbers: number[]; reason: string; requestedAt: string; requestedBy: string | null } | null;
  /** The emergency departure that took the newest request, when one did. */
  departedWith: string | null;
};

/**
 * Whether an emergency admission may proceed: the request the train read and
 * assembled from is the very one still pending. A request withdrawn, already
 * spent, or replaced since the train read it is refused.
 */
export const qaReleaseTrainEmergencyAdmissible = (pending: QaReleaseTrainEmergency["pending"], requestId: string): boolean =>
  pending !== null && pending.id === requestId;

/** The emergency state from the newest request and the newest emergency admission. */
export function qaReleaseTrainEmergencyFrom(input: {
  request: { id: string; numbers: unknown; reason: unknown; at: Date; by: string | null } | null;
  admission: { slot: string; at: Date } | null;
}): QaReleaseTrainEmergency {
  const { request, admission } = input;
  if (!request) return { pending: null, departedWith: null };
  if (admission !== null && admission.at.getTime() > request.at.getTime()) return { pending: null, departedWith: admission.slot };
  const numbers = parseQaReleaseTrainCargoPick(request.numbers) ?? [];
  const reason = parseQaReleaseTrainEmergencyReason(request.reason);
  return {
    pending: numbers.length > 0 && reason !== null ? { id: request.id, numbers, reason, requestedAt: request.at.toISOString(), requestedBy: request.by } : null,
    departedWith: null,
  };
}

/**
 * Candidates the operator hid from the next train's list (owner request
 * 2026-10-27: the list is too long). Display only: the train never reads it,
 * and a hidden pull request still rides when it is picked. Saved as an
 * administrator audit row like the pick; the newest `QA_RELEASE_TRAIN_HIDDEN_MAX`
 * are kept.
 */
export const QA_RELEASE_TRAIN_HIDDEN_MAX = 500;

/** The hidden numbers from the newest saved row's metadata; anything malformed reads as none. */
export function qaReleaseTrainHiddenFrom(numbers: unknown): number[] {
  if (!Array.isArray(numbers)) return [];
  return [...new Set(numbers.filter((n): n is number => Number.isInteger(n) && n > 0))].slice(-QA_RELEASE_TRAIN_HIDDEN_MAX);
}

/** Hides or shows one number again; the newest hidden is last. */
export function qaReleaseTrainHiddenUpdate(current: readonly number[], number: number, hidden: boolean): number[] {
  const rest = current.filter((n) => n !== number);
  return hidden ? [...rest, number].slice(-QA_RELEASE_TRAIN_HIDDEN_MAX) : rest;
}
