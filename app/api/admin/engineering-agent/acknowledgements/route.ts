export const dynamic = "force-dynamic";

import { z } from "zod";

import { runEngineeringAgentAdminMutation } from "@/lib/engineeringAgentAdminMutations";
import {
  acknowledgeEngineeringAgentDecision,
  approveEngineeringAgentPullRequestResume,
} from "@/lib/engineeringAgentStore";

// A person has seen a decision item -- an unknown write outcome, a partial
// registration, a repeated failure (docs/policy/engineering-agent.md §10, §12).
// The earlier decisions of the same unknown outcome close with it.
//
// `resumePullRequest`: for an unknown outcome that left a branch and no pull
// request, the person also approves that the publisher open that pull request,
// once, for the commit the consumed capability allows (§10).

const schema = z
  .object({
    workItemId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    resumePullRequest: z.literal(true).optional(),
  })
  .strict();

export async function POST(request: Request) {
  return runEngineeringAgentAdminMutation({
    request,
    bucket: "engineering-agent-acknowledge",
    schema,
    run: (tx, { body, session }) =>
      body.resumePullRequest === true
        ? approveEngineeringAgentPullRequestResume(tx, { session, request, workItemId: body.workItemId })
        : acknowledgeEngineeringAgentDecision(tx, { session, request, workItemId: body.workItemId }),
  });
}
