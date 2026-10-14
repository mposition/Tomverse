import { AMUX_V22_LEGACY_SAFE_STOP_ENV, AMUX_V22_RECOVERY_CONTROLLER_SECRET_ENV,
  runAmuxV22RecoveryControllerTick } from "../lib/amux/v22RecoveryController.mjs";

// A built artifact remains inert until both independent exact-true gates are
// set by an operator. This process never starts or restarts a worker.
if (process.env.TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED !== "true" ||
    process.env[AMUX_V22_LEGACY_SAFE_STOP_ENV] !== "true") process.exit(0);
if (process.platform !== "linux" || process.getuid?.() !== 0)
  throw new Error("recovery controller requires root on Ubuntu");
for (const name of ["DATABASE_URL", "DIRECT_URL", "GITHUB_TOKEN", "GH_TOKEN",
  "TOMVERSE_AMUX_SYNC_SECRET", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN", "GOOGLE_GENERATIVE_AI_API_KEY", "PERPLEXITY_API_KEY",
  "XAI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY"])
  if (process.env[name]) throw new Error("recovery controller credential boundary violated");
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
  throw new Error("recovery controller transport boundary violated");

const result = await runAmuxV22RecoveryControllerTick({
  recoveryEnabled: process.env.TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED,
  safeStopEnabled: process.env[AMUX_V22_LEGACY_SAFE_STOP_ENV],
  internalUrl: process.env.TOMVERSE_INTERNAL_URL,
  controllerSecret: process.env[AMUX_V22_RECOVERY_CONTROLLER_SECRET_ENV],
});
// Never print a PID, path, systemd output, credential, or worker/model output.
console.log(JSON.stringify(result));
if (["outcome_unknown", "unavailable"].includes(result.state) ||
    ["outcome_unknown", "unavailable"].includes(result.followUp?.state)) process.exitCode = 3;
