import "server-only";

import {
  BILLING_FINANCE_OPS_CONTROL_KEY,
  BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_KEY,
  parseBillingFinanceOpsControl,
  parseBillingFinanceOpsMonitorConfirmation,
} from "@/lib/billingFinanceOpsControl";
import {
  BILLING_FINANCE_OPS_AGENT_KEY,
  type BillingFinanceOpsDigestPayload,
  billingFinanceOpsDigestSchema,
} from "@/lib/billingFinanceOpsDigest";
import { prisma } from "@/lib/prisma";

/**
 * The billing-finance-ops tab of the common Agent digest area
 * (docs/policy/billing-finance-ops.md §1.4). Ordinary admin authentication,
 * which the console layout has established; the two writes are their own
 * routes and `canWrite` only decides whether this viewer is offered them.
 *
 * A stored body is re-read with the closed schema. A body that no longer
 * parses shows no value at all -- it is reported as unreadable rather than
 * half-rendered.
 */

/** How many recent digests the tab lists; the screen says so. */
export const BILLING_FINANCE_OPS_CONSOLE_LIMIT = 14;

export type BillingFinanceOpsConsoleRow = {
  id: string;
  createdAt: string;
  sizeBytes: number;
  body: "present" | "expired" | "unreadable";
  digest: BillingFinanceOpsDigestPayload | null;
};

export type BillingFinanceOpsConsole = {
  limit: number;
  canWrite: boolean;
  control: { state: "enabled" | "disabled" | "unreadable"; revision: number | null; enabledAt: string | null };
  monitorConfirmedAt: string | null;
  digests: BillingFinanceOpsConsoleRow[];
};

/** Pure: one stored row as the tab shows it. */
export const billingFinanceOpsConsoleRow = (row: {
  id: string;
  createdAt: Date;
  sizeBytes: number;
  payload: unknown;
}): BillingFinanceOpsConsoleRow => {
  const base = { id: row.id, createdAt: row.createdAt.toISOString(), sizeBytes: row.sizeBytes };
  if (row.payload === null) return { ...base, body: "expired", digest: null };
  const parsed = billingFinanceOpsDigestSchema.safeParse(row.payload);
  if (!parsed.success) return { ...base, body: "unreadable", digest: null };
  return { ...base, body: "present", digest: parsed.data };
};

export async function readBillingFinanceOpsConsole(canWrite: boolean): Promise<BillingFinanceOpsConsole> {
  const [control, confirmation, rows] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: BILLING_FINANCE_OPS_CONTROL_KEY }, select: { value: true } }),
    prisma.appSetting.findUnique({ where: { key: BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_KEY }, select: { value: true } }),
    prisma.agentDigestItem.findMany({
      where: { agentKey: BILLING_FINANCE_OPS_AGENT_KEY },
      orderBy: { createdAt: "desc" },
      take: BILLING_FINANCE_OPS_CONSOLE_LIMIT,
      select: { id: true, createdAt: true, sizeBytes: true, payload: true },
    }),
  ]);
  const state = parseBillingFinanceOpsControl(control?.value ?? null);
  const confirmedMs = parseBillingFinanceOpsMonitorConfirmation(confirmation?.value ?? null);
  return {
    limit: BILLING_FINANCE_OPS_CONSOLE_LIMIT,
    canWrite,
    control:
      state.state === "unreadable"
        ? { state: "unreadable", revision: null, enabledAt: null }
        : { state: state.state, revision: state.control.revision, enabledAt: state.control.enabledAt },
    monitorConfirmedAt: confirmedMs === null ? null : new Date(confirmedMs).toISOString(),
    digests: rows.map(billingFinanceOpsConsoleRow),
  };
}
