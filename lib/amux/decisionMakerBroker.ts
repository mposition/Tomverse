import { createConnection } from "node:net";
import type { Duplex } from "node:stream";

import {
  DM_LAUNCHER_READY_TIMEOUT_MS,
  DM_LAUNCHER_RESPONSE_TIMEOUT_MS,
  DM_LAUNCHER_SOCKET_PATHS,
  DM_LAUNCH_LINE_MAX_BYTES,
  DM_LINE_WRITE_TIMEOUT_MS,
  DM_READY_LINE_MAX_BYTES,
  DM_REQUEST_READ_TIMEOUT_MS,
  DM_RESULT_LINE_MAX_BYTES,
  dmBrokerAnswer,
  dmEncodeLaunchRequest,
  dmLauncherReadyFits,
  dmParseLaunchRequest,
  dmParseLauncherAnswer,
  type DmBrokerAnswer,
  type DmBrokerLaunchView,
  type DmBrokerRefusal,
  type DmLaunchRequest,
} from "./decisionMakerBrokerCore.ts";
import { dmTransmitIntentRefusal, type DmCleanupOutcome } from "./decisionMakerLauncherCore.ts";
import {
  DM_SYSTEM_HOST,
  dmCleanupRequestDirectory,
  dmCreateRequestDirectory,
  dmRequestRootState,
  dmVendorGroupId,
  type DmLauncherHost,
} from "./decisionMakerLauncherFs.ts";
import { dmCloseStream, dmReadLine, dmWriteLine } from "./decisionMakerSocketLine.ts";
import type { DmInstanceScope } from "./decisionMakerSwitchCore.ts";

/**
 * The AMUX Decision Maker broker: docs/policy/amux-decision-maker.md policy
 * version 2, §2-4, §2-5, §5 (the broker's row of the isolation table, the
 * request directory and its deletion on every exit path, the check for a
 * leftover before the next request) and §10 (no DM process without the
 * recorded intent), stage S2-3b. It runs as `amux-dm-broker`, which holds no
 * vendor CLI login and no bridge credential, and calls no app route.
 *
 * One bridge connection is one request (lib/amux/decisionMakerBrokerCore.ts
 * for the protocol):
 *
 *   1. Read one `launch` line; refuse anything malformed. Touch nothing yet.
 *   2. Refuse `busy` when the instance, or this request id, is in flight --
 *      without touching anything, since that request's directory is in use.
 *   3. Check the intent against the exact payload bytes (§10). Refused: no
 *      directory is made and no launcher is contacted.
 *   4. §5: the request root holds nothing but requests in flight, the
 *      vendor's group is the one S0 made, and the request's directory is made
 *      empty, broker-owned, that group, `0750`. The card goes on stdin
 *      (§5a); the S2b snapshot is not part of this stage.
 *   5. Ask the instance's launcher (`ready`, then the request) and wait for
 *      its one answer, past the launcher unit's own hard limit.
 *   6. Always, once anything may have been made: delete the request directory
 *      (`dmCleanupRequestDirectory()`) and check it is gone.
 *   7. Answer the bridge, and close.
 *
 * The DM output is in the answer to the bridge and nowhere else: not logged,
 * not written to a file, not kept (§5). Requests for the two instances can run
 * at the same time; a second one for the same instance is refused, not queued.
 */

export type DmBrokerTimeouts = {
  requestRead: number;
  launcherReady: number;
  launcherResponse: number;
};

const SYSTEM_TIMEOUTS: DmBrokerTimeouts = Object.freeze({
  requestRead: DM_REQUEST_READ_TIMEOUT_MS,
  launcherReady: DM_LAUNCHER_READY_TIMEOUT_MS,
  launcherResponse: DM_LAUNCHER_RESPONSE_TIMEOUT_MS,
});

/** One line per request; codes, ids and durations only. */
export type DmBrokerLogEntry = {
  event: "amux_dm_broker_request";
  requestId: string | null;
  instance: string | null;
  launch: string;
  reasons: string[];
  transmission: string;
  result: string;
  cleanup: string;
  residue: string[];
  durationMs: number;
};

export type DmBrokerOptions = {
  host?: DmLauncherHost;
  /** Test host only: how to reach an instance's launcher. The system host uses the systemd socket. */
  connectLauncher?: (instance: DmInstanceScope) => Duplex;
  /** Test host only. */
  timeouts?: Partial<DmBrokerTimeouts>;
  log?: (entry: DmBrokerLogEntry) => void;
};

const defaultLog = (entry: DmBrokerLogEntry) => {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
};

const connectSystemLauncher = (instance: DmInstanceScope): Duplex =>
  createConnection({ path: DM_LAUNCHER_SOCKET_PATHS[instance], allowHalfOpen: true });

