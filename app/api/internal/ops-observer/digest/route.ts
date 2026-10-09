export const dynamic = "force-dynamic";

import { opsObserverJson, runOpsObserverRoute } from "@/lib/opsObserverRoute";
import { submitOpsObserverDigest } from "@/lib/opsObserverDigest";
import { parseDigestRequest } from "@/scripts/ops-observer/digest-schema-core.mjs";

// The sre-ops daily digest submission (docs/policy/sre-ops.md §1 item 3): the
// digest service only, naming a closed owner date. The app builds the digest
// from its own reads and keeps it only on a trusted chain; a late run is 409
// through the shared route wrapper.
export async function POST(request: Request) {
  return runOpsObserverRoute("digest", request, async (body, _service, nowMs) => {
    const parsed = parseDigestRequest(body, nowMs) as
      | { ok: true; value: { runDeadline: Date; ownerDate: string } }
      | { ok: false; error: string };
    if (!parsed.ok) return opsObserverJson({ refused: parsed.error }, 400);
    return opsObserverJson(await submitOpsObserverDigest(parsed.value));
  });
}
