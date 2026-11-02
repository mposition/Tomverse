export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { inspectAmuxIdeaLaneResult } from "@/lib/amux/ideaLaneCore";
import { isAmuxIdeaLaneAuthorized, recordAmuxIdeaLaneResult } from "@/lib/amux/ideaLaneService";

const NO_STORE = { "Cache-Control": "no-store" };

/** POST: one run's outcome (an opened PR or a fixed failure word). A replay
 * answers applied:false. */
export async function POST(request: Request) {
  if (!isAmuxIdeaLaneAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  let result;
  try {
    result = inspectAmuxIdeaLaneResult(await readLimitedJson(request, 1_024, z.unknown()));
  } catch {
    result = null;
  }
  if (!result) return Response.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  try {
    return Response.json({ applied: await recordAmuxIdeaLaneResult(result) }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "Unavailable" }, { status: 503, headers: NO_STORE });
  }
}