/** Resolves true on connect (or a stream that is not connecting), false on an error or the deadline first. */
const connected = (socket: Duplex, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (socket.destroyed) {
      resolve(false);
      return;
    }
    if ((socket as Duplex & { connecting?: boolean }).connecting !== true) {
      resolve(true);
      return;
    }
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      resolve(ok);
    };
    const onConnect = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });

/**
 * Step 5: connect, read `ready` for this instance, send the request, read
 * the answer. A connection that fails before `ready` delivered nothing
 * (`launcher_unreachable`); after the request line went out, anything but a
 * valid answer for this request is `launcher_lost`. `progress.contacted` is
 * set before the request line is written, so a fault anywhere after that is
 * never reported as "not started".
 */
const callLauncher = async (
  connect: (instance: DmInstanceScope) => Duplex,
  request: DmLaunchRequest,
  timeouts: DmBrokerTimeouts,
  progress: { contacted: boolean },
): Promise<DmBrokerLaunchView> => {
  let socket: Duplex;
  try {
    socket = connect(request.instance);
  } catch {
    return { kind: "launcher_unreachable", reason: "connect_failed" };
  }
  // A late error after the outcome is decided must not crash the broker.
  socket.on("error", () => {});
  try {
    if (!(await connected(socket, timeouts.launcherReady))) return { kind: "launcher_unreachable", reason: "connect_failed" };
    const ready = await dmReadLine(socket, DM_READY_LINE_MAX_BYTES, timeouts.launcherReady);
    if (!ready.ok) return { kind: "launcher_unreachable", reason: "ready_missing" };
    if (!dmLauncherReadyFits(ready.line, request.instance)) return { kind: "launcher_unreachable", reason: "ready_mismatch" };
    progress.contacted = true;
    if (!(await dmWriteLine(socket, dmEncodeLaunchRequest(request), DM_LINE_WRITE_TIMEOUT_MS))) {
      return { kind: "launcher_lost", reason: "request_not_delivered" };
    }
    const response = await dmReadLine(socket, DM_RESULT_LINE_MAX_BYTES, timeouts.launcherResponse);
    if (!response.ok) {
      return { kind: "launcher_lost", reason: response.error === "timeout" ? "response_timeout" : "response_missing" };
    }
    const answer = dmParseLauncherAnswer(response.line, request);
    if (answer === null) return { kind: "launcher_lost", reason: "response_malformed" };
    return answer.type === "launched"
      ? { kind: "launched", result: answer.result, cleanup: answer.cleanup }
      : { kind: "launcher_rejected", error: answer.error, cleanup: answer.cleanup };
  } finally {
    socket.destroy();
  }
};

export type DecisionMakerBroker = {
  /** Serves one bridge connection to its end. Never rejects. */
  handleConnection: (socket: Duplex) => Promise<DmBrokerAnswer>;
  /** The request in flight per instance, for tests and the log. */
  inFlight: () => ReadonlyMap<DmInstanceScope, string>;
};

