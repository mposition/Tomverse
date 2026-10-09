import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { AGENT_DIGEST_STORE_TIMEOUTS as LIMITS } from "@/lib/agentDigestStoreCore";
import {
  BILLING_FINANCE_OPS_CONTROL_KEY,
  BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_KEY,
  type BillingFinanceOpsControl,
  decideBillingFinanceOpsSwitchChange,
  parseBillingFinanceOpsControl,
  parseBillingFinanceOpsMonitorConfirmation,
} from "@/lib/billingFinanceOpsControl";
import { prisma } from "@/lib/prisma";

/**
 * The two operator writes of the billing-finance-ops agent
 * (docs/policy/billing-finance-ops.md §1.2–1.4): changing its app switch and
 * recording that the dead-man monitors were checked. Each is one transaction
 * holding the AppSetting write and its administrator audit entry, so neither
 * can happen without the other.
 *
 * The audit chain lock is taken before the row is read: every writer of these
 * two rows goes through here and takes it first, so two operators saving at
 * once read each other's result instead of the same revision.
 */

export const BILLING_FINANCE_OPS_CONTROL_AUDIT_ACTION = "billing_finance_ops.control_changed";
export const BILLING_FINANCE_OPS_MONITORS_AUDIT_ACTION = "billing_finance_ops.monitors_confirmed";

export class BillingFinanceOpsControlRefusedError extends Error {
  constructor(readonly code: "no_change" | "monitor_confirmation_required" | "control_unreadable") {
    super(code);
  }
}

type Db = Pick<typeof prisma, "$transaction">;
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const armLimits = (tx: Tx) => tx.$executeRaw`SELECT
  set_config('statement_timeout', ${String(LIMITS.statementMs)}, true),
  set_config('idle_in_transaction_session_timeout', ${String(LIMITS.idleMs)}, true),
  CASE WHEN current_setting('server_version_num')::int >= 170000
    THEN set_config('transaction_timeout', ${String(LIMITS.transactionMs)}, true)
  END`;

/** The database clock as epoch ms; a raw timestamptz would come back in the session's time zone. */
const databaseNowMs = async (tx: Tx) => {
  const [{ nowMs }] = await tx.$queryRaw<{ nowMs: number }[]>`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS "nowMs"`;
  return Number(nowMs);
};

const readValue = async (tx: Tx, key: string) =>
  (await tx.appSetting.findUnique({ where: { key }, select: { value: true } }))?.value ?? null;

export async function setBillingFinanceOpsSwitch(
  input: { session: Session; request?: Request; enabled: boolean },
  db: Db = prisma,
): Promise<BillingFinanceOpsControl> {
  return db.$transaction(
    async (tx) => {
      await armLimits(tx);
      await takeAuditChainLock(tx);
      const current = parseBillingFinanceOpsControl(await readValue(tx, BILLING_FINANCE_OPS_CONTROL_KEY));
      const monitorConfirmedAtMs = parseBillingFinanceOpsMonitorConfirmation(
        await readValue(tx, BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_KEY),
      );
      const decision = decideBillingFinanceOpsSwitchChange({
        current,
        enabled: input.enabled,
        monitorConfirmedAtMs,
        nowMs: await databaseNowMs(tx),
      });
      if (!decision.ok) throw new BillingFinanceOpsControlRefusedError(decision.code);

      const value = JSON.stringify(decision.next);
      await tx.appSetting.upsert({
        where: { key: BILLING_FINANCE_OPS_CONTROL_KEY },
        create: { key: BILLING_FINANCE_OPS_CONTROL_KEY, value },
        update: { value },
      });
      await writeAdminAuditLog({
        tx,
        session: input.session,
        request: input.request,
        action: BILLING_FINANCE_OPS_CONTROL_AUDIT_ACTION,
        targetType: "AppSetting",
        targetId: BILLING_FINANCE_OPS_CONTROL_KEY,
        summary: `Turned the billing-finance-ops agent ${decision.next.enabled ? "on" : "off"} (revision ${decision.next.revision}).`,
        metadata: {
          from: current.state,
          to: decision.next.enabled ? "enabled" : "disabled",
          revision: decision.next.revision,
          enabledAt: decision.next.enabledAt,
        },
      });
      return decision.next;
    },
    { maxWait: 5_000, timeout: LIMITS.prismaMs },
  );
}

export async function recordBillingFinanceOpsMonitorConfirmation(
  input: { session: Session; request?: Request },
  db: Db = prisma,
): Promise<{ confirmedAt: string }> {
  return db.$transaction(
    async (tx) => {
      await armLimits(tx);
      await takeAuditChainLock(tx);
      const confirmedAt = new Date(await databaseNowMs(tx)).toISOString();
      const value = JSON.stringify({ confirmedAt });
      await tx.appSetting.upsert({
        where: { key: BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_KEY },
        create: { key: BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_KEY, value },
        update: { value },
      });
      await writeAdminAuditLog({
        tx,
        session: input.session,
        request: input.request,
        action: BILLING_FINANCE_OPS_MONITORS_AUDIT_ACTION,
        targetType: "AppSetting",
        targetId: BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_KEY,
        // The operator's statement, under their name: the app cannot see the
        // monitors, so this records that a person checked them (§1.3).
        summary: "Confirmed the billing-finance-ops dead-man monitors are active and alerting.",
        metadata: { confirmedAt },
      });
      return { confirmedAt };
    },
    { maxWait: 5_000, timeout: LIMITS.prismaMs },
  );
}
