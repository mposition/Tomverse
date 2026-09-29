export const dynamic = "force-dynamic";

import { z } from "zod";

import { runEngineeringAgentAdminMutation } from "@/lib/engineeringAgentAdminMutations";
import { acknowledgeEngineeringAgentHalt } from "@/lib/engineeringAgentStore";

// A person clears a recorded halt and a latched circuit (docs/policy/
// engineering-agent.md §12: "해제는 Admin 화면의 확인 행위뿐이다"). Write access,
// a recent sign-in and the audit entry in the same transaction.

const schema = z.object({}).strict();

export async function POST(request: Request) {
  return runEngineeringAgentAdminMutation({
    request,
    bucket: "engineering-agent-halt",
    schema,
    run: (tx, { session }) => acknowledgeEngineeringAgentHalt(tx, { session, request }),
  });
}