export const createDecisionMakerBroker = (options: DmBrokerOptions = {}): DecisionMakerBroker => {
  const host = options.host ?? DM_SYSTEM_HOST;
  if (host.root === null && (options.connectLauncher !== undefined || options.timeouts !== undefined)) {
    throw new Error("AMUX Decision Maker broker sockets and deadlines are fixed on the system host");
  }
  const connect = options.connectLauncher ?? connectSystemLauncher;
  const timeouts: DmBrokerTimeouts = { ...SYSTEM_TIMEOUTS, ...options.timeouts };
  const log = options.log ?? defaultLog;
  const inFlight = new Map<DmInstanceScope, string>();

  /** Steps 3 to 6, for a request that is now this broker's. */
  const run = async (request: DmLaunchRequest): Promise<DmBrokerAnswer> => {
    const answer = (
      view: DmBrokerLaunchView,
      requestDirectory: DmCleanupOutcome | null,
      requestRoot: Array<"request_root_unusable" | "request_root_leftover"> = [],
    ) =>
      dmBrokerAnswer({
        requestId: request.requestId,
        instance: request.instance,
        requestKey: request.requestKey,
        view,
        requestDirectory,
        requestRoot,
      });
    const refused = (refusal: DmBrokerRefusal, requestDirectory: DmCleanupOutcome | null = null) =>
      answer({ kind: "broker_refused", refusals: [refusal] }, requestDirectory);

    const intent = dmTransmitIntentRefusal(request, request.transmitIntent, request.requestKey, request.payload);
    if (intent) return refused(intent);

    const others = new Set([...inFlight.values()].filter((id) => id !== request.requestId));
    const root = dmRequestRootState(host, others);
    // A root that cannot be checked, or holds a directory nobody is running,
    // means an earlier deletion was not verified: report it so §5 latches.
    if (root.state === "unusable") {
      return answer({ kind: "broker_refused", refusals: ["request_root_unusable"] }, null, ["request_root_unusable"]);
    }
    if (root.leftover > 0) {
      return answer({ kind: "broker_refused", refusals: ["request_root_leftover"] }, null, ["request_root_leftover"]);
    }
    const group = dmVendorGroupId(host, request.instance);
    if (!group.ok) return refused("vendor_group_unverifiable");

    const progress = { contacted: false };
    let view: DmBrokerLaunchView;
    try {
      view = dmCreateRequestDirectory(host, request.instance, request.requestId, group.groupId)
        ? await callLauncher(connect, request, timeouts, progress)
        : { kind: "broker_refused", refusals: ["request_directory_unusable"] };
    } catch {
      view = { kind: "broker_fault", contacted: progress.contacted };
    }
    // §5: on every path once a directory may exist, whatever the launcher said.
    let requestDirectory: DmCleanupOutcome;
    try {
      requestDirectory = dmCleanupRequestDirectory(host, request.instance, request.requestId);
    } catch {
      requestDirectory = { status: "cleanup_unknown", residue: [{ kind: "removal_failed", path: "" }] };
    }
    return answer(view, requestDirectory);
  };

  const handleConnection = async (socket: Duplex): Promise<DmBrokerAnswer> => {
    const started = Date.now();
    socket.on("error", () => {});
    let response: DmBrokerAnswer;
    try {
      const read = await dmReadLine(socket, DM_LAUNCH_LINE_MAX_BYTES, timeouts.requestRead);
      const parsed = read.ok ? dmParseLaunchRequest(read.line) : null;
      if (parsed === null || !parsed.ok) {
        response = dmBrokerAnswer({
          requestId: parsed?.requestId ?? null,
          instance: parsed?.instance ?? null,
          requestKey: parsed?.requestKey ?? null,
          view: { kind: "broker_refused", refusals: [parsed === null ? "request_unreadable" : parsed.refusal] },
          requestDirectory: null,
          requestRoot: [],
        });
      } else {
        const { request } = parsed;
        const busy = inFlight.has(request.instance) || [...inFlight.values()].includes(request.requestId);
        if (busy) {
          response = dmBrokerAnswer({
            requestId: request.requestId,
            instance: request.instance,
            requestKey: request.requestKey,
            view: { kind: "broker_refused", refusals: ["busy"] },
            requestDirectory: null,
            requestRoot: [],
          });
        } else {
          inFlight.set(request.instance, request.requestId);
          try {
            response = await run(request);
          } finally {
            inFlight.delete(request.instance);
          }
        }
      }
    } catch {
      // Nothing above throws by design; if something did, nothing is known.
      response = dmBrokerAnswer({
        requestId: null,
        instance: null,
        requestKey: null,
        view: { kind: "broker_fault", contacted: true },
        requestDirectory: null,
        requestRoot: [],
      });
    }
    log({
      event: "amux_dm_broker_request",
      requestId: response.requestId,
      instance: response.instance,
      launch: response.launch.outcome,
      reasons: response.launch.reasons,
      transmission: response.transmission,
      result: response.result.kind,
      cleanup: response.cleanup.status,
      residue: response.cleanup.status === "verified" ? [] : response.cleanup.residue.map((entry) => `${entry.scope}:${entry.kind}`),
      durationMs: Date.now() - started,
    });
    await dmWriteLine(socket, response, DM_LINE_WRITE_TIMEOUT_MS);
    await dmCloseStream(socket, DM_LINE_WRITE_TIMEOUT_MS);
    return response;
  };

  return { handleConnection, inFlight: () => new Map(inFlight) };
};

// ---------------------------------------------------------------------------
// systemd socket activation
// ---------------------------------------------------------------------------

/** sd_listen_fds(3): the first passed descriptor. */
export const DM_SYSTEMD_FIRST_FD = 3;

/**
 * The broker listens only on the socket systemd passed it (`LISTEN_FDS=1`
 * for this process), whose owner, group and mode systemd set
 * (scripts/systemd/amux-dm-broker.socket). It never makes a socket path of
 * its own. Null when it was not started that way.
 */
export const dmSystemdListenFd = (environment: NodeJS.ProcessEnv, pid: number): number | null =>
  environment.LISTEN_PID === String(pid) && environment.LISTEN_FDS === "1" ? DM_SYSTEMD_FIRST_FD : null;
