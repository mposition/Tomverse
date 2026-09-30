export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";
import {
  currentEngineeringAgentHalt,
  readEngineeringAgentHaltState,
  recordEngineeringAgentServiceFinish,
  runEngineeringAgentTransaction,
} from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

// A service reports that its cycle ran to the end (docs/policy/engineering-
// agent.md §12). Which service is decided by the secret that authenticated,
// never by the body; the report is an indicator for the armed gate, not
// evidence, and is recorded whatever the switches say.

const requestSchema = z.object({}).strict();

export async function POST(request: Request) {
  const service = isEngineeringAgentRouteAuthorized(request, "runner")
    ? "runner"
    : isEngineeringAgentRouteAuthorized(request, "publisher")
      ? "publisher"
      : null;
  if (service === null) return engineeringAgentUnauthorized();
  try {
    await readLimitedJson(request, 64, requestSchema);
    const recorded = await runEngineeringAgentTransaction(prisma, (tx) =>
      recordEngineeringAgentServiceFinish(tx, { service }),
    );
    // The halt as it stands now, read after the cycle: the service sends its
    // success signal only if this, too, is none (docs/policy/engineering-agent.md §12).
    const halt = currentEngineeringAgentHalt(await readEngineeringAgentHaltState(prisma));
    return engineeringAgentJson({ service, finishedAt: recorded.finishedAt.toISOString(), halt }, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("service_finished", error);
  }
}
