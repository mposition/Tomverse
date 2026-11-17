import { runAmuxV4LocalRetentionOnce } from
  "../lib/amux/ideaLocalRetentionTrigger.mjs";

// Each tick asks the app once; an unconfirmed tick exits non-zero and the
// next one simply asks again (operator, 2026-11-16).
if (process.platform !== "linux" ||
    process.env.TOMVERSE_AMUX_V4_LOCAL_RETENTION !== "enabled") {
  process.stderr.write("AMUX_V4_RETENTION_REFUSED\n");
  process.exitCode = 2;
} else {
  let result = { kind: "refused" };
  try {
    result = await runAmuxV4LocalRetentionOnce({
      origin: process.env.TOMVERSE_AMUX_V4_RETENTION_APP_ORIGIN,
      secret: process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET,
    });
  } catch { /* Only the status enum reaches logs. */ }
  process.stdout.write(`AMUX_V4_RETENTION_${result.kind}\n`);
  if (result.kind !== "completed" && result.kind !== "disabled") {
    process.exitCode = 1;
  }
}
