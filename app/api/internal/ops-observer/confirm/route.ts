export const dynamic = "force-dynamic";

import { opsObserverJson, runOpsObserverRoute } from "@/lib/opsObserverRoute";
import { confirmOpsObserverDelivery } from "@/lib/opsObserverStore";
import { parseOpsObserverRequest } from "@/scripts/ops-observer/request-schema-core.mjs";

// The ops-observer confirm (docs/policy/sre-ops.md §3 rules 3 and 9): the page
// service only. The request names the reservation and its run; the store, not
// the request, decides whether it closes as confirmed or shadowed.
export async function POST(request: Request) {
  return runOpsObserverRoute("confirm", request, async (body, _service, nowMs) => {
    const parsed = parseOpsObserverRequest("confirm", body, nowMs) as
      | { ok: true; value: { runDeadline: Date; deliveryId: string; runId: string } }
      | { ok: false; error: string };
    if (!parsed.ok) return opsObserverJson({ refused: parsed.error }, 400);
    return opsObserverJson(await confirmOpsObserverDelivery(parsed.value));
  });
}
