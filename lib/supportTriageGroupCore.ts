/**
 * Support-triage group candidates from server facts (policy section 6,
 * design section 5.4). Pure: no I/O.
 *
 * A group is one equivalence class of one kind: every member shares the same
 * server value for that kind, and the group stores only the SHA-256 of that
 * value (`primarySnapshotDigest`), never the value. The three kinds are
 * equality comparisons of server facts, so their classes are well defined:
 *
 *   server_evidence_match  every member's token verified and its linked
 *                          evidence has the same errorCode, routeClass and
 *                          release (none of them missing);
 *   same_account           the same non-null userId (a guest report has none,
 *                          so guests never share an account);
 *   autofix_fingerprint    the same non-null auto-fix case fingerprint.
 *
 * Report text and anything derived from it (keyword flags, the suggestion
 * input digest) never reaches this module: it cannot form or join a group.
 *
 * A report belongs to at most one open group. When it could join several, the
 * kind priority decides (`GROUP_KIND_PRIORITY`), and a report already in an
 * open group moves only to a strictly higher kind, so it moves at most twice.
 */
import { createHash } from "node:crypto";

import { GROUP_KIND_PRIORITY, GROUP_MEMBER_CAP, type GroupKind } from "./supportTriageCore";
import { canonicalJson } from "./supportTriageDecisionDigest";
import { SUPPORT_TRIAGE_CORE_VERSION } from "./supportTriageInputDigest";

/** The server facts of one report that grouping reads. Nothing here is report text. */
export type GroupFacts = {
  readonly feedbackId: string;
  readonly status: string;
  readonly userId: string | null;
  readonly errorReportVerification: string | null;
  readonly evidence: {
    readonly errorCode: string | null;
    readonly routeClass: string;
    readonly release: string | null;
    readonly occurredAt: Date;
  } | null;
  readonly autoFixFingerprint: string | null;
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The canonical server value of `kind` for one report, or null when the report has none. */
export const groupSnapshotValue = (kind: GroupKind, facts: GroupFacts): unknown => {
  switch (kind) {
    case "server_evidence_match": {
      const evidence = facts.evidence;
      // A missing part is not a value: two reports that both lack a release
      // are not known to share one.
      if (facts.errorReportVerification !== "verified" || evidence === null) return null;
      if (evidence.errorCode === null || evidence.release === null) return null;
      return { errorCode: evidence.errorCode, routeClass: evidence.routeClass, release: evidence.release };
    }
    case "same_account":
      return facts.userId;
    case "autofix_fingerprint":
      return facts.autoFixFingerprint;
    default:
      throw new RangeError("unknown group kind");
  }
};

/** SHA-256 hex of the canonical JSON of a kind's server value. */
export const groupSnapshotDigest = (value: unknown): string => {
  if (value === null || value === undefined) throw new RangeError("a snapshot digest needs a value");
  return sha256(canonicalJson(value));
};

/** The digest of `kind` for one report, or null when the report has no value for it. */
export const reportSnapshotDigest = (kind: GroupKind, facts: GroupFacts): string | null => {
  const value = groupSnapshotValue(kind, facts);
  return value === null || value === undefined ? null : groupSnapshotDigest(value);
};

const sortedIds = (ids: readonly string[]) => {
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1]) throw new RangeError("member ids must be distinct");
  }
  return sorted;
};

/**
 * The unique key of an open group: kind, primary digest and the sorted member
 * ids. Two groups of different kinds over the same members get different keys.
 */
export const groupCandidateKey = (input: {
  readonly primaryKind: GroupKind;
  readonly primarySnapshotDigest: string;
  readonly memberIds: readonly string[];
}): string =>
  sha256(
    canonicalJson({
      primaryKind: input.primaryKind,
      primarySnapshotDigest: input.primarySnapshotDigest,
      members: sortedIds(input.memberIds),
      coreVersion: SUPPORT_TRIAGE_CORE_VERSION,
    })
  );

/**
 * What a displayed group is bound to: its key, each member's current status
 * and each signal's digest. A status change or a signal change is a new value.
 */
