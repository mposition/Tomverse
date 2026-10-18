// The AMUX Decision Maker launcher's entry point (docs/policy/amux-decision-maker.md
// §5 and §5a, stage S2-3b). Bundled by scripts/build-amux-decision-maker.mjs
// into /opt/tomverse-amux-dm/launcher.mjs. systemd starts it once per
// connection on amux-dm-launcher-<vendor>.socket, as that vendor account,
// with the connection on stdin (`StandardInput=socket`):
//
//   node launcher.mjs <instance>
//
// The operator may also run the vendor account's half of the cleanup alone,
// for example before the first request, when S0 left CLI state in the home:
//
//   runuser -u <vendor account> -- node launcher.mjs <instance> --cleanup-only
//
// It refuses to run as any account but the instance's own.

import { Socket } from "node:net";

import { DM_SYSTEM_PATH_OWNERS, isDmLauncherInstance } from "../lib/amux/decisionMakerLauncherCore.ts";
import { DM_SYSTEM_HOST, dmCleanupVendor } from "../lib/amux/decisionMakerLauncherFs.ts";
import { serveDecisionMakerLauncherConnection } from "../lib/amux/decisionMakerLauncherService.ts";

const report = (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`);
const fail = (code) => {
  report({ event: "amux_dm_launcher_start_refused", code });
  process.exit(2);
};

const [instance, mode, ...rest] = process.argv.slice(2);
if (!isDmLauncherInstance(instance) || rest.length > 0) fail("arguments_not_fixed");
if (mode !== undefined && mode !== "--cleanup-only") fail("arguments_not_fixed");
if (typeof process.geteuid !== "function" || process.geteuid() !== DM_SYSTEM_PATH_OWNERS.vendor[instance]) {
  fail("account_not_instance");
}

if (mode === "--cleanup-only") {
  const cleanup = dmCleanupVendor(DM_SYSTEM_HOST, instance, null);
  // The operator's own terminal: the paths say what is left.
  process.stdout.write(`${JSON.stringify(cleanup)}\n`);
  process.exit(cleanup.status === "verified" ? 0 : 1);
}

let socket;
try {
  socket = new Socket({ fd: 0, readable: true, writable: true, allowHalfOpen: true });
} catch {
  fail("stdin_not_socket");
}
const served = await serveDecisionMakerLauncherConnection(socket, { instance });
report({ event: "amux_dm_launcher_connection", instance, ...served });
