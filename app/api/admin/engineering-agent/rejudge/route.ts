export const dynamic = "force-dynamic";

import { z } from "zod";

import { runEngineeringAgentAdminMutation } from "@/lib/engineeringAgentAdminMutations";
import { rejudgeEngineeringAgentV22Draft } from "@/lib/engineeringAgentStore";

// A person asks for a v22 draft kept private to be judged again by the
// publisher's next tier round (docs/policy/engineering-agent.md §11). It binds
// to the digest and base the person saw; nothing is published here.

const schema = z
  .object({
    workItemId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    patchDigest: z.string().regex(/^[0-9a-f]{64}$/),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

export async function POST(request: Request) {
  return runEngineeringAgentAdminMutation({
    request,
    bucket: "engineering-agent-v22-rejudge",
    schema,
    run: (tx, { body, session }) => rejudgeEngineeringAgentV22Draft(tx, { session, request, ...body }),
  });
}
