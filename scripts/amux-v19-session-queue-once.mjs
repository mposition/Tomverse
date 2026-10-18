/** One read-only Ubuntu queue discovery. No budget claim or CLI dispatch. */
import { homedir } from "node:os";
import { join } from "node:path";
import { runAmuxV19SessionQueueEntryOnce } from
  "../lib/amux/ideaLocalSessionQueueEntry.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalSessionAnalysisQueuePoll.mjs";

if (process.platform !== "linux") {
  process.stderr.write("AMUX_V19_SESSION_QUEUE_REFUSED\n");
  process.exitCode = 2;
} else {
  let kind = "unavailable";
  try {
    const result = await runAmuxV19SessionQueueEntryOnce({
      origin: process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV],
      agentSecret: process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET,
      fetchImpl: fetch,
      stateDirectory: join(homedir(), ".local/state/tomverse-amux-v19-analysis"),
    });
    kind = result.kind;
  } catch { /* Never emit queue IDs or response bodies. */ }
  process.stdout.write(`AMUX_V19_SESSION_QUEUE_${kind}\n`);
  if (!["idle", "discovered", "disabled", "catalog_unapproved",
      "more_unexamined"].includes(kind))
    process.exitCode = 1;
}
