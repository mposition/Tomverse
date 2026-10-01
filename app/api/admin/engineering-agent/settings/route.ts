export const dynamic = "force-dynamic";

import { z } from "zod";

import { runEngineeringAgentAdminMutation } from "@/lib/engineeringAgentAdminMutations";
import { ENGINEERING_AGENT_CONSOLE_MODES, setEngineeringAgentSwitch } from "@/lib/engineeringAgentStore";

// The mode and the freeze (docs/policy/engineering-agent.md §11). The console
// sets `off` or `shadow`; `t1` waits on the person-only approval evidence the
// policy requires first (§14), so it is not a value this route accepts.

const schema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("mode"), value: z.enum(ENGINEERING_AGENT_CONSOLE_MODES) }).strict(),
  z.object({ name: z.literal("freeze"), value: z.enum(["true", "false"]) }).strict(),
]);

export async function POST(request: Request) {
  return runEngineeringAgentAdminMutation({
    request,
    bucket: "engineering-agent-settings",
    schema,
    run: (tx, { body, session }) => setEngineeringAgentSwitch(tx, { session, request, name: body.name, value: body.value }),
  });
}
