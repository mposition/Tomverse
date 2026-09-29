export const dynamic = "force-dynamic";

import { z } from "zod";

import { runEngineeringAgentAdminMutation } from "@/lib/engineeringAgentAdminMutations";
import {
  ENGINEERING_AGENT_MISMATCH_CONSOLE_ACTIONS,
  lockEngineeringAgentMismatchAmuxRows,
  resolveEngineeringAgentStateMismatch,
} from "@/lib/engineeringAgentStore";

// A person's action on a state mismatch (docs/policy/engineering-agent.md
// §11): both sides locked -- AMUX's rows first, in AMUX's order, then the
// engineering rows -- and read again before the action runs. Neither side is
// corrected to match the other.

const schema = z
  .object({
    workItemId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    action: z.enum(ENGINEERING_AGENT_MISMATCH_CONSOLE_ACTIONS),
  })
  .strict();

export async function POST(request: Request) {
  return runEngineeringAgentAdminMutation({
    request,
    bucket: "engineering-agent-mismatch",
    schema,
    beforeAuditLock: (tx, body) => lockEngineeringAgentMismatchAmuxRows(tx, body.workItemId),
    run: (tx, { body, session }) =>
      resolveEngineeringAgentStateMismatch(tx, { session, request, workItemId: body.workItemId, action: body.action }),
  });
}
