export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";
import { prisma } from "@/lib/prisma";

// Where a caller that lost an answer asks, instead of retrying
// (docs/policy/engineering-agent.md §10): the recorded state of its request.
// `in_progress` can stay visible for as long as a late COMMIT may still land;
// this route never moves it.

const ROUTE_PREFIXES = {
  runner: ["run/", "register/"],
  publisher: ["publish/"],
} as const;

const requestSchema = z
  .object({
    requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  })
  .strict();

export async function POST(request: Request) {
  const role = isEngineeringAgentRouteAuthorized(request, "runner")
    ? "runner"
    : isEngineeringAgentRouteAuthorized(request, "publisher")
      ? "publisher"
      : null;
  if (role === null) return engineeringAgentUnauthorized();
  try {
    const body = await readLimitedJson(request, 1024, requestSchema);
    const row = await prisma.engineeringAgentRequest.findUnique({
      where: { key: body.requestKey },
      select: { route: true, state: true },
    });
    // Each service sees only its own routes' requests.
    const own = row !== null && ROUTE_PREFIXES[role].some((prefix) => row.route.startsWith(prefix));
    return engineeringAgentJson(own ? { route: row.route, state: row.state } : { state: null }, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("status", error);
  }
}
