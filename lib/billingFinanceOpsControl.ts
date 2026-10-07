/**
 * The billing-finance-ops app switch (docs/policy/billing-finance-ops.md §1.2).
 *
 * One AppSetting row, seeded off by migration
 * 20261004000000_agent_digest_billing_finance_ops and changed only by the
 * Admin control route. The reader answers one of three states, and the third
 * is the point: a row that is missing, malformed or unreadable is
 * `unreadable`, never `disabled`. Folding it into "off" would let a database
 * fault or a corrupted row look like the operator's choice -- the trigger
 * service would then send its liveness signal and the silence check would
 * skip the day, so the fault would be hidden by both of the signals meant to
 * show it.
 *
 * Only `enabled` lets a run proceed.
 */

import { z } from "zod";

export const BILLING_FINANCE_OPS_CONTROL_KEY = "billingFinanceOps.control";

const controlSchema = z
  .object({
    enabled: z.boolean(),
    revision: z.number().int().min(0),
    enabledAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  // On means it was switched on at a known instant; off means it was not.
  .refine((value) => (value.enabled ? value.enabledAt !== null : value.enabledAt === null));

export type BillingFinanceOpsControl = z.infer<typeof controlSchema>;

export type BillingFinanceOpsControlState =
  | { state: "enabled"; control: BillingFinanceOpsControl }
  | { state: "disabled"; control: BillingFinanceOpsControl }
  | { state: "unreadable" };

/** The state a stored value means. `null` (no row) is unreadable. */
export const parseBillingFinanceOpsControl = (stored: string | null | undefined): BillingFinanceOpsControlState => {
  if (typeof stored !== "string") return { state: "unreadable" };
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return { state: "unreadable" };
  }
  const parsed = controlSchema.safeParse(value);
  if (!parsed.success) return { state: "unreadable" };
  return parsed.data.enabled
    ? { state: "enabled", control: parsed.data }
    : { state: "disabled", control: parsed.data };
};

type Db = {
  appSetting: { findUnique(args: { where: { key: string }; select: { value: true } }): Promise<{ value: string } | null> };
};

/** Reads the switch. Any failure to read is `unreadable`, not a throw. */
export async function readBillingFinanceOpsControl(db: Db): Promise<BillingFinanceOpsControlState> {
  try {
    const row = await db.appSetting.findUnique({
      where: { key: BILLING_FINANCE_OPS_CONTROL_KEY },
      select: { value: true },
    });
    return parseBillingFinanceOpsControl(row?.value ?? null);
  } catch {
    return { state: "unreadable" };
  }
}

/** The key of the operator's monitor confirmation (docs/policy/billing-finance-ops.md §1.2–1.3). */
export const BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_KEY = "billingFinanceOps.monitorConfirmedAt";

/** How recent the monitor confirmation must be for the switch to be turned on (§1.2). */
export const BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const monitorConfirmationSchema = z.object({ confirmedAt: z.string().datetime({ offset: true }) }).strict();

/** The confirmation instant in epoch ms, or null when absent or malformed. */
export const parseBillingFinanceOpsMonitorConfirmation = (stored: string | null | undefined): number | null => {
  if (typeof stored !== "string") return null;
  try {
    const parsed = monitorConfirmationSchema.safeParse(JSON.parse(stored));
    if (!parsed.success) return null;
    const ms = Date.parse(parsed.data.confirmedAt);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
};

export type BillingFinanceOpsSwitchDecision =
  | { ok: true; next: BillingFinanceOpsControl }
  | { ok: false; code: "no_change" | "monitor_confirmation_required" | "control_unreadable" };

/**
 * Whether a change of the switch may be written, and what is written (§1.2).
 * Pure; `nowMs` is the database clock.
 *
 * Turning off asks for nothing -- a stop that can be refused is not a stop --
 * and also replaces an unreadable row with a clean one. Turning on needs a
 * readable row and a monitor confirmation no older than seven days, so the
 * dead-man monitor is known to be watching before runs begin.
 */
export const decideBillingFinanceOpsSwitchChange = ({
  current,
  enabled,
  monitorConfirmedAtMs,
  nowMs,
}: {
  current: BillingFinanceOpsControlState;
  enabled: boolean;
  monitorConfirmedAtMs: number | null;
  nowMs: number;
}): BillingFinanceOpsSwitchDecision => {
  const revision = (current.state === "unreadable" ? 0 : current.control.revision) + 1;
  if (!enabled) {
    if (current.state === "disabled") return { ok: false, code: "no_change" };
    return { ok: true, next: { enabled: false, revision, enabledAt: null } };
  }
  if (current.state === "unreadable") return { ok: false, code: "control_unreadable" };
  if (current.state === "enabled") return { ok: false, code: "no_change" };
  if (
    monitorConfirmedAtMs === null ||
    monitorConfirmedAtMs > nowMs ||
    nowMs - monitorConfirmedAtMs > BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_MAX_AGE_MS
  ) {
    return { ok: false, code: "monitor_confirmation_required" };
  }
  return { ok: true, next: { enabled: true, revision, enabledAt: new Date(nowMs).toISOString() } };
};
