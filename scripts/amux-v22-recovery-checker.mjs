import { AMUX_V22_RECOVERY_CHECKER_ENV, runAmuxV22RecoveryCheckerOnce } from
  "../lib/amux/v22RecoveryHost.mjs";

// Separate from the bridge/sidecar switches. Shipping this file never starts
// a host check; deployment and activation remain distinct owner decisions.
if (process.env[AMUX_V22_RECOVERY_CHECKER_ENV] !== "1") process.exit(0);
if (process.platform !== "linux") throw new Error("recovery checker requires Ubuntu");
for (const name of ["DATABASE_URL", "DIRECT_URL", "GITHUB_TOKEN", "GH_TOKEN",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"])
  if (process.env[name]) throw new Error("recovery checker credential boundary violated");
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
  throw new Error("recovery checker transport boundary violated");

const result = await runAmuxV22RecoveryCheckerOnce({
  enabled: process.env[AMUX_V22_RECOVERY_CHECKER_ENV],
  workerName: process.env.TOMVERSE_AMUX_V22_WORKER,
  socketPath: process.env.TOMVERSE_AMUX_V22_SIDECAR_SOCKET,
  internalUrl: process.env.TOMVERSE_INTERNAL_URL,
  syncSecret: process.env.TOMVERSE_AMUX_SYNC_SECRET,
});
// No host path, provider text, credentials or socket payload is logged.
console.log(JSON.stringify(result));
if (["outcome_unknown", "unavailable"].includes(result.state)) process.exitCode = 3;
