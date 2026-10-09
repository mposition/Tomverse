/**
 * The billing and finance room's state, from what the server read.
 *
 * The verdict is the agent's own -- `billingFinanceOpsSilenceVerdict`, the
 * pure judgement its maintenance step uses -- given the same facts: the
 * deployment environment, the switch row as `readBillingFinanceOpsControl`
 * reads it (a row that is missing, malformed or unreadable is `unreadable`,
 * never `off`), and whether today's digest row exists. The clock differs:
 * the maintenance step reads the database's, the office passes the app's, so
 * within a clock skew of the day's slot the two can disagree for a moment.
 * The maintenance step's verdict is the one that raises an incident.
 */

import type { AgentOfficeFinanceState } from "@/lib/agentOffice/live";
import type { BillingFinanceOpsControlState } from "@/lib/billingFinanceOpsControl";
import { billingFinanceOpsSilenceVerdict } from "@/lib/billingFinanceOpsSilence";

export function agentOfficeFinanceState(input: {
  environment: string;
  control: BillingFinanceOpsControlState;
  recordedToday: boolean;
  latestDigestAt: Date | null;
  now: Date;
}): AgentOfficeFinanceState {
  const verdict = billingFinanceOpsSilenceVerdict({
    environment: input.environment,
    control: input.control,
    nowMs: input.now.getTime(),
    todayDate: input.now.toISOString().slice(0, 10),
    digestRecordedToday: input.recordedToday,
  });
  const control = input.control.state === "unreadable" ? null : input.control.control;
  return {
    kind: "observed",
    verdict,
    controlRevision: control?.revision ?? null,
    enabledAt: control?.enabledAt ? new Date(control.enabledAt).toISOString() : null,
    latestDigestAt: input.latestDigestAt?.toISOString() ?? null,
  };
}
