export const dynamic = "force-dynamic";

import { ApiSecurityError, readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { purgeDueAmuxAnalysisContent } from
  "@/lib/amux/ideaAnalysisContentPurgeService";
import { AMUX_V4_CONTENT_RETENTION_ENV,
  AMUX_V4_CONTENT_RETENTION_SECRET_ENV,
  AMUX_V19_READ_MANIFEST_RETENTION_ENV,
  AMUX_V22_TASK_RESULT_RETENTION_ENV,
  amuxV19ReadManifestRetentionEnabled,
  amuxV4ContentRetentionEnabled, amuxV4ContentRetentionRequestSchema,
  amuxV22TaskResultRetentionEnabled,
  isAmuxV4ContentRetentionAuthorized } from
  "@/lib/amux/ideaContentRetentionCore";
import { cancelOverdueAmuxIdeaAnalyses, purgeDueAmuxRawIdeas } from
  "@/lib/amux/ideaRawRetentionService";
import { notifyDueAmuxRetentionHolds } from
  "@/lib/amux/ideaRetentionHoldNoticeService";
import { purgeDueAmuxReadManifests } from
  "@/lib/amux/ideaTrackedCheckoutReadManifestRetention";
import { purgeDueAmuxV22TaskResults } from
  "@/lib/amux/v22TaskResultRetention";
import { sweepAmuxV22TransferStaging } from "@/lib/amux/v22TransferStore";
import { purgeDueAmuxOrphanReadManifestKeys } from
  "@/lib/amux/ideaTrackedCheckoutReadManifestOrphanRetention";
import { purgeDueAmuxSessionAnalysisResults } from
  "@/lib/amux/ideaSessionAnalysisResultRetention";
import { purgeDueAmuxOrphanSessionResultKeys } from
  "@/lib/amux/ideaSessionAnalysisResultOrphanRetention";

/** The isolated retention trigger has no product DB credential. */
export async function POST(request: Request): Promise<Response> {
  if (!isAmuxV4ContentRetentionAuthorized(request,
    process.env[AMUX_V4_CONTENT_RETENTION_SECRET_ENV], [
      process.env.TOMVERSE_AMUX_V4_COLLECTION_AGENT_SECRET,
      process.env.TOMVERSE_AMUX_SYNC_SECRET,
      process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET,
    ])) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  const v4Enabled = amuxV4ContentRetentionEnabled(
    process.env[AMUX_V4_CONTENT_RETENTION_ENV]);
  const v19Enabled = amuxV19ReadManifestRetentionEnabled(
    process.env[AMUX_V19_READ_MANIFEST_RETENTION_ENV]);
  const v19ResultEnabled = v19Enabled &&
    process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_RETENTION === "enabled";
  if (!v4Enabled && !v19Enabled) {
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
    const holdNotices = v4Enabled ? await notifyDueAmuxRetentionHolds()
      : { available: false, reason: "v4_content_retention_disabled" };
    const cancellation = v4Enabled ? await cancelOverdueAmuxIdeaAnalyses()
      : { available: false, reason: "v4_content_retention_disabled" };
    const raw = v4Enabled ? await purgeDueAmuxRawIdeas()
      : { available: false, reason: "v4_content_retention_disabled" };
    const analysis = v4Enabled ? await purgeDueAmuxAnalysisContent()
      : { available: false, reason: "v4_content_retention_disabled" };
    const v22Enabled = v4Enabled && amuxV22TaskResultRetentionEnabled(
      process.env[AMUX_V22_TASK_RESULT_RETENTION_ENV]);
    // Transfer staging no commit will take (docs/policy/amux-v22-result-transfer.md
    // 2.6) runs with the content retention itself, not behind the v22 result
    // purge's latch: it removes sealed copies whose original stays on the box
    // until the app confirms it, never a recorded result. The keys it queues
    // are deleted by the result purge's key pass once that runs.
    const transferStaging = v4Enabled ? await sweepAmuxV22TransferStaging()
      : { available: false, reason: "v4_content_retention_disabled" };
    const taskResults = v22Enabled
      ? await purgeDueAmuxV22TaskResults()
      : { available: false, reason: "v22_task_result_retention_disabled" };
    const readManifests = v19Enabled
      ? { manifests: await purgeDueAmuxReadManifests(),
        orphanKeys: await purgeDueAmuxOrphanReadManifestKeys() }
      : { available: false, reason: "v19_read_manifest_retention_disabled" };
    const sessionResults = v19ResultEnabled
      ? { results: await purgeDueAmuxSessionAnalysisResults(),
        orphanKeys: await purgeDueAmuxOrphanSessionResultKeys() }
      : { available: false, reason: "v19_session_result_retention_disabled" };
    return amuxJsonNoStore({ holdNotices, cancellation, raw, analysis,
      transferStaging, taskResults, readManifests, sessionResults });
  } catch {
    // The worker stops on unknown DB or S3 outcome. The response carries no
    // content, secret, object key, or suggestion to blind-retry this tick.
    return amuxJsonNoStore({ error: "content_retention_outcome_unknown",
      retry: false }, 503);
  }
}
