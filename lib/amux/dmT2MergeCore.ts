/**
 * The Decision Maker's develop merge of a review pull request (owner decision
 * 2026-11-13: "develop 병합 권한은 DM에게 승인합니다. main은 안됩니다.", "1~4까지
 * DM에게 자동으로 하도록 승인합니다."). A review pull request the Decision
 * Maker approved from the owner queue (lib/amux/dmOwnerSettlementService.ts,
 * kind `t2_pr`) is marked ready by the app, its CI runs, and the QA-release
 * merge lane merges it into develop -- never main, never a deploy. Only a
 * pull request whose every changed path is on the allow list
 * (QA_RELEASE_DM_MERGE_ALLOW_PATTERNS, qaReleaseDmMergeAllowed) takes this
 * path; one path outside it leaves the pull request to a person.
 *
 * Pure: the switch, which paths a patch changes, whether CI admission's line
 * leaves room, and whether a pull request read fresh is still the change the
 * Decision Maker approved. Default off; off, nothing here is consulted.
 */

import { ciAdmissionRoomOutsideLine } from "../ciAdmissionCore.ts";
import { qaReleaseDmApprovedHumanPaths } from "../qaReleaseMergeLaneExclusionCore.ts";

/** Default off. On, the app marks Decision Maker approved review pull requests ready and the lane may merge them into develop. */
export const AMUX_DM_T2_MERGE_ENV = "TOMVERSE_AMUX_DM_T2_MERGE";
export const amuxDmT2MergeEnabled = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  env[AMUX_DM_T2_MERGE_ENV] === "enabled";

/** The engineering agent's own branches; nothing else is ever marked ready or merged on a Decision Maker approval. */
export const AMUX_DM_T2_MERGE_HEAD = /^agent\/engineering\/[0-9]{1,20}$/;

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * Every path a unified diff names, both sides of a rename; null when it names
 * none, which judges nothing.
 */
export function amuxDmT2MergePatchPaths(patch: string | null): string[] | null {
  if (typeof patch !== "string") return null;
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.replace(/\r$/, ""));
    if (!header) continue;
    paths.add(header[1]!);
    paths.add(header[2]!);
  }
  return paths.size > 0 ? [...paths] : null;
}

export type AmuxDmT2MergeGate =
  | { pass: true }
  | { pass: false; reason: "outside_dm_merge_allowlist" | "paths_unreadable"; paths: string[] };

/**
 * Whether a change may take the automatic path: every one of its paths is on
 * the allow list, and its paths could be read at all. Anything else is left to
 * a person.
 */
export function amuxDmT2MergeGate(paths: readonly string[] | null): AmuxDmT2MergeGate {
  if (paths === null || paths.length === 0) return { pass: false, reason: "paths_unreadable", paths: [] };
  const human = qaReleaseDmApprovedHumanPaths(paths);
  return human.length === 0 ? { pass: true } : { pass: false, reason: "outside_dm_merge_allowlist", paths: human.slice(0, 20) };
}

/**
 * Whether CI admission's line leaves room for one more develop pull request's
 * CI after this round: the admission's own rule (lib/ciAdmissionCore.ts),
 * judged once early to skip the GitHub reads, and again under its lock when
 * the reservation is written.
 */
export const amuxDmT2MergeRoomBesideLine = ciAdmissionRoomOutsideLine;

export type AmuxDmT2MergeApproved = {
  prNumber: number; headRef: string; approvedHeadSha: string; approvedDiffDigest: string;
};

/** The pull request as CI admission's App reads it now; `fork` when its head is not this repository's. */
export type AmuxDmT2MergePullNow = {
  open: boolean; draft: boolean; base: string; head: string; headSha: string; fork: boolean;
};

/** The pull request's change as the engineering agent's read-only token reads it now. */
export type AmuxDmT2MergeChangeNow = {
  state: "open" | "closed"; baseRef: string; headRef: string; headSha: string;
  diffDigest: string | null; changedFiles: string[] | null;
  /** The head is in another repository than the base (a fork), or that could not be read. */
  crossRepository: boolean;
};

