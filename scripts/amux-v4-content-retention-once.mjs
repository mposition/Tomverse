import { runAmuxV4LocalRetentionOnce } from
  "../lib/amux/ideaLocalRetentionTrigger.mjs";
import { localRetentionHaltFile } from
  "../lib/amux/ideaLocalRetentionHaltFile.mjs";

if (process.platform !== "linux" ||
    process.env.TOMVERSE_AMUX_V4_LOCAL_RETENTION !== "enabled") {
  process.stderr.write("AMUX_V4_RETENTION_REFUSED\n");
  process.exitCode = 2;
} else {
  let result = { kind: "refused" };
  try {
    const state = localRetentionHaltFile(
      process.env.TOMVERSE_AMUX_V4_RETENTION_STATE_DIR);
    result = await runAmuxV4LocalRetentionOnce({
      origin: process.env.TOMVERSE_AMUX_V4_RETENTION_APP_ORIGIN,
      secret: process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET,
      claim: state.claim, release: state.release,
    });
  } catch { /* Only the status enum reaches logs. */ }
  process.stdout.write(`AMUX_V4_RETENTION_${result.kind}\n`);
  if (result.kind !== "completed" && result.kind !== "disabled") {
    process.exitCode = 1;
  }
}
