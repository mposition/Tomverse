// The AMUX Decision Maker broker's entry point (docs/policy/amux-decision-maker.md
// §5, stage S2-3b). Bundled by scripts/build-amux-decision-maker.mjs into
// /opt/tomverse-amux-dm/broker.mjs and started by systemd from
// amux-dm-broker.socket as `amux-dm-broker`. It listens only on the socket
// systemd passes it and refuses to run as any other account.

import { createServer } from "node:net";

import { createDecisionMakerBroker, dmSystemdListenFd } from "../lib/amux/decisionMakerBroker.ts";
import { DM_SYSTEM_PATH_OWNERS } from "../lib/amux/decisionMakerLauncherCore.ts";

const fail = (code) => {
  process.stderr.write(`${JSON.stringify({ event: "amux_dm_broker_start_refused", code })}\n`);
  process.exit(2);
};

if (process.argv.length !== 2) fail("arguments_not_fixed");
if (typeof process.geteuid !== "function" || process.geteuid() !== DM_SYSTEM_PATH_OWNERS.broker) fail("account_not_broker");
const fd = dmSystemdListenFd(process.env, process.pid);
if (fd === null) fail("not_socket_activated");

const broker = createDecisionMakerBroker();
const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
  void broker.handleConnection(socket);
});
// The bridge is one client; a few connections at once is already abnormal.
server.maxConnections = 8;
server.on("error", () => fail("listen_failed"));
server.listen({ fd });
