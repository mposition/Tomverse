export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { inspectAmuxIdeaLaneFence } from "@/lib/amux/ideaLaneCore";
import { fenceAmuxIdeaLanePublish, isAmuxIdeaLaneAuthorized } from "@/lib/amux/ideaLaneService";

const NO_STORE = { "Cache-Control": "no-store" };

/** POST: may this run push and open its PR now? proceed:false means stop. */
export async function POST(request: Request) {
  if (!isAmuxIdeaLaneAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  let attemptId;
  try {
    attemptId = inspectAmuxIdeaLaneFence(await readLimitedJson(request, 512, z.unknown()));
  } catch {
    attemptId = null;
  }
  if (!attemptId) return Response.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  try {
    return Response.json({ proceed: await fenceAmuxIdeaLanePublish(attemptId) }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "Unavailable" }, { status: 503, headers: NO_STORE });
  }
}
