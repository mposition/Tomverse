import { createAmuxV22SidecarServer, createAmuxV22SidecarHandler,
  checkAmuxV22SidecarSocketDir, checkAmuxV22SidecarStateDir,
  amuxV22SidecarEnabled,
  AMUX_V22_SIDECAR_ENV, runAmuxV22OneShot } from
  "../lib/amux/v22OneShotSidecar.mjs";

if (!amuxV22SidecarEnabled(process.env[AMUX_V22_SIDECAR_ENV])) {
  // The executable is deliberately inert until a reviewed code change opens
  // its latch. An environment variable or systemd unit alone cannot start it.
  process.exit(0);
}

for (const name of ["DATABASE_URL", "DIRECT_URL", "TOMVERSE_AMUX_SYNC_SECRET",
  "TOMVERSE_INTERNAL_URL", "GITHUB_TOKEN", "GH_TOKEN"]) {
  if (process.env[name]) throw new Error("sidecar credential boundary violated");
}

const config = Object.freeze({
  worker: process.env.TOMVERSE_AMUX_V22_WORKER,
  binaryPath: process.env.TOMVERSE_AMUX_V22_CLAUDE_BINARY,
  worktreePath: process.env.TOMVERSE_AMUX_V22_WORKTREE,
  homePath: process.env.TOMVERSE_AMUX_V22_HOME,
  claudeConfigDir: process.env.TOMVERSE_AMUX_V22_CLAUDE_CONFIG_DIR,
});
const socketPath = process.env.TOMVERSE_AMUX_V22_SIDECAR_SOCKET;
const stateDir = process.env.TOMVERSE_AMUX_V22_SIDECAR_STATE_DIR;
await checkAmuxV22SidecarStateDir(stateDir);
await checkAmuxV22SidecarSocketDir(socketPath);
const sidecar = createAmuxV22SidecarServer(socketPath,
  createAmuxV22SidecarHandler({ worker: config.worker, stateDir,
    run: (request) => runAmuxV22OneShot(request, config) }));
await sidecar.listen();
