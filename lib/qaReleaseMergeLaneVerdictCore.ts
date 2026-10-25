/**
 * What the merge lane thinks of every open develop pull request, for the
 * Admin screen (owner, 2026-10-23: "show which pull requests the lane cannot
 * merge, and why, so I know which are mine"). Display only: the lane's pick is
 * still pickQaReleaseLaneCandidate's, and nothing here feeds back into it.
 *
 * Pure: the round passes what it already read. A pull request whose exclusion
 * was not judged is `queued` -- the lane will judge it on its turn -- never
 * guessed as clear or excluded.
 */
import { refusalReason } from "../scripts/merge-train-core.mjs";
import type { QaReleaseLanePullRequest } from "./qaReleaseMergeLaneCandidateCore.ts";
import type { QaReleaseExclusion, QaReleaseExclusionReason } from "./qaReleaseMergeLaneExclusionCore.ts";

export type QaReleaseLaneVerdictStatus =
  /** The lane merges it next. */
  | "next"
  /** Ready and clear, or not judged yet: its turn comes after the pick. */
  | "queued"
  /** Not ready for a reason that settles by itself: checks running, mergeability not computed. */
  | "waiting"
  /** Changes a path the lane leaves to a person: a person merges it. */
  | "human"
  /** Not ready for a reason someone has to fix: a failed check, a conflict. */
  | "fix"
  | "draft";

export type QaReleaseLaneVerdict = {
  number: number;
  title: string;
  headRefName: string;
  status: QaReleaseLaneVerdictStatus;
  /** The readiness refusal (`checks_failed`, `mergeable_conflicting` ...) or the exclusion reasons. */
  reasons: string[];
  /** For `human`: the files that decided it, with their reasons. */
  files: { path: string; reasons: QaReleaseExclusionReason[] }[];
  /** For `fix`: the failed checks by name. */
  failedChecks: string[];
};

const SETTLES = new Set(["checks_pending", "checks_none", "checks_missing_required", "mergeable_unknown"]);
const MAX_LISTED = 60;

const failedChecksOf = (pull: QaReleaseLanePullRequest): string[] =>
  pull.statusCheckRollup
    .map((raw) => raw as Record<string, unknown>)
    .filter((check) =>
      check.__typename === "StatusContext"
        ? !["SUCCESS", "PENDING", "EXPECTED"].includes(String(check.state))
        : check.status === "COMPLETED" && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(String(check.conclusion)),
    )
    .map((check) =>
      check.__typename === "StatusContext"
        ? String(check.context)
        : [check.workflowName, check.name].filter((part) => typeof part === "string" && part !== "").join(" › "),
    )
    .slice(0, 5);

export function qaReleaseLaneVerdicts(input: {
  pulls: readonly QaReleaseLanePullRequest[];
  exclusions: ReadonlyMap<number, QaReleaseExclusion>;
  excludingFiles: ReadonlyMap<number, { path: string; reasons: QaReleaseExclusionReason[] }[]>;
  pickNumber: number | null;
}): QaReleaseLaneVerdict[] {
  return input.pulls
    .filter((pull) => pull.baseRefName === "develop")
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number)
    .slice(0, MAX_LISTED)
    .map((pull): QaReleaseLaneVerdict => {
      const base = {
        number: pull.number,
        title: (pull.title ?? "").slice(0, 200),
        headRefName: pull.headRefName.slice(0, 200),
        reasons: [] as string[],
        files: [] as QaReleaseLaneVerdict["files"],
        failedChecks: [] as string[],
      };
      if (pull.number === input.pickNumber) return { ...base, status: "next" };
      if (pull.isDraft) return { ...base, status: "draft" };
      const notReady = refusalReason(pull, "develop") as string | null;
      if (notReady !== null) {
        if (SETTLES.has(notReady)) return { ...base, status: "waiting", reasons: [notReady] };
        return { ...base, status: "fix", reasons: [notReady], failedChecks: notReady === "checks_failed" ? failedChecksOf(pull) : [] };
      }
      const exclusion = input.exclusions.get(pull.number);
      if (exclusion?.excluded) {
        return { ...base, status: "human", reasons: [...exclusion.reasons], files: [...(input.excludingFiles.get(pull.number) ?? [])] };
      }
      return { ...base, status: "queued" };
    });
}
