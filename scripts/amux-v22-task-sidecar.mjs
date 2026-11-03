import { createAmuxV22SidecarServer, createAmuxV22SidecarHandler,
  checkAmuxV22SidecarSocketDir, checkAmuxV22SidecarStateDir,
  amuxV22SidecarEnabled,
  AMUX_V22_SIDECAR_ENV, runAmuxV22OneShot, probeAmuxV22ClaudeQuota } from
  "../lib/amux/v22OneShotSidecar.mjs";
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
if (!["anthropic", "openai", "github-copilot", "cursor"].includes(provider))
  throw new Error("invalid sidecar provider");
const config = { ...amuxV22SidecarLaunchConfigFromEnvironment(process.env), provider };
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
    // Only Claude's subscription quota can be read; the app claims another
    // provider's route without one.
    quota: () => provider === "anthropic" ? probeAmuxV22ClaudeQuota(config) : null,
    run: (request) => runAmuxV22OneShot(request, config) }));
await sidecar.listen();