export const groupInputDigest = (input: {
  readonly groupCandidateKey: string;
  readonly members: readonly { readonly feedbackId: string; readonly status: string }[];
  readonly signals: readonly { readonly kind: GroupKind; readonly snapshotDigest: string }[];
}): string => {
  const ids = sortedIds(input.members.map((member) => member.feedbackId));
  const statusById = new Map(input.members.map((member) => [member.feedbackId, member.status]));
  const kinds = input.signals.map((signal) => signal.kind);
  if (new Set(kinds).size !== kinds.length) throw new RangeError("one signal per kind");
  const signals = [...input.signals].sort(
    (a, b) => GROUP_KIND_PRIORITY.indexOf(a.kind) - GROUP_KIND_PRIORITY.indexOf(b.kind)
  );
  return sha256(
    canonicalJson({
      groupCandidateKey: input.groupCandidateKey,
      members: ids.map((feedbackId) => [feedbackId, statusById.get(feedbackId)]),
      signals: signals.map((signal) => [signal.kind, signal.snapshotDigest]),
      coreVersion: SUPPORT_TRIAGE_CORE_VERSION,
    })
  );
};

export type GroupCandidate = {
  readonly kind: GroupKind;
  readonly snapshotDigest: string;
  /** Sorted, at least two. May exceed the member cap; the writer refuses those. */
  readonly memberIds: readonly string[];
};

/**
 * Every equivalence class of two or more reports, for every kind, ordered by
 * kind priority and then by digest. A report may appear in one class per kind;
 * which one it joins is the writer's decision (`membershipAction`).
 */
export const groupCandidatesFrom = (reports: readonly GroupFacts[]): GroupCandidate[] => {
  sortedIds(reports.map((report) => report.feedbackId));
  const candidates: GroupCandidate[] = [];
  for (const kind of GROUP_KIND_PRIORITY) {
    const classes = new Map<string, string[]>();
    for (const report of reports) {
      const digest = reportSnapshotDigest(kind, report);
      if (digest === null) continue;
      const members = classes.get(digest) ?? [];
      members.push(report.feedbackId);
      classes.set(digest, members);
    }
    const digests = [...classes.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const snapshotDigest of digests) {
      const memberIds = classes.get(snapshotDigest) as string[];
      if (memberIds.length >= 2) candidates.push({ kind, snapshotDigest, memberIds: sortedIds(memberIds) });
    }
  }
  return candidates;
};

/** Whether a candidate is over the member cap and so is never written. */
export const exceedsGroupMemberCap = (candidate: GroupCandidate) => candidate.memberIds.length > GROUP_MEMBER_CAP;

/**
 * What a report does with a candidate of `candidateKind`, given the kind of
 * the open group it is in now (null when none): join it, move to it (strictly
 * higher kind only), or stay where it is.
 */
export const membershipAction = (
  currentKind: GroupKind | null,
  candidateKind: GroupKind
): "join" | "move" | "stay" => {
  const candidateRank = GROUP_KIND_PRIORITY.indexOf(candidateKind);
  if (candidateRank < 0) throw new RangeError("unknown group kind");
  if (currentKind === null) return "join";
  const currentRank = GROUP_KIND_PRIORITY.indexOf(currentKind);
  if (currentRank < 0) throw new RangeError("unknown group kind");
  return candidateRank < currentRank ? "move" : "stay";
};

/**
 * The signals a group of `primaryKind` over `members` carries: its primary
 * kind always, and another kind only when every member shares that kind's
 * value. Ordered by kind priority.
 */
export const sharedGroupSignals = (
  primaryKind: GroupKind,
  members: readonly GroupFacts[]
): { kind: GroupKind; snapshotDigest: string }[] => {
  if (members.length < 2) throw new RangeError("a group has at least two members");
  sortedIds(members.map((member) => member.feedbackId));
  const signals: { kind: GroupKind; snapshotDigest: string }[] = [];
  for (const kind of GROUP_KIND_PRIORITY) {
    const digests = new Set(members.map((member) => reportSnapshotDigest(kind, member)));
    const [only] = digests;
    if (digests.size === 1 && only !== null && only !== undefined) {
      signals.push({ kind, snapshotDigest: only });
    } else if (kind === primaryKind) {
      throw new RangeError("the members do not share the primary kind's value");
    }
  }
  return signals;
};

