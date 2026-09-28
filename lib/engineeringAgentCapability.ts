/**
 * The per-instance permission for the external action type
 * `engineering.publish_pr`: a single-use capability the app issues after it
 * has judged a change T1, and the publisher consumes when it claims the work.
 *
 * docs/policy/engineering-agent.md §7-2 and §11 are the contract.
 *
 * - Consuming it is an irrevocable, single publish reservation, made in the
 *   same transaction as the work item's `queued -> claimed`. Expiry means
 *   something only before consumption.
 * - The last look before the push can only refuse. Nothing here, and nothing
 *   the publisher reports, grants anything.
 * - The expected tree id binds the capability to the exact tree the app
 *   judged; the publisher may push only a tree with that id.
 * - A mismatch observed after the push is an incident, not a block: the push
 *   already happened.
 *
 * Pure and dependency-free. Randomness (the fencing token) and the clock come
 * from the caller -- in practice from the database.
 */

/** Bumped whenever the tree verification or the tier rules change meaning. */
export const ENGINEERING_AGENT_VERIFIER_VERSION = 1;

/** Proposed: how long an unconsumed capability stays usable. */
export const CAPABILITY_TTL_MS = 10 * 60 * 1000;

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FENCING = /^[0-9a-f]{32,64}$/;

export type Capability = {
  baseSha: string;
  /** SHA-256 of the stored patch text. */
  patchDigest: string;
  /** The tree id the app judged, recomputed from the verified listing. */
  expectedTreeId: string;
  verifierVersion: number;
  policyVersion: number;
  issuedAt: Date;
  expiresAt: Date;
};

export type IssueInput = Omit<Capability, "issuedAt" | "expiresAt"> & { now: Date };

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
  return {
    baseSha: input.baseSha,
    patchDigest: input.patchDigest,
    expectedTreeId: input.expectedTreeId,
    verifierVersion: input.verifierVersion,
    policyVersion: input.policyVersion,
    issuedAt: input.now,
    expiresAt: new Date(input.now.getTime() + CAPABILITY_TTL_MS),
  };
};

export type ConsumeVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "already_consumed"
        | "expired"
        | "verifier_changed"
        | "policy_changed"
        | "fencing_invalid";
    };

/**
 * Whether a write claim may consume this capability now. The caller performs
 * the consumption as one conditional update in the claim transaction; this is
 * the condition that update encodes, kept here so the trigger and the tests
 * share it.
 */
export const decideConsumption = (input: {
  capability: Capability;
  consumedAt: Date | null;
  now: Date;
  currentVerifierVersion: number;
  currentPolicyVersion: number;
  newFencingToken: string;
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
  if (!FENCING.test(input.newFencingToken)) return { allowed: false, reason: "fencing_invalid" };
  return { allowed: true };
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
  /** The work item that consumed the capability, if any. */
  consumedByWorkItemId: string | null;
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
        | "capability_not_consumed_by_this_item";
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
  if (reading.consumedByWorkItemId !== reading.workItemId) {
    return { verdict: "refuse", reason: "capability_not_consumed_by_this_item" };
  }
  return { verdict: "no_objection" };
};

/**
 * The publisher's own gate before the first public write: the tree its real
 * application produced must be the tree the app judged.
 */
export const publisherTreeMatches = (capability: Capability, publisherTreeId: string) =>
  SHA1.test(publisherTreeId) && publisherTreeId === capability.expectedTreeId;

/**
 * After the push, what GitHub reports is compared with what was allowed. A
 * difference is not something this can undo -- the branch is already public --
 * so the answer is an incident, never a block.
 */
export const postPushObservation = (
  capability: Capability,
  observed: { treeId: string; parents: readonly string[] },
): "consistent" | "incident" =>
  observed.treeId === capability.expectedTreeId &&
  observed.parents.length === 1 &&
  observed.parents[0] === capability.baseSha
    ? "consistent"
    : "incident";
