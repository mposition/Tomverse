export const dynamic = "force-dynamic";

import { z } from "zod";

import { runBillingFinanceOpsAdminMutation } from "@/lib/billingFinanceOpsControlAdmin";
import { recordBillingFinanceOpsMonitorConfirmation } from "@/lib/billingFinanceOpsControlStore";

// The operator records that both environments' dead-man monitors are active
// and alerting, having checked the monitors' own screen
// (docs/policy/billing-finance-ops.md §1.3). The app cannot see the monitors;
// this is a person's statement under their name, and turning the switch on
// requires one from the last seven days.

const schema = z.object({}).strict();

export async function POST(request: Request) {
  return runBillingFinanceOpsAdminMutation({
    request,
    bucket: "billing-finance-ops-monitors",
    schema,
    run: ({ session }) => recordBillingFinanceOpsMonitorConfirmation({ session, request }),
  });
}
