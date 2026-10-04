/** Local Ubuntu one-shot entry point. Both the exact CLI catalog and the
 * environment switch must admit a call before any queue access. */
import { AMUX_V4_LIVE_ANALYSIS_CLI_ENV,
  amuxV4LiveAnalysisCliEnabled } from
  "../lib/amux/ideaLocalIsolatedCliRunner.mjs";
import { runAmuxV4LocalAnalysisAgentOnce } from
  "../lib/amux/ideaLocalAnalysisAgentOnce.mjs";
import { AMUX_V4_ANALYSIS_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalQueuePoll.mjs";

if (!amuxV4LiveAnalysisCliEnabled(
      process.env[AMUX_V4_LIVE_ANALYSIS_CLI_ENV]) ||
    process.platform !== "linux") {
  process.stderr.write("AMUX_V4_LOCAL_ANALYSIS_REFUSED\n");
  process.exitCode = 2;
} else {
  const result = await runAmuxV4LocalAnalysisAgentOnce({
    origin: process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV],
    agentSecret: process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET,
    fetchImpl: fetch,
  });
  // Only the status enum is emitted. Never log a claim, prompt or credential.
  process.stdout.write(`AMUX_V4_LOCAL_ANALYSIS_${result.kind}\n`);
  if (!["idle", "draft_ready", "provider_failed", "disabled"].includes(result.kind)) {
    process.exitCode = 1;
  }
}
