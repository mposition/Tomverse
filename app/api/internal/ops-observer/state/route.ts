export const dynamic = "force-dynamic";

import { opsObserverJson, runOpsObserverRoute } from "@/lib/opsObserverRoute";
import { readOpsObserverState } from "@/lib/opsObserverStore";
import { parseOpsObserverRequest } from "@/scripts/ops-observer/request-schema-core.mjs";

// The ops-observer state read (docs/policy/sre-ops.md §3 rule 7): both
// services may call it. Trusted answers carry the state and the named owner
// date's budget (§5); anything else carries only the reason, and the service
// sends nothing.
export async function POST(request: Request) {
  return runOpsObserverRoute("state", request, async (body, _service, nowMs) => {
    const parsed = parseOpsObserverRequest("state", body, nowMs) as
      | { ok: true; value: { runDeadline: Date; ownerDate: string } }
      | { ok: false; error: string };
    if (!parsed.ok) return opsObserverJson({ refused: parsed.error }, 400);
    return opsObserverJson(await readOpsObserverState(parsed.value.runDeadline, undefined, parsed.value.ownerDate));
  });
}
