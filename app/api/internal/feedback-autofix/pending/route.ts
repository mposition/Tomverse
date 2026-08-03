export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import {
  isAutoFixSyncAuthorized,
  listClaimableCases,
} from "@/lib/feedbackAutoFixSync";

const requestSchema = z
  .object({ limit: z.number().int().min(1).max(10).default(3) })
  .strict();

/** POST: candidates the Phase 3 fix workflow may claim. POST on purpose --
 * no state changes on GET anywhere in this protocol, and the body is parsed
 * with a bounded reader and a closed schema like every internal endpoint. */
export async function POST(request: Request) {
  if (!isAutoFixSyncAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  try {
    const body = await readLimitedJson(request, 1_024, requestSchema);
    const outcome = await listClaimableCases(body.limit);
    return Response.json(outcome, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Invalid request." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}
