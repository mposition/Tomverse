/**
 * The per-instance permission for the external action type
 * `engineering.publish_pr`: a single-use capability the app issues after it
 * has judged a change T1, and the publisher consumes when it claims the work.
 *
 * docs/policy/engineering-agent.md §7-2 and §11 are the contract.
 *
 * - The capability binds everything the published commit may be: the base,
 *   the patch digest, the tree id the app judged, the verifier and policy
 *   versions, and the commit fields (identity, date, run, card). Nothing about
 *   the commit is left to the publisher.
 * - Consuming it is an irrevocable, single publish reservation, made in the
 *   same transaction as the work item's `queued -> claimed`, and it binds the
 *   claim's fencing token and work item. Expiry means something only before
 *   consumption.
 * - The branch may be created only where no branch exists (expected old OID:
 *   absent). That prevents a name collision; it is not evidence of freshness.
 * - The last look before the push can only refuse.
 * - A mismatch observed after the push is an incident, not a block: the push
 *   already happened.
 *
 * Pure and dependency-free. Randomness (the fencing token) and the clock come
 * from the caller -- in practice from the database.
 */

import {
  type CommitIdentity,
  commitObjectMatches,
  engineeringBranchName,
  expectedCommitObject,
  isRunId,
} from "./engineeringAgentCore.ts";

/** Bumped whenever the tree verification or the tier rules change meaning. */
export const ENGINEERING_AGENT_VERIFIER_VERSION = 1;

/** Proposed: how long an unconsumed capability stays usable. */
export const CAPABILITY_TTL_MS = 10 * 60 * 1000;

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FENCING = /^[0-9a-f]{32,64}$/;
const DATE = /^[0-9]{1,12} [+-][0-9]{4}$/;

/** The commit fields the published commit must carry, fixed at issue. */
export type CommitFields = {
  identity: CommitIdentity;
  /** The base commit's committer timestamp and zone. */
  baseCommitterDate: string;
  runId: string;
  cardRef: string;
};

export type Capability = {
  baseSha: string;
  /** SHA-256 of the stored patch text. */
  patchDigest: string;
  /** The tree id the app judged, recomputed from the verified listing. */
  expectedTreeId: string;
  verifierVersion: number;
  policyVersion: number;
  commit: CommitFields;
  /** The branch the publisher may create, derived from the run id. */
  branch: string;
  issuedAt: Date;
  expiresAt: Date;
};

/** A consumed capability: immutable, and bound to the claim that consumed it. */
export type ConsumedCapability = Capability & {
  consumedAt: Date;
  claimFencingToken: string;
  workItemId: string;
};

export type IssueInput = Omit<Capability, "issuedAt" | "expiresAt" | "branch"> & { now: Date };

export const issueCapability = (input: IssueInput): Capability => {
  if (!SHA1.test(input.baseSha)) throw new Error("ENGINEERING_AGENT_BASE_INVALID");
  if (!SHA256.test(input.patchDigest)) throw new Error("ENGINEERING_AGENT_PATCH_DIGEST_INVALID");
  if (!SHA1.test(input.expectedTreeId)) throw new Error("ENGINEERING_AGENT_TREE_INVALID");
  if (input.verifierVersion !== ENGINEERING_AGENT_VERIFIER_VERSION) {
    throw new Error("ENGINEERING_AGENT_VERIFIER_VERSION_MISMATCH");
  }
  if (!Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1) {
    throw new Error("ENGINEERING_AGENT_POLICY_VERSION_INVALID");
  }
  if (!isRunId(input.commit.runId)) throw new Error("ENGINEERING_AGENT_RUN_ID_INVALID");
  if (!DATE.test(input.commit.baseCommitterDate)) throw new Error("ENGINEERING_AGENT_DATE_INVALID");
  // Validates the identity and card reference the same way the publisher's
  // comparison will: a capability that cannot describe a commit is not issued.
  expectedCommitObject({
    tree: input.expectedTreeId,
    baseSha: input.baseSha,
    ...input.commit,
  });
  return {
    baseSha: input.baseSha,
    patchDigest: input.patchDigest,
    expectedTreeId: input.expectedTreeId,
    verifierVersion: input.verifierVersion,
    policyVersion: input.policyVersion,
    commit: { ...input.commit, identity: { ...input.commit.identity } },
    branch: engineeringBranchName(input.commit.runId),
    issuedAt: input.now,
    expiresAt: new Date(input.now.getTime() + CAPABILITY_TTL_MS),
  };
};

/** The exact commit object the publisher must produce and push. */
export const capabilityCommitObject = (capability: Capability) =>
  expectedCommitObject({
    tree: capability.expectedTreeId,
    baseSha: capability.baseSha,
    ...capability.commit,
  });

export type ConsumeVerdict =
  | { allowed: true; consumed: ConsumedCapability }
  | {
      allowed: false;
      reason:
        | "already_consumed"
        | "expired"
        | "verifier_changed"
        | "policy_changed"
        | "fencing_invalid"
        | "work_item_invalid";
    };

