export const dynamic = "force-dynamic";

import { processAuditAuthorized, processAuditFailure, processAuditJson, processAuditSecret } from "@/lib/amuxProcessAuditRoute";
import { claimProcessAuditRun } from "@/lib/amuxProcessAuditStore";

/**
 * The AMUX process analysis box runner's poll (lib/amuxProcessAuditCore.ts).
 *
 * POST, not GET: a due answer claims the run. Not due answers `{ due: false,
 * reason }` and writes nothing. Due answers the claim token, the window, the
 * app's figures for it and the previous report's conclusions; the runner then
 * reads develop and asks the Codex CLI. No model is called here.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = processAuditSecret();
  if (secret === null) return processAuditJson({ error: "not_found" }, 404);
  if (!processAuditAuthorized(request, secret)) return processAuditJson({ error: "unauthorized" }, 401);
  try {
    return processAuditJson(await claimProcessAuditRun());
  } catch (error) {
    return processAuditFailure("context", error);
  }
}
