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
import {
  DM_RESULT_LINE_MAX_BYTES,
  dmEncodeAbortLine,
  dmEncodePartLine,
} from "../../lib/amux/decisionMakerBrokerCore.ts";
import { amuxV22TransferChunkCount, amuxV22TransferChunkRange } from "../../lib/amux/v22TransferCore.ts";
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
 * The fake bridge in the parts protocol: the launch line, then -- when the broker
 * answers `send_parts` -- each file's chunks, one line each, each acknowledged
 * before the next. `files` is `Map<name, Buffer>`. `options.plan(name, index,
 * bytes)` may change what is sent: it returns the chunk line's value, the string
 * "abort" to send an abort instead, or "stop" to say nothing more. Resolves
 * `{ answer, transcript }`: the broker's lines in order (the last is the answer
 * when it is a `result`).
 */
export const bridgeCallParts = (path, message, files, options = {}) =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path, allowHalfOpen: true });
    const transcript = [];
    socket.once("error", reject);
    // The broker may answer right behind an acknowledgement (a refusal needs no
    // work), and both lines can arrive in one read: keep what follows a line.
    let pending = Buffer.alloc(0);
    let closed = false;
    let wake = null;
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      wake?.();
    });
    const onClosed = () => {
      closed = true;
      wake?.();
    };
    socket.once("end", onClosed);
    socket.once("close", onClosed);
    socket.once("connect", async () => {
      await dmWriteLine(socket, message, 5_000);
      const finish = (answer) => {
        socket.destroy();
        resolve({ answer, transcript });
      };
      const readOne = () =>
        new Promise((done) => {
          const timer = setTimeout(() => {
            wake = null;
            done({ ok: false, error: "timeout" });
          }, options.readTimeoutMs ?? 60_000);
          const settle = () => {
            const newline = pending.indexOf(10);
            if (newline === -1 && pending.length > DM_RESULT_LINE_MAX_BYTES) {
              clearTimeout(timer);
              wake = null;
              return done({ ok: false, error: "too_large" });
            }
            if (newline === -1 && !closed) return;
            clearTimeout(timer);
            wake = null;
            if (newline === -1) return done({ ok: false, error: "closed" });
            const line = pending.subarray(0, newline).toString("utf8");
            pending = pending.subarray(newline + 1);
            const value = JSON.parse(line);
            transcript.push(value);
            return done(value);
          };
          wake = settle;
          settle();
        });
      const first = await readOne();
      if (first.type !== "send_parts") return finish(first);
      for (const part of message.workspace.parts) {
        const bytes = files.get(part.name) ?? Buffer.alloc(0);
        for (let index = 0; index < amuxV22TransferChunkCount(part.bytes); index += 1) {
          const { start, end } = amuxV22TransferChunkRange(part.bytes, index);
          const chunk = bytes.subarray(start, end);
          const planned = (await options.plan?.(part.name, index, chunk)) ?? dmEncodePartLine(message.requestId, part.name, index, chunk);
          if (planned === "stop") {
            // Say nothing more: either wait for the broker's own answer, or go away.
            return finish(options.hangUp ? { ok: false, error: "bridge_gone" } : await readOne());
          }
          await dmWriteLine(socket, planned === "abort" ? dmEncodeAbortLine(message.requestId) : planned, 10_000);
          const ack = await readOne();
          if (ack.type !== "part_stored") return finish(ack);
        }
      }
      return finish(await readOne());
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
  { launcher = "real", executable, launchTimeoutMs = 20_000, timeouts = {}, fixtureOptions = {}, workspaceHttp, workspaceGit } = {},
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
    workspaceHttp,
    workspaceGit,
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
    callParts: (message, files, options) => bridgeCallParts(brokerPath, message, files, options),
    requestDirectory: () => fixture.at(fixture.paths.requestDirectory),
    stop: async () => {
      for (const socket of launcherConnections) socket.destroy();
      await closeServer(brokerServer);
      if (launcherServer) await closeServer(launcherServer);
      fixture.dispose();
    },
  };
};
