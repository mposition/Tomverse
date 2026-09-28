export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxAgentIntakeOpen } from "@/lib/amux/agentIntake";
import { readEngineeringAgentRegistrationCandidates } from "@/lib/engineeringAgentRegistration";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";
import { readEngineeringAgentSwitches } from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

// The items a registration round may analyse (docs/policy/engineering-agent.md
// §2.2 step 1): the app pins the source and reads it itself, and returns only
// what the deterministic pre-filter leaves. Read-only; nothing is recorded.

const requestSchema = z
  .object({
    source: z.enum(["S1", "S2", "S3"]),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  if (!isAmuxAgentIntakeOpen()) return engineeringAgentJson({ refused: "agent_intake_closed" }, 409);
  try {
    const body = await readLimitedJson(request, 256, requestSchema);
    if (!(await readEngineeringAgentSwitches(prisma)).registrationAllowed) {
      return engineeringAgentJson({ refused: "registration_switched_off" }, 409);
    }
    const { eligible, excluded } = await readEngineeringAgentRegistrationCandidates({ source: body.source });
    return engineeringAgentJson(
      {
        source: body.source,
        eligible: eligible.map((item) => ({
          key: item.key,
          digest: item.digest,
          priority: item.priority,
          pinnedCommit: item.pinnedCommit,
          text: item.text,
        })),
        excluded,
      },
      200,
    );
  } catch (error) {
    return engineeringAgentErrorResponse("register_candidates", error);
  }
}
