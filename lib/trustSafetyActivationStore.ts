/**
 * E3: the person's activation write
 * (docs/policy/trust-safety-compliance-agent.md §5.6, §6, §7).
 *
 * One transaction, and §6 is explicit about why: the config row and its audit
 * entry are written together, so a failed audit write rolls the switch back.
 * §5.6 allows exactly two writes in this closure -- the single config row and
 * one `lib/adminAudit.ts` append -- and the append is the one place where that
 * module is called from this agent at all (E1 and E2 calling it is a failure).
 *
 * The statement budget is exact rather than comfortable. §12 table B gives
 * this kind `A` = 8, and the eight are: the arming statement, the deadline,
 * the read of the current row, the write of it, and the audit append's four
 * (two advisory-lock statements, the database clock, the insert). A ninth
 * statement anywhere in here is refused by the wrapper, which is the intended
 * answer -- it means the budget §12 approved no longer covers what this does.
 *
 * What this module does not do is decide. `nextActivationWrite` in
 * `lib/trustSafetyActivationCore.ts` holds §6's transition rule and the
 * version arithmetic, with no database and no session, so the rule can be
 * checked without either.
 */

import "server-only";

import type { Session } from "next-auth";

import {
  adminAuditIntegrityKeysForVerification,
  writeAdminAuditLog,
} from "@/lib/adminAudit";
import { trustSafetyIntegrityKeyEnv } from "@/lib/trustSafetyAuditEntryVerify";
import {
  TRUST_SAFETY_ACTIVATION_ACTION,
  type ActivationRefusal,
  nextActivationWrite,
} from "@/lib/trustSafetyActivationCore";
import { ROUTE_BUDGET_MS } from "@/lib/trustSafetyBoundsCore";
import { withTrustSafetyTransaction } from "@/lib/trustSafetyTransaction";

/** The single row, and the target the audit entries are bound to (§6). */
const CONFIG_ID = "singleton";
const CONFIG_TARGET_TYPE = "TrustSafetyObserverConfig";

/**
 * What one audit append costs in statements.
 *
 * §5.6 item 1 pins the shared writer's own statements by shape and number:
 * two advisory-lock `$executeRaw`, one tagged `$queryRaw` for the database
 * clock, and the insert. Charging it as a single statement would let this
 * transaction send eleven round trips under a budget approved for eight, so
 * the number is named here and a test holds it against the writer.
 */
const AUDIT_APPEND_STATEMENTS = 4;

/** What the write did, as a closed set the route turns into a status. */
export type ActivationOutcome =
  | { readonly result: "changed"; readonly fromMode: string | null; readonly toMode: string; readonly version: number }
  | { readonly result: ActivationRefusal }
  | { readonly result: "integrity_key_missing" };

/**
 * Turns the switch, or refuses and writes nothing.
 *
 * The integrity key is checked before the transaction opens, which §6 requires
 * in those words: an entry this build cannot sign is an entry §6's own checks
 * will not verify, so the switch would be turned on behind a chain that reads
 * as broken. Refusing first means no row is written at all rather than a row
 * whose audit entry cannot be trusted.
 */
export const setTrustSafetyActivation = async ({
  session,
  request,
  requested,
}: {
  readonly session: Session;
  readonly request: Request;
  readonly requested: string;
}): Promise<ActivationOutcome> => {
  if (adminAuditIntegrityKeysForVerification(trustSafetyIntegrityKeyEnv()).length === 0) {
    return { result: "integrity_key_missing" };
  }

  return withTrustSafetyTransaction({
    kind: "activation_write",
    runDeadline: new Date(Date.now() + ROUTE_BUDGET_MS),
    fn: async (tx) => {
      const current = await tx.statement((client) =>
        client.trustSafetyObserverConfig.findUnique({
          where: { id: CONFIG_ID },
          select: { mode: true, version: true },
        }),
      );

      const planned = nextActivationWrite({ current, requested });
      if (planned.refusal !== null) {
        // Nothing has been written, and the transaction ends having read one
        // row. §6: a request that is not a transition writes nothing.
        return { result: planned.refusal };
      }

      // Either the first row or the one transition. An upsert is not used:
      // Prisma may spend one statement or two on it depending on the version,
      // and this kind's budget has no spare statement to find out with.
      if (current === null) {
        await tx.statement((client) =>
          client.trustSafetyObserverConfig.create({
            data: {
              id: CONFIG_ID,
              mode: planned.toMode,
              version: planned.version,
              // Overwritten by the row's trigger from the database clock; the
              // column is NOT NULL, so a value has to be sent.
              deadlineAt: new Date(),
            },
            select: { id: true },
          }),
        );
      } else {
        await tx.statement((client) =>
          client.trustSafetyObserverConfig.update({
            where: { id: CONFIG_ID },
            data: { mode: planned.toMode, version: planned.version },
            select: { id: true },
          }),
        );
      }

      // The same transaction, as §6 requires. The metadata is the three fields
      // the section fixes and nothing else: §6's checks read `toMode` and
      // `version` out of it, and a fourth field would be a value the
      // derivation does not look at travelling in the evidence it does.
      await tx.statement(
        (client) =>
          writeAdminAuditLog({
            session,
            request,
            action: TRUST_SAFETY_ACTIVATION_ACTION,
            targetType: CONFIG_TARGET_TYPE,
            targetId: CONFIG_ID,
            summary: `Trust-safety observer activation set to ${planned.toMode}`,
            metadata: {
              fromMode: planned.fromMode,
              toMode: planned.toMode,
              version: planned.version,
            },
            tx: client,
          }),
        AUDIT_APPEND_STATEMENTS,
      );

      return {
        result: "changed",
        fromMode: planned.fromMode,
        toMode: planned.toMode,
        version: planned.version,
      };
    },
  });
};
