export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { isAutoFixSyncAuthorized } from "@/lib/feedbackAutoFixSync";
import { preparePromotion } from "@/lib/feedbackAutoFixPromotion";

const requestSchema = z
  .object({
    caseId: z.string().min(10).max(64),
    prNumber: z.number().int().min(1),
  })
  .strict();

/**
 * POST: what the promotion-PR workflow needs for a develop PR it saw merged
 * -- whether the case was approved at the head that was merged, the merge
 * commit, and the approved change manifest the workflow checks main against.
 *
 * Read-only by design (independent review round 1, N4/N5): it changes no
 * case, so a replayed, duplicated or stale call can do nothing. The server's
 * observer records the merge and finds the promotion PR from its own reads.
 */
export async function POST(request: Request) {
  if (!isAutoFixSyncAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  try {
    const body = await readLimitedJson(request, 4 * 1_024, requestSchema);
    const preparation = await preparePromotion(body);
    console.info(
      JSON.stringify({
        event: "autofix_promotion_prepared",
        caseId: body.caseId,
        eligible: preparation.eligible,
        reason: preparation.eligible ? null : preparation.reason,
        at: new Date().toISOString(),
      })
    );
    return Response.json(preparation, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { error: "Invalid request." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}
