import { createAmuxV22SidecarServer, createAmuxV22SidecarHandler,
  checkAmuxV22SidecarSocketDir, checkAmuxV22SidecarStateDir,
  amuxV22SidecarEnabled,
  AMUX_V22_SIDECAR_ENV, runAmuxV22OneShot, probeAmuxV22ClaudeQuota } from
  "../lib/amux/v22OneShotSidecar.mjs";
import { probeAmuxV22ChannelQuota } from "../lib/amux/v22ChannelQuota.mjs";
import { inspectAmuxV22RecoveryUnit } from "../lib/amux/v22RecoveryHost.mjs";
import { captureAmuxV22PatchBaseline } from "../lib/amux/v22PatchCapture.mjs";
import { amuxV22SidecarLaunchConfigFromEnvironment } from
  "../lib/amux/v22ReadOnlyRetryProtocol.mjs";

if (!amuxV22SidecarEnabled(process.env[AMUX_V22_SIDECAR_ENV])) {
  // The executable is deliberately inert until a reviewed code change opens
  // its latch. An environment variable or systemd unit alone cannot start it.
  process.exit(0);
}

for (const name of ["DATABASE_URL", "DIRECT_URL", "TOMVERSE_AMUX_SYNC_SECRET",
  "TOMVERSE_INTERNAL_URL", "GITHUB_TOKEN", "GH_TOKEN"]) {
  if (process.env[name]) throw new Error("sidecar credential boundary violated");
}

// The CLI this sidecar runs (a v19 channel name); Claude when unset. Another
// provider reuses the binary and config-directory variables for its own CLI.
const provider = process.env.TOMVERSE_AMUX_V22_PROVIDER ?? "anthropic";
if (!["anthropic", "openai", "github-copilot", "cursor", "antigravity"].includes(provider))
  throw new Error("invalid sidecar provider");
const config = { ...amuxV22SidecarLaunchConfigFromEnvironment(process.env), provider };
// The agy /usage group that bounds the worker's model (default "Gemini 4
// Argon"; Gemini Flash or Pro is "Gemini Models"). Read only for the quota.
const quotaGroup = process.env.TOMVERSE_AMUX_V22_ANTIGRAVITY_QUOTA_GROUP || undefined;
const socketPath = process.env.TOMVERSE_AMUX_V22_SIDECAR_SOCKET;
const stateDir = process.env.TOMVERSE_AMUX_V22_SIDECAR_STATE_DIR;
const invocationId = process.env.INVOCATION_ID ?? null;
await checkAmuxV22SidecarStateDir(stateDir);
await checkAmuxV22SidecarSocketDir(socketPath);
const sidecar = createAmuxV22SidecarServer(socketPath,
  createAmuxV22SidecarHandler({ worker: config.worker, stateDir, provider,
    invocationId,
    recoveryUnit: () => inspectAmuxV22RecoveryUnit({ worker: config.worker, invocationId }),
    recoveryWorkspace: () => captureAmuxV22PatchBaseline(config.worktreePath),
    // Each provider reads its own sign-in's subscription quota; what the
    // app does with a non-Claude reading is TOMVERSE_AMUX_V22_NON_CLAUDE_QUOTA_GATE.
    quota: () => provider === "anthropic" ? probeAmuxV22ClaudeQuota(config) :
      probeAmuxV22ChannelQuota(provider, { ...config, quotaGroup }),
    run: (request) => runAmuxV22OneShot(request, config) }));
await sidecar.listen();
