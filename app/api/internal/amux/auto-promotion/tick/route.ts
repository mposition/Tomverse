export const dynamic = "force-dynamic";

import { z } from "zod";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import {
  AUTO_PROMOTION_APPLY_ENV,
  AUTO_PROMOTION_CODE_LATCH,
  autoPromotionApplyPermitted,
  autoTickHttpStatus,
} from "@/lib/amux/autoPromotionCore";
import { tickAutoPromotion } from "@/lib/amux/autoPromotionService";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";

/**
 * The system actor `amux-auto-promoter` consumes at most one bound grant.
 *
 * docs/policy/development-agent-orchestration.md, version 15 ("자동 승격
 * 개정"). The caller is the Railway AMUX Orchestrator, every five minutes.
 * Order: bearer credential, then an empty body, then the code latch and the
 * environment switch, and only then a transaction. The tick expires due
 * grants, then consumes the oldest bound grant through the same checks as the
 * owner route. A lost outcome is recorded and never retried.
 */

const noStore = { "Cache-Control": "no-store" };
const requestSchema = z.object({}).strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
  }

  try {
    await readLimitedJson(request, 1_024, requestSchema);
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    return Response.json({ error: "Invalid request." }, { status: 400, headers: noStore });
  }

  if (
    !autoPromotionApplyPermitted({
      envValue: process.env[AUTO_PROMOTION_APPLY_ENV],
      codeLatch: AUTO_PROMOTION_CODE_LATCH,
    })
  ) {
    return Response.json(
      { promoted: false, reason: "apply_disabled", expired: 0 },
      { status: 409, headers: noStore },
    );
  }

  try {
    const result = await tickAutoPromotion();
    return Response.json(result, { status: autoTickHttpStatus(result.reason), headers: noStore });
  } catch {
    // Opaque by design: the body carries a code, never an error message.
    console.error(JSON.stringify({ event: "amux_auto_promotion_tick_failed" }));
    return Response.json(
      { promoted: false, reason: "auto_promotion_failed", expired: 0 },
      { status: autoTickHttpStatus("auto_promotion_failed"), headers: noStore },
    );
  }
}
