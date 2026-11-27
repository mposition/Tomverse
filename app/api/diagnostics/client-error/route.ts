export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import {
  allowClientErrorFromAddress,
  allowClientErrorReport,
  clientErrorReportingEnabled,
  clientErrorReportSchema,
  recordClientErrorReport,
} from "@/lib/clientErrorReport";
import { CLIENT_ERROR_REPORTING_OFF_HEADER } from "@/lib/clientErrorReportCore";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

/**
 * Browser error reports (lib/clientErrorReport.ts).
 *
 * Open to guests and to the sign-in screen on purpose: an error before login is
 * still an error. No session is read and none is needed, so the answer cannot
 * depend on the database. Abuse is bounded by a body cap, per-address and
 * per-page-load limits kept in memory (like /api/security/csp-report), per-error
 * and overall caps in front of Sentry, and the field limits in the schema.
 *
 * Every accepted, limited or switched-off request answers 204: the page has
 * nothing to do with the answer except stop, and a status that looks like a
 * failure would be one more error in the console of the page being reported.
 */
const MAX_REPORT_BYTES = 16 * 1024;

const noContent = (headers?: Record<string, string>) =>
  new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store", ...headers },
  });

export async function POST(request: Request) {
  if (!clientErrorReportingEnabled()) {
    return noContent({ [CLIENT_ERROR_REPORTING_OFF_HEADER]: "off" });
  }
  // Browser-only, like /api/chat/timing: a report has to come from a page of
  // this site. The proxy applies the same check to every non-exempt mutation.
  if (!request.headers.get("origin") || !hasValidMutationOrigin(request)) {
    return new Response(null, { status: 403 });
  }
  if (!allowClientErrorFromAddress(getAnonymousClientKey(request))) {
    return noContent();
  }
  try {
    const report = await readLimitedJson(
      request,
      MAX_REPORT_BYTES,
      clientErrorReportSchema
    );
    if (allowClientErrorReport(report)) {
      recordClientErrorReport(report, {
        userAgent: request.headers.get("user-agent"),
      });
    }
    return noContent();
  } catch (error) {
    return apiSecurityResponse(error) ?? new Response(null, { status: 400 });
  }
}
