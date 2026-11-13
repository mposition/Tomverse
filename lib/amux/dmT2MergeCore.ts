/**
 * The Decision Maker's develop merge of a review pull request (owner decision
 * 2026-11-13: "develop 병합 권한은 DM에게 승인합니다. main은 안됩니다.", "1~4까지
 * DM에게 자동으로 하도록 승인합니다."). A review pull request the Decision
 * Maker approved from the owner queue (lib/amux/dmOwnerSettlementService.ts,
 * kind `t2_pr`) is marked ready by the app, its CI runs, and the QA-release
 * merge lane merges it into develop -- never main, never a deploy. A pull
 * request that changes a gate or irreversible path
 * (QA_RELEASE_DM_APPROVED_HUMAN_PATTERNS) stays a person's.
 *
 * Pure: the switch, which paths a patch changes, whether CI admission's line
 * leaves room, and whether a pull request read fresh is still the change the
 * Decision Maker approved. Default off; off, nothing here is consulted.
 */

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
  | { pass: false; reason: "irreversible_path" | "paths_unreadable"; paths: string[] };

/**
 * Whether a change may take the automatic path: none of its paths is a gate
 * or irreversible one, and its paths could be read at all. Anything else is
 * left to a person.
 */
export function amuxDmT2MergeGate(paths: readonly string[] | null): AmuxDmT2MergeGate {
  if (paths === null || paths.length === 0) return { pass: false, reason: "paths_unreadable", paths: [] };
  const human = qaReleaseDmApprovedHumanPaths(paths);
  return human.length === 0 ? { pass: true } : { pass: false, reason: "irreversible_path", paths: human.slice(0, 20) };
}

/** Line statuses of a draft that still waits for runners: the line goes first. */
const LINE_WAITING = new Set(["waiting", "checking", "next", "updating"]);

/**
 * Whether CI admission's line leaves room for one more develop pull request's
 * CI after this round. The engineering agent's pull requests are not in the
 * line (lib/ciAdmissionCore.ts): once ready, their CI counts as another
 * workflow's, which the line cannot send back. So one is marked ready only
 * when no draft in the line still waits for runners, and its whole need fits
 * beside every run counted now: it never jumps the line.
 */
export function amuxDmT2MergeRoomBesideLine(input: {
  queue: readonly { draft: boolean; status: string }[];
  used: number;
  capacity: number;
  need: number;
}): boolean {
  if (input.queue.some((entry) => entry.draft && LINE_WAITING.has(entry.status))) return false;
  return Number.isFinite(input.used) && input.used + input.need <= input.capacity;
}

export type AmuxDmT2MergeApproved = {
  prNumber: number; headRef: string; approvedHeadSha: string; approvedDiffDigest: string;
};

/** The pull request as CI admission's App reads it now. */
export type AmuxDmT2MergePullNow = { open: boolean; draft: boolean; base: string; head: string; headSha: string };

/** The pull request's change as the engineering agent's read-only token reads it now. */
export type AmuxDmT2MergeChangeNow = {
  state: "open" | "closed"; baseRef: string; headRef: string; headSha: string;
  diffDigest: string | null; changedFiles: string[] | null;
};

export type AmuxDmT2MergeReadyVerdict =
  | { verdict: "ready" }
  | { verdict: "already_ready" }
  | { verdict: "skip"; reason: "pull_closed" | "base_not_develop" | "branch_moved" | "head_moved" |
      "diff_unreadable" | "diff_changed" | "paths_unreadable" | "irreversible_path"; paths?: string[] };

/**
 * Whether a Decision Maker approved pull request, read fresh from GitHub just
 * before the write, may be marked ready: open, into develop, on the approved
 * branch and head, its diff byte for byte the approved one, and no path a
 * person must merge. A pull request already ready needs nothing. Anything
 * unread or different is skipped this round and read again on a later one.
 */
export function amuxDmT2MergeReadyVerdict(input: {
  approved: AmuxDmT2MergeApproved;
  pull: AmuxDmT2MergePullNow | null;
  change: AmuxDmT2MergeChangeNow;
}): AmuxDmT2MergeReadyVerdict {
  const { approved, pull, change } = input;
  if (!SHA.test(approved.approvedHeadSha) || !DIGEST.test(approved.approvedDiffDigest) ||
      !AMUX_DM_T2_MERGE_HEAD.test(approved.headRef)) return { verdict: "skip", reason: "head_moved" };
  if (pull === null || !pull.open || change.state !== "open") return { verdict: "skip", reason: "pull_closed" };
  if (pull.base !== "develop" || change.baseRef !== "develop") return { verdict: "skip", reason: "base_not_develop" };
  if (pull.head !== approved.headRef || change.headRef !== approved.headRef) return { verdict: "skip", reason: "branch_moved" };
  if (pull.headSha !== approved.approvedHeadSha || change.headSha !== approved.approvedHeadSha)
    return { verdict: "skip", reason: "head_moved" };
  if (!pull.draft) return { verdict: "already_ready" };
  if (change.diffDigest === null) return { verdict: "skip", reason: "diff_unreadable" };
  if (change.diffDigest !== approved.approvedDiffDigest) return { verdict: "skip", reason: "diff_changed" };
  const gate = amuxDmT2MergeGate(change.changedFiles);
  return gate.pass ? { verdict: "ready" } : { verdict: "skip", reason: gate.reason, paths: gate.paths };
}
