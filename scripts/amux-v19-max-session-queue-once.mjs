/** One content-free Max queue poll on the fixed Ubuntu worker. This command
 * cannot claim a budget, decrypt an idea, or start a model call. */
import { homedir } from "node:os";
import { join } from "node:path";
import { runAmuxV19MaxSessionQueueEntryOnce } from
  "../lib/amux/ideaLocalMaxSessionQueueEntry.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalSessionAnalysisQueuePoll.mjs";

if (process.platform !== "linux") {
  process.stderr.write("AMUX_V19_MAX_SESSION_QUEUE_REFUSED\n");
  process.exitCode = 2;
} else {
  let kind = "unavailable";
  try {
    const result = await runAmuxV19MaxSessionQueueEntryOnce({
      origin: process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV],
      fetchImpl: fetch,
      stateDirectory: join(homedir(),
        ".local/state/tomverse-amux-v19-max-analysis"),
    });
    kind = result.kind;
  } catch { /* Never emit queue IDs, price data, or response bodies. */ }
  process.stdout.write(`AMUX_V19_MAX_SESSION_QUEUE_${kind}\n`);
  if (!["idle", "discovered", "disabled", "catalog_unapproved",
      "more_unexamined"].includes(kind)) process.exitCode = 1;
}
