export const dynamic = "force-dynamic";

import { z } from "zod";

import { runEngineeringAgentAdminMutation } from "@/lib/engineeringAgentAdminMutations";
import { acknowledgeEngineeringAgentDecision } from "@/lib/engineeringAgentStore";

// A person has seen a decision item -- an unknown write outcome, a partial
// registration, a repeated failure (docs/policy/engineering-agent.md §10, §12).

const schema = z
  .object({
    workItemId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  })
  .strict();

export async function POST(request: Request) {
  return runEngineeringAgentAdminMutation({
    request,
    bucket: "engineering-agent-acknowledge",
    schema,
    run: (tx, { body, session }) => acknowledgeEngineeringAgentDecision(tx, { session, request, workItemId: body.workItemId }),
  });
}
