/** The pre-transaction evidence is only a candidate. The writer compares its
 * immutable bindings again under the AMUX/engineering locks, then separately
 * reads the live switch and owner consent inside that same transaction. */
export function v22PublishPreflightEligible(input: {
  policyVersion: number;
  patchPresent: boolean;
  publicationEnabled: boolean;
}): boolean {
  return input.policyVersion >= 4 && input.patchPresent &&
    input.publicationEnabled;
}

type CandidateInput = {
  policyVersion: number;
  modeAtStart: string;
  runId: string;
  taskId: string;
  baseSha: string;
  patchDigest: string;
  publication: {
    ok: true;
    runId: string;
    taskId: string;
    baseSha: string;
    patchDigest: string;
    imageProofDigest: string | null;
    tier: { tier: string };
    candidate: { baseCommitterDate: string | null;
      changes?: readonly { path: string; previousPath?: string }[] };
  } | { ok: false } | null;
};

/** The run, card, base and patch the pending item names, exactly. */
const bindingsMatch = (input: CandidateInput) => {
  const value = input.publication;
  return input.policyVersion >= 4 && input.modeAtStart === "t1" &&
    value?.ok === true && value.candidate.baseCommitterDate !== null &&
    value.runId === input.runId && value.taskId === input.taskId &&
    value.baseSha === input.baseSha &&
    value.patchDigest === input.patchDigest;
};

export function v22PublishCandidateMatches(input: CandidateInput): boolean {
  const value = input.publication;
  // `imageProofDigest` names the deploy exclusion read from the base commit's
  // own `.dockerignore`; the base SHA below already pins it.
  return bindingsMatch(input) && value?.ok === true &&
    value.tier.tier === "T1" &&
    typeof value.imageProofDigest === "string" &&
    /^[0-9a-f]{64}$/.test(value.imageProofDigest);
}

/** A workflow file: the publisher's token has no `workflows` permission, so
 * GitHub refuses the push, and a refused push is never pushed again. */
const WORKFLOW_PATH = /^\.github\/workflows\//;

/**
 * A T2 patch the owner reviews as a draft pull request (owner decision
 * 2026-10-30): the same bindings as a T1 candidate, a T2 verdict for any
 * reason, and no workflow file. Whether the gates could be read does not
 * matter: a draft runs no CI, and only a person marks it ready.
 */
export function v22ReviewCandidateMatches(input: CandidateInput): boolean {
  const value = input.publication;
  const changes = value?.ok === true ? value.candidate.changes : undefined;
  return bindingsMatch(input) && value?.ok === true &&
    value.tier.tier === "T2" && Array.isArray(changes) && changes.length > 0 &&
    changes.every((change) => !WORKFLOW_PATH.test(change.path) &&
      !(change.previousPath && WORKFLOW_PATH.test(change.previousPath)));
}