/**
 * Consumes the capability for one write claim. The caller writes the returned
 * record with one conditional update in the claim transaction (`consumedAt IS
 * NULL`); the record is immutable afterwards, and nothing here or anywhere
 * else turns it back into an unconsumed capability.
 */
export const consumeCapability = (input: {
  capability: Capability;
  consumedAt: Date | null;
  now: Date;
  currentVerifierVersion: number;
  currentPolicyVersion: number;
  claimFencingToken: string;
  workItemId: string;
}): ConsumeVerdict => {
  if (input.consumedAt !== null) return { allowed: false, reason: "already_consumed" };
  if (input.now.getTime() >= input.capability.expiresAt.getTime()) {
    return { allowed: false, reason: "expired" };
  }
  if (input.capability.verifierVersion !== input.currentVerifierVersion) {
    return { allowed: false, reason: "verifier_changed" };
  }
  if (input.capability.policyVersion !== input.currentPolicyVersion) {
    return { allowed: false, reason: "policy_changed" };
  }
  if (!FENCING.test(input.claimFencingToken)) return { allowed: false, reason: "fencing_invalid" };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.workItemId)) {
    return { allowed: false, reason: "work_item_invalid" };
  }
  return {
    allowed: true,
    consumed: {
      ...input.capability,
      commit: { ...input.capability.commit, identity: { ...input.capability.commit.identity } },
      consumedAt: input.now,
      claimFencingToken: input.claimFencingToken,
      workItemId: input.workItemId,
    },
  };
};

export type LastLookReading = {
  mode: "off" | "shadow" | "t1";
  frozen: boolean;
  killSwitch: boolean;
  amuxIncidentFrozen: boolean;
  halted: boolean;
  /** The fencing token the work item currently holds. */
  currentFencingToken: string | null;
  /** The token the publisher presents. */
  presentedFencingToken: string;
  /** The consumed capability for this work item, if any. */
  consumed: ConsumedCapability | null;
  workItemId: string;
};

export type LastLookVerdict =
  | { verdict: "no_objection" }
  | {
      verdict: "refuse";
      reason:
        | "mode_not_t1"
        | "frozen"
        | "kill_switch"
        | "amux_incident"
        | "halted"
        | "stale_fencing_token"
        | "capability_not_consumed_by_this_claim";
    };

/**
 * The last look before the push. It can say "no objection" or refuse; it has
 * no way to say "allowed", because nothing after the claim can grant. The
 * window between this answer and the push is bounded by the publisher's hard
 * timeout, and a push in that window after a change here is made powerless by
 * the fencing token, not prevented.
 */
export const decideLastLook = (reading: LastLookReading): LastLookVerdict => {
  if (reading.killSwitch) return { verdict: "refuse", reason: "kill_switch" };
  if (reading.mode !== "t1") return { verdict: "refuse", reason: "mode_not_t1" };
  if (reading.frozen) return { verdict: "refuse", reason: "frozen" };
  if (reading.amuxIncidentFrozen) return { verdict: "refuse", reason: "amux_incident" };
  if (reading.halted) return { verdict: "refuse", reason: "halted" };
  if (
    reading.currentFencingToken === null ||
    reading.currentFencingToken !== reading.presentedFencingToken
  ) {
    return { verdict: "refuse", reason: "stale_fencing_token" };
  }
  if (
    reading.consumed === null ||
    reading.consumed.workItemId !== reading.workItemId ||
    reading.consumed.claimFencingToken !== reading.presentedFencingToken
  ) {
    return { verdict: "refuse", reason: "capability_not_consumed_by_this_claim" };
  }
  return { verdict: "no_objection" };
};

/**
 * The publisher's own gate before the first public write: the tree its real
 * application produced, and the commit object it built, must be exactly what
 * the capability describes.
 */
export const publisherCommitMatches = (
  capability: Capability,
  built: { treeId: string; catFileOutput: string },
) =>
  SHA1.test(built.treeId) &&
  built.treeId === capability.expectedTreeId &&
  commitObjectMatches(built.catFileOutput, {
    tree: capability.expectedTreeId,
    baseSha: capability.baseSha,
    ...capability.commit,
  });

/**
 * The push is conditioned on the branch not existing. Any existing ref -- ours
 * from an earlier attempt or anyone else's -- means stop and look (policy §10),
 * never overwrite.
 */
export const mayCreateBranch = (remoteOidForBranch: string | null) => remoteOidForBranch === null;

/**
 * After the push, what GitHub reports is compared with what was allowed: the
 * branch, and the whole commit object. A difference is not something this can
 * undo -- the branch is already public -- so the answer is an incident, never
 * a block.
 */
export const postPushObservation = (
  capability: Capability,
  observed: { branch: string; catFileOutput: string },
): "consistent" | "incident" =>
  observed.branch === capability.branch &&
  observed.catFileOutput === capabilityCommitObject(capability)
    ? "consistent"
    : "incident";
