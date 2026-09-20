/**
 * Resolving the feature flag a claim depends on.
 *
 * Contract: the S1 plan's S1e fact-source list -- "feature public: claim `gate`
 * resolves via existing production flag reader; unreadable → not public".
 *
 * A registry of gates rather than a generic reader of `feature.*` rows, because
 * a flag's stored value is not its answer. `feature.chatStarterEnabled` is off
 * whenever its kill switch is engaged regardless of the row, and each flag's
 * owning module holds that interpretation. A generic reader would consult the
 * row directly and disagree with the product about whether a feature is on --
 * and it would disagree in the dangerous direction, since a kill switch is
 * engaged precisely when something is wrong.
 *
 * So a gate is a claim-facing id bound to the real reader, and a gate nobody
 * bound resolves to unreadable.
 *
 * **The registry is empty**, for the same reason `MARKETING_CLAIMS` is: no
 * claim exists yet, so no claim names a gate, and binding one in advance would
 * be a decision about copy nobody has written. A gate is added here in the same
 * change as the claim that needs it.
 */

import "server-only";

/**
 * Gate id -> the reader that owns it.
 *
 * The reader returns the product's answer, not the row. A reader that throws is
 * handled by the resolver rather than here, so a gate never has to decide what
 * a database failure means.
 */
export const MARKETING_CLAIM_GATES: Readonly<
  Record<string, () => Promise<boolean>>
> = Object.freeze({});

/**
 * Whether the gate is on, off, or could not be read.
 *
 * Three-valued on purpose, and `resolveMarketingClaim()` refuses on two of
 * them with different codes. Collapsing unreadable into `false` would be safe
 * for publication and wrong for diagnosis: every claim behind a gate would
 * quietly stop resolving during a database incident and the refusal would say
 * the feature was switched off.
 *
 * An unknown gate id is unreadable rather than off. It means a claim names a
 * flag this build does not bind -- a registry that has drifted from the claims,
 * which somebody has to look at, not a feature somebody turned off.
 */
export async function resolveMarketingClaimGate(
  gate: string,
  registry: Readonly<
    Record<string, () => Promise<boolean>>
  > = MARKETING_CLAIM_GATES,
): Promise<boolean | null> {
  const reader = Object.prototype.hasOwnProperty.call(registry, gate)
    ? registry[gate]
    : undefined;
  if (!reader) return null;

  try {
    return await reader();
  } catch {
    // Deliberately no detail: the caller's refusal code says `gate_unreadable`
    // and a provider or database message on a marketing path is how internal
    // text reaches a public surface.
    return null;
  }
}
