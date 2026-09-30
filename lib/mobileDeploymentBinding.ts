/**
 * Binding one piece of mobile-auth evidence to the deployment that made it.
 *
 * Contract: .github/audits/2026-09-09-mobile-auth-evidence-deployment-binding-approval.md,
 * approved 2026-09-09 -- option A (A1: a `dep` claim on the access token,
 * A2: `MobileRefreshRotation.mintedByDeploymentId`), E9 for the tolerance
 * window, E11 for what is deliberately left out.
 *
 * What this establishes, stated before anything else because the point of that
 * approval packet was that the previous check claimed more than it proved: a
 * match means **the process that produced this evidence read that identifier
 * out of its own environment when it produced it**, and that the value equals
 * one a person typed onto the Pending entry. It is a self-report measured
 * against a hand-entered expectation. It is not proof that the evidence came
 * from a particular Railway deployment, and it says nothing at all about
 * whether that deployment is the one now serving traffic.
 *
 * What it does NOT catch, by construction:
 *
 *   reuse      a deployment id is the same for the deployment's whole life, so
 *              old evidence from the *same* deployment matches. Freshness is a
 *              separate axis and neither replaces the other (W6).
 *   duplicates the same fresh evidence submitted twice matches twice. E11 is
 *              only partly approved and the record-based detection it points
 *              at is **not implemented** -- nothing here detects a repeat (W19).
 *
 * No environment, no crypto, no I/O: the runtime mint path and the deployment
 * verifier both call it, so a disagreement between them would be a disagreement
 * with this file rather than an unnoticed difference between two copies.
 */

/** A1 -- the claim name. Confirmed by the approver on 2026-09-09. */
export const MOBILE_ACCESS_TOKEN_DEPLOYMENT_CLAIM = "dep";

/** The variable the platform sets, and the only source either half reads. */
export const MOBILE_DEPLOYMENT_ID_ENV = "RAILWAY_DEPLOYMENT_ID";

/**
 * Whether an evidence axis may be undetermined for want of an identifier.
 *
 * E9: while the tolerance is open, evidence minted before the change carries no
 * identifier and that is **undetermined** -- not a pass, not a defect. Once
 * Active is a generation that carries the binding, the tolerance closes and a
 * missing identifier is refused, with the accepted cost that a legitimate older
 * piece of evidence is refused too.
 *
 * There is no default. Which side of the promotion a run is on is a fact about
 * the store, not about the process running the check, and a check that guessed
 * would guess "tolerant" on exactly the run where tolerance had ended.
 */
export const MOBILE_BINDING_TOLERANCE_STATES = ["open", "closed"] as const;
export type MobileBindingTolerance = (typeof MOBILE_BINDING_TOLERANCE_STATES)[number];

export type MobileBindingOutcome =
  /** Both sides present and equal. Proceed to the material comparison. */
  | "matched"
  /** Both sides present and different. Evidence is insufficient; collect again. */
  | "mismatched"
  /** The evidence names no deployment, and the tolerance is open. */
  | "undetermined"
  /** The evidence names no deployment after the tolerance closed. */
  | "refused"
  /** No expected value to compare against. Nothing was decided. */
  | "no_expectation";

export type MobileBindingVerdict = {
  outcome: MobileBindingOutcome;
  /** True only for `matched`. Every other outcome must stop a promotion. */
  ok: boolean;
  /**
   * Whether the outcome is a statement about the evidence rather than about
   * the deployment. Callers use it to pick a remedy: an evidence finding is
   * never an instruction to roll anything back.
   */
  aboutEvidence: boolean;
};

/**
 * A deployment identifier, or null.
 *
 * Trimmed, non-empty, and free of whitespace and control characters -- a value
 * with a stray newline in it came from a paste, and comparing it raw would
 * report a mismatch whose cause is invisible. Anything else is treated as
 * absent rather than repaired, because repairing an identifier is guessing.
 */
export const normalizeDeploymentId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (trimmed.length > 200) return null;
  return trimmed;
};

/** The identifier this process would stamp on the evidence it produces. */
export const deploymentIdentifierFrom = (
  environment: Record<string, string | undefined>
): string | null => normalizeDeploymentId(environment[MOBILE_DEPLOYMENT_ID_ENV]);

/**
 * One axis: does this piece of evidence name the deployment we expected?
 *
 * Comparison is exact. Case-folding a hand-entered value would be a decision
 * nobody made, and the cost of getting that wrong here is a re-collection
 * rather than a wrong promotion.
 */
export const mobileBindingVerdict = (input: {
  evidenceDeploymentId: unknown;
  expectedDeploymentId: unknown;
  tolerance: MobileBindingTolerance;
}): MobileBindingVerdict => {
  const expected = normalizeDeploymentId(input.expectedDeploymentId);
  const evidence = normalizeDeploymentId(input.evidenceDeploymentId);

  if (!expected) {
    return { outcome: "no_expectation", ok: false, aboutEvidence: true };
  }
  if (!evidence) {
    return input.tolerance === "open"
      ? { outcome: "undetermined", ok: false, aboutEvidence: true }
      : { outcome: "refused", ok: false, aboutEvidence: false };
  }
  return evidence === expected
    ? { outcome: "matched", ok: true, aboutEvidence: false }
    : { outcome: "mismatched", ok: false, aboutEvidence: true };
};
