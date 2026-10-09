export const dynamic = "force-dynamic";

import { opsObserverJson, runOpsObserverRoute } from "@/lib/opsObserverRoute";
import { advanceOpsObserverState } from "@/lib/opsObserverStore";
import { parseAdvanceRequest } from "@/scripts/ops-observer/advance-request-core.mjs";

// The ops-observer advance (docs/policy/sre-ops.md §3 rules 3 and 9): the page
// service only. sendPermitted is true only in the answer to the request whose
// transaction inserted the reservation; a caller that never reads this answer
// never sends, and the next advance closes the reservation as abandoned.
export async function POST(request: Request) {
  return runOpsObserverRoute("advance", request, async (body, _service, nowMs) => {
    const parsed = parseAdvanceRequest(body, nowMs) as
      | { ok: true; value: Parameters<typeof advanceOpsObserverState>[0] }
      | { ok: false; error: string };
    if (!parsed.ok) return opsObserverJson({ refused: parsed.error }, 400);
    return opsObserverJson(await advanceOpsObserverState(parsed.value));
  });
}
