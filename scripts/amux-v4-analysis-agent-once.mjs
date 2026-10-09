/** Local Ubuntu one-shot entry point. Both the exact CLI catalog and the
 * environment switch must admit a call before any queue access. */
import { AMUX_V4_LIVE_ANALYSIS_CLI_ENV,
  amuxV4LiveAnalysisCliEnabled } from
  "../lib/amux/ideaLocalIsolatedCliRunner.mjs";
import { runAmuxV4LocalAnalysisAgentOnce } from
  "../lib/amux/ideaLocalAnalysisAgentOnce.mjs";
import { amuxV4AnalysisDiagnosticLog } from
  "../lib/amux/ideaLocalAnalysisDiagnostics.mjs";
import { runAmuxV4LocalAnalysisTrigger } from
  "../lib/amux/ideaLocalAnalysisTrigger.mjs";
import { localAmuxHaltFile } from
  "../lib/amux/ideaLocalRetentionHaltFile.mjs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AMUX_V4_ANALYSIS_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalQueuePoll.mjs";

if (!amuxV4LiveAnalysisCliEnabled(
      process.env[AMUX_V4_LIVE_ANALYSIS_CLI_ENV]) ||
    process.platform !== "linux") {
  process.stderr.write("AMUX_V4_LOCAL_ANALYSIS_REFUSED\n");
  process.exitCode = 2;
} else {
  let result = { kind: "refused" };
  try {
    const state = localAmuxHaltFile(
      join(homedir(), ".local/state/tomverse-amux-v4-analysis"), "analysis");
    result = await runAmuxV4LocalAnalysisTrigger(() =>
      runAmuxV4LocalAnalysisAgentOnce({
        origin: process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV],
        agentSecret: process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET,
        fetchImpl: fetch,
      }), state);
  } catch { /* Never emit exception messages or CLI text. */ }
  // Only status and revalidated fixed diagnostic codes reach the journal.
  process.stdout.write(`AMUX_V4_LOCAL_ANALYSIS_${result.kind}\n`);
  process.stdout.write(amuxV4AnalysisDiagnosticLog(result));
  // Read-only queue failures release the marker but still exit nonzero so the
  // supervisor can distinguish an unavailable queue from a successful idle.
  if (!["idle", "draft_ready", "provider_failed", "disabled",
      "catalog_unapproved"].includes(result.kind)) {
    process.exitCode = 1;
  }
}
