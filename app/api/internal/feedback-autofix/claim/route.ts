export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import {
  claimCaseForFix,
  isAutoFixSyncAuthorized,
} from "@/lib/feedbackAutoFixSync";

const requestSchema = z
  .object({ caseId: z.string().min(10).max(64) })
  .strict();

/** POST: compare-and-swap claim of one candidate case. Exactly one caller
 * can win; a replay or a lost race answers claimed:false. */
export async function POST(request: Request) {
  if (!isAutoFixSyncAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  try {
    const body = await readLimitedJson(request, 1_024, requestSchema);
    const claim = await claimCaseForFix(body.caseId);
    return Response.json(
      claim ? { claimed: true, branch: claim.branch } : { claimed: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return Response.json(
      { error: "Invalid request." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}
