export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import {
  heartbeatCase,
  isAutoFixSyncAuthorized,
} from "@/lib/feedbackAutoFixSync";

const requestSchema = z
  .object({ caseId: z.string().min(10).max(64) })
  .strict();

/** POST: extends the fix lease while a workflow run is alive. A dead runner
 * simply stops calling this and the lease expiry returns the case to the
 * review pool. */
export async function POST(request: Request) {
  if (!isAutoFixSyncAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  try {
    const body = await readLimitedJson(request, 1_024, requestSchema);
    const alive = await heartbeatCase(body.caseId);
    return Response.json({ alive }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { error: "Invalid request." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}
