export const dynamic = "force-dynamic";

import { z } from "zod";

import { runEngineeringAgentAdminMutation } from "@/lib/engineeringAgentAdminMutations";
import { recordEngineeringAgentMonitorsConfirmed } from "@/lib/engineeringAgentStore";

// The operator records that both dead-man monitors are active and alerting,
// having checked the monitors' own screen (docs/policy/engineering-agent.md
// §12, the armed gate). The app cannot see the monitors; this is a person's
// statement under their name.

const schema = z.object({}).strict();

export async function POST(request: Request) {
  return runEngineeringAgentAdminMutation({
    request,
    bucket: "engineering-agent-monitors",
    schema,
    run: (tx, { session }) => recordEngineeringAgentMonitorsConfirmed(tx, { session, request }),
  });
}
