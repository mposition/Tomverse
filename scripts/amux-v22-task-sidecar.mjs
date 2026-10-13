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

const config = amuxV22SidecarLaunchConfigFromEnvironment(process.env);
const socketPath = process.env.TOMVERSE_AMUX_V22_SIDECAR_SOCKET;
const stateDir = process.env.TOMVERSE_AMUX_V22_SIDECAR_STATE_DIR;
const invocationId = process.env.INVOCATION_ID ?? null;
await checkAmuxV22SidecarStateDir(stateDir);
await checkAmuxV22SidecarSocketDir(socketPath);
const sidecar = createAmuxV22SidecarServer(socketPath,
  createAmuxV22SidecarHandler({ worker: config.worker, stateDir,
    invocationId,
    recoveryUnit: () => inspectAmuxV22RecoveryUnit({ worker: config.worker, invocationId }),
    recoveryWorkspace: () => captureAmuxV22PatchBaseline(config.worktreePath),
    quota: () => probeAmuxV22ClaudeQuota(config),
    run: (request) => runAmuxV22OneShot(request, config) }));
await sidecar.listen();
