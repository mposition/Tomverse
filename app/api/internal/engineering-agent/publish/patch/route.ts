export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
} from "@/lib/engineeringAgentRouteAuth";
import { readEngineeringAgentPublishPatchChunk } from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

// One chunk of the patch a write claim applies
// (docs/policy/amux-v22-result-transfer.md §4). A publisher that names
// `patch_chunks` is claimed without the patch and reads it here, in order,
// then checks its length and digest whole before anything else. Only the
// holder of the live write claim -- this fencing token, its lease not passed
// -- reads it. It is a read: no request ledger, nothing written, and the last
// look still decides the push.

const requestSchema = z
  .object({
    workItemId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    fencingToken: z.string().regex(/^[1-9][0-9]{0,17}$/),
    index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "publisher")) return engineeringAgentUnauthorized();
  try {
    const body = await readLimitedJson(request, 1024, requestSchema);
    const chunk = await readEngineeringAgentPublishPatchChunk(prisma, {
      workItemId: body.workItemId,
      fencingToken: BigInt(body.fencingToken),
      index: body.index,
    });
    if (chunk.kind === "claim_not_live") return engineeringAgentJson({ refused: "claim_not_live" }, 409);
    if (chunk.kind === "out_of_range") return engineeringAgentJson({ error: "invalid_request" }, 400);
    return engineeringAgentJson({
      workItemId: chunk.workItemId,
      index: chunk.index,
      totalBytes: chunk.totalBytes,
      chunkCount: chunk.chunkCount,
      bytesBase64: chunk.bytesBase64,
    }, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("publish_patch", error);
  }
}
