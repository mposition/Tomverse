// A broker under test (lib/amux/decisionMakerBroker.ts, stage S2-3b) with a
// fake bridge: the broker and each launcher listen on local sockets of their
// own -- Unix sockets in the fixture's temporary directory, or named pipes on
// Windows -- and the bridge is a client that sends one `launch` line and reads
// one answer. The launcher is either the real launcher side
// (lib/amux/decisionMakerLauncherService.ts) on the fixture's re-rooted host,
// or a scripted stand-in. Nothing outside the temporary directory is touched.

import { randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

import { createDecisionMakerBroker } from "../../lib/amux/decisionMakerBroker.ts";
import { DM_RESULT_LINE_MAX_BYTES } from "../../lib/amux/decisionMakerBrokerCore.ts";
import { serveDecisionMakerLauncherConnection } from "../../lib/amux/decisionMakerLauncherService.ts";
import { dmReadLine, dmWriteLine } from "../../lib/amux/decisionMakerSocketLine.ts";
import { PAYLOAD, REQUEST_ID, REQUEST_KEY, makeLauncherFixture } from "./amuxDmLauncherFixture.mjs";

export const socketPath = (root, name) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\amux-dm-test-${randomBytes(6).toString("hex")}-${name}`
    : join(root, `${name}.sock`);

export const listen = (path, onConnection) =>
  new Promise((resolve, reject) => {
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, onConnection);
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });

export const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));

/** The launch line the bridge sends for the fixture's request. */
export const launchLine = (fixture, overrides = {}) => ({
  v: 1,
  type: "launch",
  requestId: REQUEST_ID,
  instance: fixture.spec.instance,
  requestKey: REQUEST_KEY.toString("hex"),
  payload: PAYLOAD.toString("base64"),
  transmitIntent: fixture.evidence,
  ...overrides,
});

/** The fake bridge: one connection, one line out (a value, or raw text), one answer back. */
export const bridgeCall = (path, message) =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path, allowHalfOpen: true });
    socket.once("error", reject);
    socket.once("connect", async () => {
      if (typeof message === "string") socket.write(message);
      else if (message !== undefined) await dmWriteLine(socket, message, 5_000);
      const read = await dmReadLine(socket, DM_RESULT_LINE_MAX_BYTES, 60_000);
      socket.destroy();
      resolve(read.ok ? JSON.parse(read.line) : read);
    });
  });

/**
 * A broker for `instance` with its launcher. `launcher` is "real" (the
 * launcher side with the stand-in CLI `executable`), a function serving each
 * launcher connection, or "absent" (nothing listens). `fixtureOptions` go to
 * the S2-3a fixture; the request directory is left to the broker.
 */
export const startBroker = async (
  instance,
  { launcher = "real", executable, launchTimeoutMs = 20_000, timeouts = {}, fixtureOptions = {}, snapshotHttp } = {},
) => {
  const fixture = makeLauncherFixture(instance, { executable, ...fixtureOptions, requestDirectory: false });
  const launcherPath = socketPath(fixture.root, "launcher");
  const brokerPath = socketPath(fixture.root, "broker");
  const launcherConnections = [];
  const served = [];
  const logs = [];
  let launcherServer = null;
  if (launcher !== "absent") {
    launcherServer = await listen(launcherPath, (socket) => {
      launcherConnections.push(socket);
      if (launcher === "real") {
        void serveDecisionMakerLauncherConnection(socket, {
          instance,
          host: fixture.host,
          launch: { expectedExecutableSha256: fixture.executableSha256, timeoutMs: launchTimeoutMs },
          requestReadTimeoutMs: 5_000,
        }).then((result) => served.push(result));
      } else {
        void launcher(socket, fixture);
      }
    });
  }
  const broker = createDecisionMakerBroker({
    host: fixture.host,
    connectLauncher: () => createConnection({ path: launcherPath, allowHalfOpen: true }),
    timeouts: { requestRead: 2_000, launcherReady: 2_000, launcherResponse: 30_000, ...timeouts },
    log: (entry) => logs.push(entry),
    snapshotHttp,
  });
  const brokerServer = await listen(brokerPath, (socket) => void broker.handleConnection(socket));
  return {
    fixture,
    broker,
    brokerPath,
    launcherConnections,
    served,
    logs,
    call: (message) => bridgeCall(brokerPath, message),
    requestDirectory: () => fixture.at(fixture.paths.requestDirectory),
    stop: async () => {
      for (const socket of launcherConnections) socket.destroy();
      await closeServer(brokerServer);
      if (launcherServer) await closeServer(launcherServer);
      fixture.dispose();
    },
  };
};
