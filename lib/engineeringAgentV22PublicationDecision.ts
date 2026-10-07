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

export function v22PublishCandidateMatches(input: {
  policyVersion: number;
  modeAtStart: string;
  runId: string;
  taskId: string;
  baseSha: string;
  patchDigest: string;
  currentImageProofDigest: string | null;
  publication: {
    ok: true;
    runId: string;
    taskId: string;
    baseSha: string;
    patchDigest: string;
    imageProofDigest: string | null;
    tier: { tier: string };
    candidate: { baseCommitterDate: string | null };
  } | { ok: false } | null;
}): boolean {
  const value = input.publication;
  return input.policyVersion >= 4 && input.modeAtStart === "t1" &&
    value?.ok === true && value.tier.tier === "T1" &&
    typeof value.imageProofDigest === "string" &&
    /^[0-9a-f]{64}$/.test(value.imageProofDigest) &&
    value.imageProofDigest === input.currentImageProofDigest &&
    value.candidate.baseCommitterDate !== null &&
    value.runId === input.runId && value.taskId === input.taskId &&
    value.baseSha === input.baseSha &&
    value.patchDigest === input.patchDigest;
}
