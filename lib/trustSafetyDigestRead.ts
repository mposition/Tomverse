/**
 * E2: what the trust-safety section shows, read when the screen is opened
 * (docs/policy/trust-safety-compliance-agent.md §5.6, §9, §14).
 *
 * **Zero writes.** §5.6 gives this entry point an empty allowance -- not one
 * row, not an audit entry, not an outgoing request -- and §9 says this team
 * writes no digest rows at all: the section is a display, and its values are
 * computed on open and thrown away.
 *
 * **It does not read the run table.** §5.3 keeps that table unread, which is
 * what makes the row a record rather than state; a "last successful round"
 * line here would be its first reader and would turn it into state. Whether
 * the observer is still running is answered by the external monitor (§8),
 * which is the reason that monitor exists.
 *
 * The two numbers §14 asks the operator to look at -- the count comparison
 * line and the late-closure line -- come from the counting core the observer
 * itself uses, and the activation state from the same read E1 judges with, so
 * the screen cannot disagree with the round.
 */

import "server-only";

import { getServerSession } from "next-auth/next";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { authOptions } from "@/lib/auth";
import { readTrustSafetyActivation } from "@/lib/trustSafetyActivationRead";
import type { ActivationState } from "@/lib/trustSafetyActivationCore";
import { trustSafetyIntegrityKeyEnv } from "@/lib/trustSafetyAuditEntryVerify";
import { ROUTE_BUDGET_MS } from "@/lib/trustSafetyBoundsCore";
import type { DsrDeadlineCounts } from "@/lib/trustSafetyDsrCountsCore";
import { observeDsrDeadlines } from "@/lib/trustSafetyDsrObservation";
import { withTrustSafetyTransaction } from "@/lib/trustSafetyTransaction";

/**
 * The imminence window, in days. §12 (1) approves no threshold, so zero means
 * no window has been chosen rather than a proposal standing in for one, and
 * the counts carry the number so the screen can say so.
 */
const IMMINENT_WITHIN_DAYS_UNSET = 0;

/** What the section renders. Values only: no copy, no markup, no links. */
export type TrustSafetyDigestView =
  | {
      readonly permitted: true;
      readonly activation: ActivationState;
      /** The version the config row holds, for the operator to see what moved. */
      readonly version: number | null;
      /** Null when §6's derivation does not permit counting this view. */
      readonly counts: DsrDeadlineCounts | null;
      /** The instant the values were computed, by the database clock. */
      readonly observedAt: string;
    }
  /** The caller does not hold `trust-safety:read`. Nothing was read. */
  | { readonly permitted: false };

/**
 * Reads the section's values.
 *
 * Two bounded transactions, the kinds the observer uses, so the screen is held
 * to the same statement ceilings and the same deadline (§5.5). The counts are
 * skipped when §6's derivation does not permit them: a fault means the mode is
 * not believed, and counts shown beside an unbelieved switch would read as an
 * observation that happened.
 */
export const readTrustSafetyDigest = async (): Promise<TrustSafetyDigestView> => {
  // §6: reading is `trust-safety:read` and both permissions are the owner's
  // alone, and the check is **not** hiding the section in the UI -- it is made
  // in the server component, in this read and in the activation route, each
  // fail-closed. Independent review found this missing: the console layout
  // admits any administrator, so without it a support or billing
  // administrator could open the tab and read the counts.
  const session = await getServerSession(authOptions);
  if (!session || !isAdminSession(session) || !hasAdminPermission(session, "trust-safety:read")) {
    return { permitted: false };
  }

  const env = trustSafetyIntegrityKeyEnv();
  const runDeadline = new Date(Date.now() + ROUTE_BUDGET_MS);

  const state = await withTrustSafetyTransaction({
    kind: "activation_read",
    runDeadline,
    fn: async (tx, armed) => ({
      ...(await readTrustSafetyActivation({
        tx,
        env,
        pingUrlPresent: typeof process.env.TRUST_SAFETY_OBSERVER_PING_URL === "string",
      })),
      observedAt: armed.txStart.toISOString(),
    }),
  });

  if (!state.activation.countPermitted) {
    return { permitted: true, ...state, counts: null };
  }

  const counts = await withTrustSafetyTransaction({
    kind: "dsr_read",
    runDeadline,
    fn: (tx, armed) =>
      tx.statement((client) =>
        observeDsrDeadlines({
          prisma: client,
          now: armed.txStart,
          imminentWithinDays: IMMINENT_WITHIN_DAYS_UNSET,
        }),
      ),
  });

  return { permitted: true, ...state, counts };
};