/** Evidence-derived signals live no longer than their earliest evidence's retention. */
export const SERVER_EVIDENCE_SIGNAL_DAYS = 30;

/** When a server_evidence_match signal over these members expires: the earliest occurrence plus 30 days. */
export const serverEvidenceSignalExpiresAt = (members: readonly GroupFacts[]): Date => {
  let earliest: number | null = null;
  for (const member of members) {
    if (member.evidence === null) throw new RangeError("every member needs evidence");
    const at = member.evidence.occurredAt.getTime();
    if (!Number.isFinite(at)) throw new RangeError("invalid occurrence time");
    if (earliest === null || at < earliest) earliest = at;
  }
  if (earliest === null) throw new RangeError("a group has at least two members");
  return new Date(earliest + SERVER_EVIDENCE_SIGNAL_DAYS * 24 * 60 * 60 * 1000);
};

/**
 * A signal whose value is not evidence (an account, a fingerprint) has no
 * clock of its own: it lives while its group is open, and the group's own
 * lifecycle ends it. The column is NOT NULL, so this far bound stands for
 * "no snapshot expiry"; retention never reaches it.
 */
export const OPEN_GROUP_SIGNAL_EXPIRES_AT = new Date("9999-12-31T00:00:00.000Z");

/** New memberships one pass may create for new groups (policy section 8: the pass share of 50). */
export const GROUP_NEW_MEMBERSHIPS_PER_PASS_MAX = 50;

/** The open group a report is a member of now. */
export type OpenMembership = {
  readonly groupId: string;
  readonly state: string;
  readonly kind: GroupKind;
  readonly snapshotDigest: string;
};

export type GroupSignalPlan = { readonly kind: GroupKind; readonly snapshotDigest: string; readonly expiresAt: Date };

/** What a group over exactly these members is bound to: its key, input digest and signals. */
export const groupBinding = (kind: GroupKind, snapshotDigest: string, members: readonly GroupFacts[]) => {
  const signals: GroupSignalPlan[] = sharedGroupSignals(kind, members).map((signal) => ({
    ...signal,
    expiresAt:
      signal.kind === "server_evidence_match" ? serverEvidenceSignalExpiresAt(members) : OPEN_GROUP_SIGNAL_EXPIRES_AT,
  }));
  const primary = signals.find((signal) => signal.kind === kind);
  if (!primary || primary.snapshotDigest !== snapshotDigest) {
    throw new RangeError("the members do not share the group's primary value");
  }
  const key = groupCandidateKey({
    primaryKind: kind,
    primarySnapshotDigest: snapshotDigest,
    memberIds: members.map((member) => member.feedbackId),
  });
  return {
    groupCandidateKey: key,
    groupInputDigest: groupInputDigest({
      groupCandidateKey: key,
      members: members.map((member) => ({ feedbackId: member.feedbackId, status: member.status })),
      signals,
    }),
    signals,
  };
};

export type PlannedGroup = {
  readonly kind: GroupKind;
  readonly snapshotDigest: string;
  readonly memberIds: readonly string[];
  readonly groupCandidateKey: string;
  readonly groupInputDigest: string;
  readonly signals: readonly GroupSignalPlan[];
};

export type PlannedJoin = {
  readonly groupId: string;
  readonly kind: GroupKind;
  readonly snapshotDigest: string;
  /** The group's members when it was locked. */
  readonly existingIds: readonly string[];
  /** Reports in no open group that join it. */
  readonly newcomerIds: readonly string[];
};

export type GroupPlan = {
  readonly planned: PlannedGroup[];
  readonly joins: PlannedJoin[];
  /** A class over the member cap: never written (policy section 6, loss (2)). */
  readonly memberCapReached: number;
  /**
   * A class whose open group cannot be joined now: it is confirmed (a person
   * decided on its members), or one of its members is no longer eligible or
   * no longer shares the value. Retention and the key recheck deal with those.
   */
  readonly joinDeferred: number;
  /** A class some of whose members sit in a lower-kind group; moving them comes later. */
  readonly moveDeferred: number;
  /** A class left out because the pass's membership budget ran out. */
  readonly budgetDeferred: number;
  readonly membershipsUsed: number;
};

