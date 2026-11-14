export const dynamic = "force-dynamic";

import { z } from "zod";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_PROCESS_AUDIT_MAX_REPORT_BYTES } from "@/lib/amuxProcessAuditCore";
import { processAuditAuthorized, processAuditFailure, processAuditJson, processAuditSecret } from "@/lib/amuxProcessAuditRoute";
import { ProcessAuditReportRefused, recordProcessAuditReport } from "@/lib/amuxProcessAuditStore";

const body = z.object({
  token: z.string().uuid(),
  developSha: z.string().regex(/^[0-9a-f]{40}$/),
  model: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/).nullable(),
  analysis: z.unknown(),
}).strict();

/**
 * One finished run of the box runner. Stored only against the claim in flight;
 * the figures are read again by the app, never taken from the box.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = processAuditSecret();
  if (secret === null) return processAuditJson({ error: "not_found" }, 404);
  if (!processAuditAuthorized(request, secret)) return processAuditJson({ error: "unauthorized" }, 401);
  try {
    const input = await readLimitedJson(request, AMUX_PROCESS_AUDIT_MAX_REPORT_BYTES, body);
    const stored = await recordProcessAuditReport(input);
    return processAuditJson({ state: "stored", ...stored }, 201);
  } catch (error) {
    if (error instanceof ProcessAuditReportRefused) {
      return processAuditJson({ error: error.code }, error.code === "no_claim" ? 409 : 422);
    }
    const security = apiSecurityResponse(error);
    if (security) return security;
    return processAuditFailure("report", error);
  }
}
