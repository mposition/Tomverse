export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { readEngineeringAgentLastLook } from "@/lib/engineeringAgentLastLook";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";
import { prisma } from "@/lib/prisma";

// The last look before the push (docs/policy/engineering-agent.md §11). It
// reads and writes nothing: it can refuse, and it cannot allow. The publisher
// presents its claim's fencing token and the digest of the commit object it
// built; any refusal means no push.

const requestSchema = z
  .object({
    workItemId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    fencingToken: z.string().regex(/^[1-9][0-9]{0,17}$/),
    commitDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "publisher")) return engineeringAgentUnauthorized();
  try {
    const body = await readLimitedJson(request, 1024, requestSchema);
    const verdict = await readEngineeringAgentLastLook(prisma, {
      workItemId: body.workItemId,
      fencingToken: BigInt(body.fencingToken),
      commitDigest: body.commitDigest,
    });
    return engineeringAgentJson(verdict, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("publish_last_look", error);
  }
}
