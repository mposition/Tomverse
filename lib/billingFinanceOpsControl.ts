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
