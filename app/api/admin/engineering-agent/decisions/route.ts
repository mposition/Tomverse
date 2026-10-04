export const dynamic = "force-dynamic";

import { z } from "zod";

import { runEngineeringAgentAdminMutation } from "@/lib/engineeringAgentAdminMutations";
import { decideEngineeringAgentT2Draft } from "@/lib/engineeringAgentStore";

// A person's T2 decision (docs/policy/engineering-agent.md §7). It binds to
// the digest and base the person saw; if the draft changed since, the store
// refuses and nothing is decided.

const schema = z
  .object({
    workItemId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    decision: z.enum(["approved", "rejected"]),
    patchDigest: z.string().regex(/^[0-9a-f]{64}$/),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

export async function POST(request: Request) {
  return runEngineeringAgentAdminMutation({
    request,
    bucket: "engineering-agent-t2-decision",
    schema,
    run: (tx, { body, session }) => decideEngineeringAgentT2Draft(tx, { session, request, ...body }),
  });
}
