export const dynamic = "force-dynamic";

import { opsObserverJson, runOpsObserverRoute } from "@/lib/opsObserverRoute";
import { submitOpsObserverDigest, type OpsObserverDigestPayload } from "@/lib/opsObserverDigest";
import { parseDigestRequest } from "@/scripts/ops-observer/digest-schema-core.mjs";

// The sre-ops daily digest submission (docs/policy/sre-ops.md §1 item 3): the
// digest service only. The body is parsed to its closed shape before the
// store is asked, and the store keeps it only on a trusted chain whose own
// reading agrees with it.
export async function POST(request: Request) {
  return runOpsObserverRoute("digest", request, async (body, _service, nowMs) => {
    const parsed = parseDigestRequest(body, nowMs) as
      | { ok: true; value: { runDeadline: Date; ownerDate: string; payload: OpsObserverDigestPayload } }
      | { ok: false; error: string };
    if (!parsed.ok) return opsObserverJson({ refused: parsed.error }, 400);
    return opsObserverJson(await submitOpsObserverDigest(parsed.value));
  });
}
