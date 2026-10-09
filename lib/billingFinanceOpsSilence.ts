import "server-only";

import {
  BILLING_FINANCE_OPS_AGENT_KEY,
  BILLING_FINANCE_OPS_ENVIRONMENTS,
  type BillingFinanceOpsEnvironment,
  billingFinanceOpsIdempotencyKey,
} from "@/lib/billingFinanceOpsDigest";
import { type BillingFinanceOpsControlState, readBillingFinanceOpsControl } from "@/lib/billingFinanceOpsControl";
import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";

/**
 * Signal 2 of docs/policy/billing-finance-ops.md §1.3: the maintenance pass
 * looks for today's digest. It is the second signal, not the first -- it runs
 * in the same app and database as the run route, so it cannot see the app or
 * the database stop (the external dead-man monitor does). What it sees that
 * the monitor cannot is a day with no row behind a signal: a forged signal, or
 * a trigger that signalled without the app having recorded anything.
 *
 * Alerts carry the environment and the date, never a verdict, a model id or a
 * deadline -- an alert is not the deadline notice (stage N).
 */

/** The trigger's daily slot, 01:00 UTC (§1.1 item 1), and how long a run of it may take to land. */
const SLOT_HOUR_UTC = 1;
const SLOT_GRACE_MS = 60 * 60 * 1000;

export type BillingFinanceOpsSilenceVerdict =
  | "not_applicable"
  | "control_unreadable"
  | "off"
  | "not_due"
  | "recorded"
  | "silent";

/**
 * Pure. `nowMs` is the database clock; `todayDate` its UTC date.
 *
 * Not due until the day's slot plus an hour has passed, and not due on the day
 * the switch was turned on after that day's slot -- the first run is the next
 * morning's.
 */
export const billingFinanceOpsSilenceVerdict = ({
  environment,
  control,
  nowMs,
  todayDate,
  digestRecordedToday,
}: {
  environment: string;
  control: BillingFinanceOpsControlState;
  nowMs: number;
  todayDate: string;
  digestRecordedToday: boolean;
}): BillingFinanceOpsSilenceVerdict => {
  if (!(BILLING_FINANCE_OPS_ENVIRONMENTS as readonly string[]).includes(environment)) return "not_applicable";
  if (control.state === "unreadable") return "control_unreadable";
  if (control.state === "disabled") return "off";
  const slotMs = Date.parse(`${todayDate}T${String(SLOT_HOUR_UTC).padStart(2, "0")}:00:00.000Z`);
  if (nowMs < slotMs + SLOT_GRACE_MS) return "not_due";
  const enabledAtMs = Date.parse(control.control.enabledAt ?? "");
  if (!Number.isFinite(enabledAtMs) || enabledAtMs >= slotMs) return "not_due";
  return digestRecordedToday ? "recorded" : "silent";
};

/** The maintenance step: reads, judges, and reports at most one incident. */
export async function checkBillingFinanceOpsSilence(
  env: Readonly<Record<string, string | undefined>> = process.env,
  db: typeof prisma = prisma,
): Promise<BillingFinanceOpsSilenceVerdict> {
  const environment = resolveDeploymentEnvironment(env as NodeJS.ProcessEnv);
  if (!(BILLING_FINANCE_OPS_ENVIRONMENTS as readonly string[]).includes(environment)) return "not_applicable";

  const control = await readBillingFinanceOpsControl(db);
  // The database clock as epoch milliseconds: a raw timestamptz comes back in
  // the session's wall-clock time, which would move "today" on a non-UTC server.
  const [{ nowMs }] = await db.$queryRaw<{ nowMs: number }[]>`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS "nowMs"`;
  const now = Number(nowMs);
  const todayDate = new Date(now).toISOString().slice(0, 10);
  const recorded =
    control.state === "enabled"
      ? (await db.agentDigestItem.count({
          where: {
            agentKey: BILLING_FINANCE_OPS_AGENT_KEY,
            idempotencyKey: billingFinanceOpsIdempotencyKey(environment as BillingFinanceOpsEnvironment, todayDate),
          },
        })) > 0
      : false;

  const verdict = billingFinanceOpsSilenceVerdict({
    environment,
    control,
    nowMs: now,
    todayDate,
    digestRecordedToday: recorded,
  });
  if (verdict === "silent") {
    await reportOperationalIncident({
      code: "BILLING_FINANCE_OPS_DEADLINE_SILENT",
      title: "No billing-finance-ops deadline digest was recorded today",
      severity: "warning",
      context: { component: "billing-finance-ops-agent", environment, date: todayDate },
    });
  } else if (verdict === "control_unreadable") {
    await reportOperationalIncident({
      code: "BILLING_FINANCE_OPS_CONTROL_UNREADABLE",
      title: "The billing-finance-ops switch row cannot be read",
      severity: "warning",
      context: { component: "billing-finance-ops-agent", environment, date: todayDate },
    });
  }
  return verdict;
}