export type AmuxDmT2MergeSkipReason = "pull_closed" | "fork_pr" | "base_not_develop" | "branch_moved" | "head_moved" |
  "diff_unreadable" | "diff_changed" | "paths_unreadable" | "outside_dm_merge_allowlist";

/**
 * Whether a pull request's change, read fresh from GitHub, is still the one
 * the Decision Maker approved: open, into develop, on the approved branch and
 * head, its diff byte for byte the approved one (a merge base that moved with
 * develop changes it), and every path on the allow list. Anything unread or
 * different does not hold. What the app checks before it marks a pull request
 * ready and every time it tells the merge lane of one.
 */
export function amuxDmT2MergeChangeVerdict(input: {
  approved: AmuxDmT2MergeApproved;
  change: AmuxDmT2MergeChangeNow;
}): { holds: true } | { holds: false; reason: AmuxDmT2MergeSkipReason; paths?: string[] } {
  const { approved, change } = input;
  if (!SHA.test(approved.approvedHeadSha) || !DIGEST.test(approved.approvedDiffDigest) ||
      !AMUX_DM_T2_MERGE_HEAD.test(approved.headRef)) return { holds: false, reason: "head_moved" };
  if (change.state !== "open") return { holds: false, reason: "pull_closed" };
  // A fork's pull request is never on the automatic path (review r-20261113-141554-d75157).
  if (change.crossRepository !== false) return { holds: false, reason: "fork_pr" };
  if (change.baseRef !== "develop") return { holds: false, reason: "base_not_develop" };
  if (change.headRef !== approved.headRef) return { holds: false, reason: "branch_moved" };
  if (change.headSha !== approved.approvedHeadSha) return { holds: false, reason: "head_moved" };
  if (change.diffDigest === null) return { holds: false, reason: "diff_unreadable" };
  if (change.diffDigest !== approved.approvedDiffDigest) return { holds: false, reason: "diff_changed" };
  const gate = amuxDmT2MergeGate(change.changedFiles);
  return gate.pass ? { holds: true } : { holds: false, reason: gate.reason, paths: gate.paths };
}

export type AmuxDmT2MergeReadyVerdict =
  | { verdict: "ready" }
  | { verdict: "already_ready" }
  | { verdict: "skip"; reason: AmuxDmT2MergeSkipReason; paths?: string[] };

/**
 * Whether a Decision Maker approved pull request, read fresh from GitHub just
 * before the write, may be marked ready: CI admission's App sees it open, into
 * develop, on the approved branch and head, and its change still holds
 * (amuxDmT2MergeChangeVerdict). A pull request already ready needs nothing.
 * Anything unread or different is skipped this round and read again later.
 */
export function amuxDmT2MergeReadyVerdict(input: {
  approved: AmuxDmT2MergeApproved;
  pull: AmuxDmT2MergePullNow | null;
  change: AmuxDmT2MergeChangeNow;
}): AmuxDmT2MergeReadyVerdict {
  const { approved, pull, change } = input;
  if (!SHA.test(approved.approvedHeadSha) || !DIGEST.test(approved.approvedDiffDigest) ||
      !AMUX_DM_T2_MERGE_HEAD.test(approved.headRef)) return { verdict: "skip", reason: "head_moved" };
  if (pull === null || !pull.open) return { verdict: "skip", reason: "pull_closed" };
  if (pull.fork !== false) return { verdict: "skip", reason: "fork_pr" };
  if (pull.base !== "develop") return { verdict: "skip", reason: "base_not_develop" };
  if (pull.head !== approved.headRef) return { verdict: "skip", reason: "branch_moved" };
  if (pull.headSha !== approved.approvedHeadSha) return { verdict: "skip", reason: "head_moved" };
  if (!pull.draft) return { verdict: "already_ready" };
  const held = amuxDmT2MergeChangeVerdict({ approved, change });
  return held.holds ? { verdict: "ready" } :
    { verdict: "skip", reason: held.reason, ...(held.paths ? { paths: held.paths } : {}) };
}