/**
 * New groups and joins. Every class with an arriving report (one just made
 * ready in this batch) is considered in priority order.
 *
 * When the class already has an open group of its kind and value, the reports
 * of the class that are in no open group join it (the lowest group id, when a
 * concurrent pass made two). Only a candidate group is joined, and only when
 * every current member is still eligible and still shares the value.
 *
 * Otherwise a new group is made from the reports in no open group, and not
 * given to a higher-priority class in this plan; it must still be two or more.
 *
 * Either way the result must stay within the member cap, and classes are
 * admitted as a prefix while their new memberships fit the remaining budget.
 * The caller locks every group in `groupMembers` before calling, so the member
 * lists cannot change before its writes.
 */
export const planGroups = (input: {
  readonly reports: readonly GroupFacts[];
  readonly arriving: readonly string[];
  readonly memberships: ReadonlyMap<string, OpenMembership>;
  readonly groupMembers: ReadonlyMap<string, readonly string[]>;
  readonly membershipBudget: number;
}): GroupPlan => {
  if (!Number.isSafeInteger(input.membershipBudget) || input.membershipBudget < 0) {
    throw new RangeError("membershipBudget must be a non-negative integer");
  }
  const byId = new Map(input.reports.map((report) => [report.feedbackId, report]));
  const arriving = new Set(input.arriving);
  for (const id of arriving) if (!byId.has(id)) throw new RangeError("an arriving report has no facts");
  const assigned = new Set<string>();
  const planned: PlannedGroup[] = [];
  const joins: PlannedJoin[] = [];
  let memberCapReached = 0;
  let joinDeferred = 0;
  let moveDeferred = 0;
  let budgetDeferred = 0;
  let used = 0;
  const admit = (count: number) => {
    // A prefix only: once one class is left out for budget, every later one is too.
    if (budgetDeferred > 0 || used + count > input.membershipBudget) {
      budgetDeferred += 1;
      return false;
    }
    used += count;
    return true;
  };
  for (const candidate of groupCandidatesFrom(input.reports)) {
    if (!candidate.memberIds.some((id) => arriving.has(id))) continue;
    const current = candidate.memberIds.map((id) => input.memberships.get(id) ?? null);
    if (current.some((m) => m !== null && membershipAction(m.kind, candidate.kind) === "move")) moveDeferred += 1;
    const free = candidate.memberIds.filter((id) => !input.memberships.has(id) && !assigned.has(id));
    const sameValue = current.filter(
      (m): m is OpenMembership =>
        m !== null && m.kind === candidate.kind && m.snapshotDigest === candidate.snapshotDigest
    );
    if (sameValue.length > 0) {
      if (!free.some((id) => arriving.has(id))) continue;
      const target = [...sameValue].sort((a, b) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0))[0];
      const existingIds = input.groupMembers.get(target.groupId);
      if (existingIds === undefined) throw new RangeError("a target group's members were not read");
      const joinable =
        target.state === "candidate" &&
        existingIds.every((id) => {
          const facts = byId.get(id);
          return facts !== undefined && reportSnapshotDigest(candidate.kind, facts) === candidate.snapshotDigest;
        });
      if (!joinable) {
        joinDeferred += 1;
        continue;
      }
      if (existingIds.length + free.length > GROUP_MEMBER_CAP) {
        memberCapReached += 1;
        continue;
      }
      if (!admit(free.length)) continue;
      joins.push({
        groupId: target.groupId,
        kind: candidate.kind,
        snapshotDigest: candidate.snapshotDigest,
        existingIds: sortedIds(existingIds),
        newcomerIds: free,
      });
      for (const id of free) assigned.add(id);
      continue;
    }
    if (free.length < 2 || !free.some((id) => arriving.has(id))) continue;
    if (free.length > GROUP_MEMBER_CAP) {
      memberCapReached += 1;
      continue;
    }
    if (!admit(free.length)) continue;
    const binding = groupBinding(
      candidate.kind,
      candidate.snapshotDigest,
      free.map((id) => byId.get(id) as GroupFacts)
    );
    planned.push({ kind: candidate.kind, snapshotDigest: candidate.snapshotDigest, memberIds: free, ...binding });
    for (const id of free) assigned.add(id);
  }
  return { planned, joins, memberCapReached, joinDeferred, moveDeferred, budgetDeferred, membershipsUsed: used };
};
