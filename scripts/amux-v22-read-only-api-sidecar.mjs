import { createAmuxV22ReadOnlyApiHost } from
  "../lib/amux/v22ReadOnlyApiHost.mjs";
import { checkAmuxV22SidecarSocketDir, checkAmuxV22SidecarStateDir,
  createAmuxV22SidecarHandler, createAmuxV22SidecarServer,
  runAmuxV22ReadOnlyApiOneShot } from "../lib/amux/v22OneShotSidecar.mjs";

if (process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED !== "true")
  process.exit(0);

const host = await createAmuxV22ReadOnlyApiHost(process.env);
setTimeout(() => process.exit(124),
  Math.max(1, host.hostDeadlineAtMs - Date.now()));
const socketPath = process.env.TOMVERSE_AMUX_V22_SIDECAR_SOCKET;
const stateDir = process.env.TOMVERSE_AMUX_V22_SIDECAR_STATE_DIR;
await checkAmuxV22SidecarStateDir(stateDir);
await checkAmuxV22SidecarSocketDir(socketPath);
const sidecar = createAmuxV22SidecarServer(socketPath,
  createAmuxV22SidecarHandler({ worker: host.worker, stateDir,
    protocolCapabilities: host.capabilities,
    run: request => runAmuxV22ReadOnlyApiOneShot(request, host) }));
await sidecar.listen();
