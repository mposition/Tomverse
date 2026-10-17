import type { Duplex } from "node:stream";

import {
  DM_LAUNCH_LINE_MAX_BYTES,
  DM_LINE_WRITE_TIMEOUT_MS,
  DM_REQUEST_READ_TIMEOUT_MS,
  dmEncodeLauncherLaunched,
  dmEncodeLauncherReady,
  dmEncodeLauncherRejected,
  dmLauncherRequestError,
  dmParseLaunchRequest,
  type DmLauncherProtocolError,
} from "./decisionMakerBrokerCore.ts";
import { DM_SYSTEM_HOST, dmCleanupVendor, type DmLauncherHost } from "./decisionMakerLauncherFs.ts";
import { launchDecisionMaker, type DmLaunchOptions } from "./decisionMakerLauncherProcess.ts";
import { dmCloseStream, dmReadLine, dmWriteLine } from "./decisionMakerSocketLine.ts";
import type { DmInstanceScope } from "./decisionMakerSwitchCore.ts";

/**
 * The AMUX Decision Maker launcher's socket side: docs/policy/amux-decision-maker.md
 * policy version 2, §5 ("실행 방식", hard timeout, the vendor account's half
 * of the cleanup) and §5a, stage S2-3b.
 *
 * systemd starts one launcher unit per connection on the instance's socket
 * (`Accept=yes`), as that vendor account, with the connection on stdin; the
 * unit's control group and `RuntimeMaxSec` contain the CLI even if this
 * process dies (scripts/systemd/amux-dm-launcher-*@.service). One connection
 * is one request:
 *
 *   1. `ready` with the unit's own instance. Nothing is read before it, so a
 *      broker that sees no `ready` knows it sent nothing.
 *   2. One `launch` line within the read deadline, held to the broker
 *      protocol's strict parse, for this unit's instance only.
 *   3. `launchDecisionMaker()` (lib/amux/decisionMakerLauncherProcess.ts):
 *      every §5/§5a check, the intent evidence against the exact bytes, the
 *      process, the hard timeout and the vendor cleanup.
 *   4. One answer -- `launched` with the result and the cleanup's kinds, or
 *      `rejected` when step 2 failed (then nothing was started, and the
 *      account's state is still cleaned and checked).
 *
 * The answer goes back on the same connection to the broker and nowhere
 * else (§5: "DM stdout은 broker를 거쳐 bridge로만"). This module writes no
 * file, log or card; the DM output is only in the answer.
 */

export type DmLauncherServeOptions = {
  instance: DmInstanceScope;
  host?: DmLauncherHost;
  /** Test seams of `launchDecisionMaker()`; refused there on the system host. */
  launch?: Omit<DmLaunchOptions, "host">;
  /** Test host only. */
  requestReadTimeoutMs?: number;
};

/** What the connection came to, for the caller's log: codes only. */
export type DmLauncherServed =
  | { answered: "launched"; outcome: string; cleanup: string }
  | { answered: "rejected"; error: DmLauncherProtocolError; cleanup: string }
  | { answered: "not_ready" };

export async function serveDecisionMakerLauncherConnection(
  stream: Duplex,
  options: DmLauncherServeOptions,
): Promise<DmLauncherServed> {
  const host = options.host ?? DM_SYSTEM_HOST;
  if (options.requestReadTimeoutMs !== undefined && host.root === null) {
    throw new Error("AMUX Decision Maker launcher read deadline is fixed on the system host");
  }
  const { instance } = options;
  try {
    if (!(await dmWriteLine(stream, dmEncodeLauncherReady(instance), DM_LINE_WRITE_TIMEOUT_MS))) {
      return { answered: "not_ready" };
    }
    const read = await dmReadLine(stream, DM_LAUNCH_LINE_MAX_BYTES, options.requestReadTimeoutMs ?? DM_REQUEST_READ_TIMEOUT_MS);
    const parsed = read.ok ? dmParseLaunchRequest(read.line) : null;
    const error: DmLauncherProtocolError | null = parsed === null ? "request_unreadable" : dmLauncherRequestError(parsed, instance);
    if (error !== null || parsed === null || !parsed.ok) {
      const rejectedWith = error ?? "request_malformed";
      // Nothing was started; the account's state is still this request's to clean and check.
      const cleanup = dmCleanupVendor(host, instance, null);
      await dmWriteLine(stream, dmEncodeLauncherRejected(rejectedWith, cleanup), DM_LINE_WRITE_TIMEOUT_MS);
      return { answered: "rejected", error: rejectedWith, cleanup: cleanup.status };
    }
    const { request } = parsed;
    const report = await launchDecisionMaker(
      {
        instance,
        requestId: request.requestId,
        evidence: request.transmitIntent,
        requestKey: request.requestKey,
        payload: request.payload,
      },
      { ...options.launch, host },
    );
    await dmWriteLine(stream, dmEncodeLauncherLaunched(request, report.result, report.cleanup), DM_LINE_WRITE_TIMEOUT_MS);
    return { answered: "launched", outcome: report.result.outcome, cleanup: report.cleanup.status };
  } finally {
    await dmCloseStream(stream, DM_LINE_WRITE_TIMEOUT_MS);
  }
}
