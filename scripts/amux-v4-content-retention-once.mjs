/** Run as a dedicated Railway cron service, not an app process or GitHub
 * Action. A hung fetch cannot make the next cron run disappear forever. */
import process from "node:process";

import { runAmuxContentRetentionTrigger } from
  "../lib/amux/ideaContentRetentionTrigger.mjs";

const HARD_DEADLINE_MS = 30_000;
const hardStop = setTimeout(() => {
  process.stderr.write("AMUX_V4_RETENTION_HARD_DEADLINE\n");
  process.exit(124);
}, HARD_DEADLINE_MS);
hardStop.unref();

const result = await runAmuxContentRetentionTrigger(process.env, fetch);
clearTimeout(hardStop);
// Never log a URL, token, storage key, idea id, or body.
process.stdout.write(`AMUX_V4_RETENTION_${result.kind}\n`);
if (result.kind === "completed") {
  process.stdout.write(`AMUX_V4_RETENTION_COUNTS ${JSON.stringify(result.scanned)}\n`);
}
if (!["dark", "disabled", "completed"].includes(result.kind)) process.exitCode = 1;
