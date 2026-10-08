export const dynamic = "force-dynamic";

import { z } from "zod";

import { runBillingFinanceOpsAdminMutation } from "@/lib/billingFinanceOpsControlAdmin";
import { setBillingFinanceOpsSwitch } from "@/lib/billingFinanceOpsControlStore";

// Turns the billing-finance-ops agent on or off
// (docs/policy/billing-finance-ops.md §1.2). Turning off needs nothing;
// turning on needs a monitor confirmation from the last seven days. Owner or
// ops and a recent sign-in; the step-up refusal is answered by the wrapper.

const schema = z.object({ enabled: z.boolean() }).strict();

export async function POST(request: Request) {
  return runBillingFinanceOpsAdminMutation({
    request,
    bucket: "billing-finance-ops-control",
    schema,
    run: async ({ body, session }) => {
      const next = await setBillingFinanceOpsSwitch({ session, request, enabled: body.enabled });
      return { enabled: next.enabled, revision: next.revision };
    },
  });
}
