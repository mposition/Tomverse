export const dynamic = "force-dynamic";

import { ApiSecurityError, readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { purgeDueAmuxAnalysisContent } from
  "@/lib/amux/ideaAnalysisContentPurgeService";
import { AMUX_V4_CONTENT_RETENTION_ENV,
  AMUX_V4_CONTENT_RETENTION_SECRET_ENV,
  AMUX_V22_TASK_RESULT_RETENTION_ENV,
  amuxV4ContentRetentionEnabled, amuxV4ContentRetentionRequestSchema,
  amuxV22TaskResultRetentionEnabled,
  isAmuxV4ContentRetentionAuthorized } from
  "@/lib/amux/ideaContentRetentionCore";
import { cancelOverdueAmuxIdeaAnalyses, purgeDueAmuxRawIdeas } from
  "@/lib/amux/ideaRawRetentionService";
import { notifyDueAmuxRetentionHolds } from
  "@/lib/amux/ideaRetentionHoldNoticeService";
import { purgeDueAmuxV22TaskResults } from
  "@/lib/amux/v22TaskResultRetention";

/** The isolated retention trigger has no product DB credential. */
export async function POST(request: Request): Promise<Response> {
  if (!isAmuxV4ContentRetentionAuthorized(request,
    process.env[AMUX_V4_CONTENT_RETENTION_SECRET_ENV], [
      process.env.TOMVERSE_AMUX_V4_COLLECTION_AGENT_SECRET,
      process.env.TOMVERSE_AMUX_SYNC_SECRET,
      process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET,
    ])) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (!amuxV4ContentRetentionEnabled(process.env[AMUX_V4_CONTENT_RETENTION_ENV])) {
    return amuxJsonNoStore({ available: false,
      reason: "content_retention_disabled" }, 409);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim()
    .toLowerCase() !== "application/json") {
    return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  }
  try {
    await readLimitedJson(request, 128, amuxV4ContentRetentionRequestSchema);
  } catch (error) {
    return amuxJsonNoStore({ error: "Invalid request." },
      error instanceof ApiSecurityError && error.status === 413 ? 413 : 400);
  }
  try {
    const holdNotices = await notifyDueAmuxRetentionHolds();
    const cancellation = await cancelOverdueAmuxIdeaAnalyses();
    const raw = await purgeDueAmuxRawIdeas();
    const analysis = await purgeDueAmuxAnalysisContent();
    const taskResults = amuxV22TaskResultRetentionEnabled(
      process.env[AMUX_V22_TASK_RESULT_RETENTION_ENV])
      ? await purgeDueAmuxV22TaskResults()
      : { available: false, reason: "v22_task_result_retention_disabled" };
    return amuxJsonNoStore({ holdNotices, cancellation, raw, analysis,
      taskResults });
  } catch {
    // The worker stops on unknown DB or S3 outcome. The response carries no
    // content, secret, object key, or suggestion to blind-retry this tick.
    return amuxJsonNoStore({ error: "content_retention_outcome_unknown",
      retry: false }, 503);
  }
}
