export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_COLLECTION_AGENT_SECRET_ENV,
  AMUX_V4_COLLECTION_QUEUE_READ_ENV, collectionQueueReadEnabled,
  isCollectionAgentAuthorized, parseCollectionQueueCursor } from
  "@/lib/amux/ideaCollectionQueueCore";
import { listAmuxV4CollectionCandidates } from "@/lib/amux/ideaCollectionQueueService";

const queueRequest = z.object({ after: z.string().max(512).optional() }).strict();

/** Candidate IDs only. This does not claim a request or read GitHub. */
export async function POST(request: Request): Promise<Response> {
  if (!isCollectionAgentAuthorized(request,
    process.env[AMUX_V4_COLLECTION_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET,
    process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (!collectionQueueReadEnabled(process.env[AMUX_V4_COLLECTION_QUEUE_READ_ENV])) {
    return amuxJsonNoStore({ available: false, reason: "collection_queue_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  let cursor = null;
  try {
    const body = await readLimitedJson(request, 1_024, queueRequest);
    cursor = body.after === undefined ? null : parseCollectionQueueCursor(body.after);
    if (body.after !== undefined && cursor === null) {
      return amuxJsonNoStore({ error: "Invalid cursor." }, 400);
    }
  } catch {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  try {
    return amuxJsonNoStore(await listAmuxV4CollectionCandidates(cursor));
  } catch {
    return amuxJsonNoStore({ error: "Collection queue unavailable." }, 503);
  }
}
