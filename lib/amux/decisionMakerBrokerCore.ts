import { dmResultDigest } from "./decisionMakerBodyCore.ts";
import {
  DM_CLEANUP_RESIDUE_KINDS,
  DM_LAUNCH_OUTPUT_MAX_BYTES,
  DM_LAUNCH_REFUSALS,
  DM_LAUNCH_UNAVAILABLE_REASONS,
  isDmLauncherInstance,
  type DmCleanupOutcome,
  type DmLaunchResult,
} from "./decisionMakerLauncherCore.ts";
import { DM_LAUNCH_HARD_TIMEOUT_MS } from "./decisionMakerLauncherProcess.ts";
import { isDmRequestId } from "./decisionMakerRequestCore.ts";
import { DM_SNAPSHOT_PATHS_MAX, dmSnapshotPayloadLines, type DmSnapshot } from "./decisionMakerSnapshot.ts";
import type { DmInstanceScope } from "./decisionMakerSwitchCore.ts";

/**
 * The AMUX Decision Maker broker's local socket protocols, their
 * deterministic core: docs/policy/amux-decision-maker.md policy version 2,
 * §2-4 and §2-5 (the broker hands the DM's output to the bridge), §5 (the
 * broker and the vendor accounts are different UIDs; the DM's stdout reaches
 * only the bridge, through the broker), §9 (the result digest) and §10 (the
 * transmission intent and receipt), stage S2-3b.
 *
 * Two connections, one request each, one line each way (one JSON text and
 * `\n`, lib/amux/decisionMakerSocketLine.ts):
 *
 *   bridge -> broker   `/run/amux-dm-broker/broker.sock`. systemd owns it:
 *                       the broker's account, the bridge's group, `0660`, so
 *                       only the bridge connects. The bridge sends a `launch`
 *                       request after the transmissions route recorded the
 *                       intent for exactly these payload bytes; the broker
 *                       answers with one `result` line and closes.
 *   broker -> launcher `/run/amux-dm-launcher/<instance>.sock`. systemd owns
 *                       it: the broker's account and group, `0600`, so only
 *                       the broker connects; every connection starts one
 *                       launcher unit as that vendor account. The launcher
 *                       first sends `ready` with its instance, and only then
 *                       does the broker send the request -- so a connection
 *                       that ends before `ready` provably delivered nothing.
 *
 * The broker never calls an app route (it holds no credential, §5): the
 * bridge records the intent before and the receipt, result and cleanup after.
 * The broker's answer says which of those the bridge has to record:
 * `transmission` (whether a DM process was started and ended, never started,
 * or cannot be told), `result` with its §9 digest under the request key, and
 * `cleanup` (`cleanup_unknown` is what §5 latches the instance on).
 *
 * Pure. No card text, payload, key or output is logged by anything here.
 */

export const DM_BROKER_PROTOCOL_VERSION = 1;

/** systemd's sockets (scripts/systemd/amux-dm-*.socket). */
export const DM_BROKER_SOCKET_PATH = "/run/amux-dm-broker/broker.sock";
export const DM_LAUNCHER_SOCKET_PATHS: Readonly<Record<DmInstanceScope, string>> = Object.freeze({
  "decision-maker-openai": "/run/amux-dm-launcher/decision-maker-openai.sock",
  "decision-maker-anthropic": "/run/amux-dm-launcher/decision-maker-anthropic.sock",
});

// ---------------------------------------------------------------------------
// Caps and deadlines (not in the policy; the protocol's own)
// ---------------------------------------------------------------------------

/**
 * The stdin payload. §5 caps the card's text at 16 KiB; serialized as JSON a
 * byte takes at most six, so 96 KiB, plus the DM's instructions -- 128 KiB --
 * and the snapshot's lines, at most DM_SNAPSHOT_TOTAL_MAX_BYTES (512 KiB) and
 * their header: 768 KiB. A larger payload is refused before anything is made.
 */
export const DM_PAYLOAD_MAX_BYTES = 768 * 1024;
/** A `launch` line: the payload as base64 (4/3) and the fixed fields. */
export const DM_LAUNCH_LINE_MAX_BYTES = 1280 * 1024;
/**
 * A `result` line: the output (at most `DM_LAUNCH_OUTPUT_MAX_BYTES`, at most
 * six bytes each as a JSON string) and the fixed fields.
 */
export const DM_RESULT_LINE_MAX_BYTES = 2 * 1024 * 1024;
export const DM_READY_LINE_MAX_BYTES = 1024;

/** How long the broker waits for the bridge's request line, and the launcher for the broker's. */
export const DM_REQUEST_READ_TIMEOUT_MS = 10_000;
/** How long the broker waits for the launcher's `ready`, from connect. */
export const DM_LAUNCHER_READY_TIMEOUT_MS = 10_000;
/** A write of one line, and a close. */
export const DM_LINE_WRITE_TIMEOUT_MS = 10_000;
/**
 * The launcher unit's `RuntimeMaxSec`: the hard timeout (§5, 30 minutes,
 * enforced by the launcher) plus two minutes for reading the result and the
 * vendor cleanup. systemd stops the unit's whole control group there, so a
 * launcher that hangs cannot outlive it.
 */
export const DM_LAUNCHER_UNIT_RUNTIME_MAX_MS = DM_LAUNCH_HARD_TIMEOUT_MS + 2 * 60 * 1000;
/** The broker waits one minute past the unit's limit: by then the unit is gone, so a late answer cannot follow. */
export const DM_LAUNCHER_RESPONSE_TIMEOUT_MS = DM_LAUNCHER_UNIT_RUNTIME_MAX_MS + 60 * 1000;
/** What the bridge must wait at least for the broker's answer before it treats the outcome as unknown. */
export const DM_BROKER_RESPONSE_DEADLINE_MS = DM_LAUNCHER_RESPONSE_TIMEOUT_MS + 60 * 1000;

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/** Why the broker contacted no launcher. Nothing was sent to a vendor. */
export const DM_BROKER_REFUSALS = [
  "request_unreadable",
  "request_malformed",
  "instance_unknown",
  "request_id_invalid",
  "request_key_invalid",
  "payload_invalid",
  /** The instance, or this request id, has a request in flight. Nothing is touched. */
  "busy",
  "transmit_intent_missing",
  "transmit_intent_mismatch",
  /** §5: the request root fails its path check or cannot be listed. */
  "request_root_unusable",
  /** §5: a request directory not in flight is left over in the root. */
  "request_root_leftover",
  "vendor_group_unverifiable",
  "request_directory_unusable",
] as const;
export type DmBrokerRefusal = (typeof DM_BROKER_REFUSALS)[number];

/** The launcher could not be asked; the payload never left the broker. */
export const DM_LAUNCHER_UNREACHABLE_REASONS = ["connect_failed", "ready_missing", "ready_mismatch"] as const;
export type DmLauncherUnreachableReason = (typeof DM_LAUNCHER_UNREACHABLE_REASONS)[number];

/** The payload may have reached the launcher, and no valid answer came back. */
export const DM_LAUNCHER_LOST_REASONS = [
  "request_not_delivered",
  "response_missing",
  "response_timeout",
  "response_malformed",
] as const;
export type DmLauncherLostReason = (typeof DM_LAUNCHER_LOST_REASONS)[number];

/** What a launcher answers instead of launching. It called nothing that starts a process. */
export const DM_LAUNCHER_PROTOCOL_ERRORS = ["request_unreadable", "request_malformed", "instance_mismatch"] as const;
export type DmLauncherProtocolError = (typeof DM_LAUNCHER_PROTOCOL_ERRORS)[number];

/** §10: what the bridge records after the intent. */
export const DM_TRANSMISSIONS = ["not_started", "process_ended", "unknown"] as const;
export type DmTransmission = (typeof DM_TRANSMISSIONS)[number];

export const DM_CLEANUP_SCOPES = ["vendor", "request_directory", "request_root"] as const;
export type DmCleanupScope = (typeof DM_CLEANUP_SCOPES)[number];

/** The residue kinds of a broker answer: the launcher's, and three the broker adds. */
export const DM_BROKER_RESIDUE_KINDS = [
  ...DM_CLEANUP_RESIDUE_KINDS,
  /** The launcher may have run, and its cleanup report never came. */
  "launcher_report_missing",
  "request_root_unusable",
  "request_root_leftover",
] as const;
export type DmBrokerResidueKind = (typeof DM_BROKER_RESIDUE_KINDS)[number];

const includes = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// Strict decoding
// ---------------------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (record: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
};

const parseJson = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

const REQUEST_KEY_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Canonical base64 only: `Buffer.from(…, "base64")` skips what it cannot read, so the text must round-trip. */
export const dmDecodeBase64 = (text: unknown, maxBytes: number): Buffer | null => {
  if (typeof text !== "string" || text.length === 0) return null;
  if (text.length > Math.ceil(maxBytes / 3) * 4 || !BASE64_PATTERN.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== text) return null;
  return bytes;
};

// ---------------------------------------------------------------------------
// `launch`: bridge -> broker, and broker -> launcher
// ---------------------------------------------------------------------------

export type DmLaunchRequest = {
  requestId: string;
  instance: DmInstanceScope;
  /** K_R, from the assignment response. */
  requestKey: Buffer;
  /** The exact stdin bytes whose request-keyed digest the intent recorded. */
  payload: Buffer;
  /** The transmissions route's recorded answer (`DmTransmitIntentEvidence`), checked by its own function. */
  transmitIntent: unknown;
};

const LAUNCH_KEYS = ["v", "type", "requestId", "instance", "requestKey", "payload", "transmitIntent"] as const;

// ---------------------------------------------------------------------------
// `snapshot`: bridge -> broker (stage S2b)
// ---------------------------------------------------------------------------

/**
 * Before the transmission intent, the bridge asks the broker for the
 * repository snapshot of a card's paths (§5: the broker fetches it, holding no
 * credential). The broker answers with the snapshot's payload lines and its
 * target; the bridge appends the lines to the payload, computes the manifest
 * digest itself under its request key, and records the intent for the whole
 * payload -- so the launch that follows is checked against every byte.
 */
const SNAPSHOT_KEYS = ["v", "type", "requestId", "paths"] as const;
export type DmSnapshotRequest = { requestId: string; paths: string[] };

/** A `snapshot` request line, or null for anything else. */
export const dmParseSnapshotRequest = (line: string): DmSnapshotRequest | null => {
  const value = parseJson(line);
  if (!isPlainObject(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) return null;
  if (value.v !== DM_BROKER_PROTOCOL_VERSION || value.type !== "snapshot") return null;
  if (!isDmRequestId(value.requestId) || !Array.isArray(value.paths)) return null;
  if (value.paths.length > DM_SNAPSHOT_PATHS_MAX) return null;
  if (!value.paths.every((path) => typeof path === "string" && path.length <= 512)) return null;
  return { requestId: value.requestId, paths: value.paths as string[] };
};

/** Whether a request line asks for a snapshot rather than a launch. */
export const dmIsSnapshotRequestLine = (line: string): boolean => {
  const value = parseJson(line);
  return isPlainObject(value) && value.type === "snapshot";
};

/** The broker's answer: the lines (base64, empty for none), the target, and what was left out. */
export const dmEncodeSnapshotAnswer = (requestId: string | null, snapshot: DmSnapshot | null) => ({
  v: DM_BROKER_PROTOCOL_VERSION,
  type: "snapshot",
  requestId,
  state: snapshot === null ? "none" : snapshot.state,
  targetSha: snapshot !== null && snapshot.state !== "none" ? snapshot.targetSha : null,
  lines: snapshot === null ? "" : Buffer.from(dmSnapshotPayloadLines(snapshot), "utf8").toString("base64"),
  reason: snapshot === null ? "request_malformed" : snapshot.state === "none" ? snapshot.reason : null,
  excluded: snapshot === null ? {} : snapshot.excluded,
});

export type DmLaunchParse =
  | { ok: true; request: DmLaunchRequest }
  | {
      ok: false;
      refusal: DmBrokerRefusal;
      /** What could be read, so the answer can name the request it refuses. */
      requestId: string | null;
      instance: DmInstanceScope | null;
      requestKey: Buffer | null;
    };

/**
 * One `launch` line, strictly: exactly its seven keys, version 1, the app's
 * request id, a known instance, a 32-byte key as lowercase hex, and a
 * non-empty canonical base64 payload within the cap. The transmission intent
 * is carried as given; the broker and the launcher each check it with
 * `dmTransmitIntentRefusal()`.
 */
export const dmParseLaunchRequest = (line: string): DmLaunchParse => {
  const value = parseJson(line);
  const malformed = (refusal: DmBrokerRefusal, requestId: string | null = null, instance: DmInstanceScope | null = null, requestKey: Buffer | null = null): DmLaunchParse => ({
    ok: false,
    refusal,
    requestId,
    instance,
    requestKey,
  });
  if (!isPlainObject(value) || !hasExactKeys(value, LAUNCH_KEYS)) return malformed("request_malformed");
  if (value.v !== DM_BROKER_PROTOCOL_VERSION || value.type !== "launch") return malformed("request_malformed");
  const requestId = isDmRequestId(value.requestId) ? value.requestId : null;
  const instance = isDmLauncherInstance(value.instance) ? value.instance : null;
  const requestKey =
    typeof value.requestKey === "string" && REQUEST_KEY_PATTERN.test(value.requestKey)
      ? Buffer.from(value.requestKey, "hex")
      : null;
  if (requestId === null) return malformed("request_id_invalid", null, instance, requestKey);
  if (instance === null) return malformed("instance_unknown", requestId, null, requestKey);
  if (requestKey === null) return malformed("request_key_invalid", requestId, instance, null);
  const payload = dmDecodeBase64(value.payload, DM_PAYLOAD_MAX_BYTES);
  if (payload === null) return malformed("payload_invalid", requestId, instance, requestKey);
  return { ok: true, request: { requestId, instance, requestKey, payload, transmitIntent: value.transmitIntent } };
};

export const dmEncodeLaunchRequest = (request: DmLaunchRequest) => ({
  v: DM_BROKER_PROTOCOL_VERSION,
  type: "launch",
  requestId: request.requestId,
  instance: request.instance,
  requestKey: request.requestKey.toString("hex"),
  payload: request.payload.toString("base64"),
  transmitIntent: request.transmitIntent,
});

// ---------------------------------------------------------------------------
// `ready`: launcher -> broker
// ---------------------------------------------------------------------------

export const dmEncodeLauncherReady = (instance: DmInstanceScope) => ({
  v: DM_BROKER_PROTOCOL_VERSION,
  type: "ready",
  instance,
});

/** The launcher that answered is the one this socket is for. */
export const dmLauncherReadyFits = (line: string, instance: DmInstanceScope): boolean => {
  const value = parseJson(line);
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["v", "type", "instance"]) &&
    value.v === DM_BROKER_PROTOCOL_VERSION &&
    value.type === "ready" &&
    value.instance === instance
  );
};

// ---------------------------------------------------------------------------
// `launched` / `rejected`: launcher -> broker
// ---------------------------------------------------------------------------

export type DmWireCleanup = { status: "verified" } | { status: "cleanup_unknown"; residue: string[] };

/** A cleanup as it crosses a socket: the kinds only. Paths can name CLI state, so they stay in the launcher. */
export const dmWireCleanup = (outcome: DmCleanupOutcome): DmWireCleanup =>
  outcome.status === "verified"
    ? { status: "verified" }
    : { status: "cleanup_unknown", residue: [...new Set(outcome.residue.map((entry) => entry.kind))] };

export const dmEncodeLauncherLaunched = (
  request: { requestId: string; instance: DmInstanceScope },
  result: DmLaunchResult,
  cleanup: DmCleanupOutcome,
) => ({
  v: DM_BROKER_PROTOCOL_VERSION,
  type: "launched",
  requestId: request.requestId,
  instance: request.instance,
  result,
  cleanup: dmWireCleanup(cleanup),
});

export const dmEncodeLauncherRejected = (error: DmLauncherProtocolError, cleanup: DmCleanupOutcome) => ({
  v: DM_BROKER_PROTOCOL_VERSION,
  type: "rejected",
  error,
  cleanup: dmWireCleanup(cleanup),
});

const parseWireCleanup = (value: unknown): DmWireCleanup | null => {
  if (!isPlainObject(value)) return null;
  if (value.status === "verified" && hasExactKeys(value, ["status"])) return { status: "verified" };
  if (value.status !== "cleanup_unknown" || !hasExactKeys(value, ["status", "residue"])) return null;
  const { residue } = value;
  if (!Array.isArray(residue) || residue.length === 0 || !residue.every((kind) => includes(DM_CLEANUP_RESIDUE_KINDS, kind))) {
    return null;
  }
  return { status: "cleanup_unknown", residue: [...new Set(residue as string[])] };
};

/** A `DmLaunchResult` as the launcher sent it, held to the launcher's own closed vocabularies and caps. */
const parseLaunchResult = (value: unknown): DmLaunchResult | null => {
  if (!isPlainObject(value)) return null;
  switch (value.outcome) {
    case "refused": {
      const { refusals } = value;
      if (!hasExactKeys(value, ["outcome", "refusals"]) || !Array.isArray(refusals) || refusals.length === 0) return null;
      if (!refusals.every((refusal) => includes(DM_LAUNCH_REFUSALS, refusal))) return null;
      return { outcome: "refused", refusals: [...refusals] };
    }
    case "output":
      if (!hasExactKeys(value, ["outcome", "raw"]) || typeof value.raw !== "string") return null;
      if (Buffer.byteLength(value.raw, "utf8") > DM_LAUNCH_OUTPUT_MAX_BYTES) return null;
      return { outcome: "output", raw: value.raw };
    case "timeout":
      return hasExactKeys(value, ["outcome"]) ? { outcome: "timeout" } : null;
    case "unavailable":
      if (!hasExactKeys(value, ["outcome", "reason"]) || !includes(DM_LAUNCH_UNAVAILABLE_REASONS, value.reason)) return null;
      return { outcome: "unavailable", reason: value.reason };
    default:
      return null;
  }
};

export type DmLauncherAnswer =
  | { type: "launched"; result: DmLaunchResult; cleanup: DmWireCleanup }
  | { type: "rejected"; error: DmLauncherProtocolError; cleanup: DmWireCleanup };

/** The launcher's one answer, for the request the broker sent; null for anything else. */
export const dmParseLauncherAnswer = (
  line: string,
  sent: { requestId: string; instance: DmInstanceScope },
): DmLauncherAnswer | null => {
  const value = parseJson(line);
  if (!isPlainObject(value) || value.v !== DM_BROKER_PROTOCOL_VERSION) return null;
  if (value.type === "rejected") {
    if (!hasExactKeys(value, ["v", "type", "error", "cleanup"]) || !includes(DM_LAUNCHER_PROTOCOL_ERRORS, value.error)) {
      return null;
    }
    const cleanup = parseWireCleanup(value.cleanup);
    return cleanup ? { type: "rejected", error: value.error, cleanup } : null;
  }
  if (value.type !== "launched" || !hasExactKeys(value, ["v", "type", "requestId", "instance", "result", "cleanup"])) {
    return null;
  }
  if (value.requestId !== sent.requestId || value.instance !== sent.instance) return null;
  const result = parseLaunchResult(value.result);
  const cleanup = parseWireCleanup(value.cleanup);
  return result && cleanup ? { type: "launched", result, cleanup } : null;
};

/**
 * The launcher's reading of the broker's `launch` line: the same strict
 * parse, and the instance must be the launcher unit's own -- a launcher never
 * runs another vendor's request.
 */
export const dmLauncherRequestError = (
  parsed: DmLaunchParse,
  ownInstance: DmInstanceScope,
): DmLauncherProtocolError | null => {
  if (!parsed.ok) {
    return parsed.refusal === "instance_unknown" ? "instance_mismatch" : "request_malformed";
  }
  return parsed.request.instance === ownInstance ? null : "instance_mismatch";
};

// ---------------------------------------------------------------------------
// `result`: broker -> bridge
// ---------------------------------------------------------------------------

/** What happened to the request, as the broker knows it. */
export type DmBrokerLaunchView =
  /** The broker contacted no launcher. */
  | { kind: "broker_refused"; refusals: DmBrokerRefusal[] }
  /** The launcher was not asked: nothing reached it. */
  | { kind: "launcher_unreachable"; reason: DmLauncherUnreachableReason }
  /** The launcher answered `rejected`: it read the request and started nothing. */
  | { kind: "launcher_rejected"; error: DmLauncherProtocolError; cleanup: DmWireCleanup }
  /** The launcher ran `launchDecisionMaker()` and answered. */
  | { kind: "launched"; result: DmLaunchResult; cleanup: DmWireCleanup }
  /** The request may have reached the launcher, and no valid answer came back. */
  | { kind: "launcher_lost"; reason: DmLauncherLostReason }
  /** A fault inside the broker; `contacted` is whether the request line had been written. */
  | { kind: "broker_fault"; contacted: boolean };

export type DmBrokerResult = { kind: "output"; raw: string } | { kind: "timeout" } | { kind: "unavailable" };

export type DmBrokerResidue = { scope: DmCleanupScope; kind: DmBrokerResidueKind };

export type DmBrokerAnswer = {
  v: 1;
  type: "result";
  requestId: string | null;
  instance: DmInstanceScope | null;
  transmission: DmTransmission;
  result: DmBrokerResult;
  /** §9: `dmResultDigest(K_R, result)`, for the bridge's lookup after a lost route answer. Null without a key. */
  resultDigest: string | null;
  launch: { outcome: string; reasons: string[] };
  cleanup: { status: "verified" } | { status: "cleanup_unknown"; residue: DmBrokerResidue[] };
};

/**
 * §10: a DM process was started only when the launcher says one ran. A
 * refusal, and a spawn that failed, started none; a launcher fault, a lost
 * answer and a broker fault after the request line went out cannot say.
 */
export const dmTransmissionOf = (view: DmBrokerLaunchView): DmTransmission => {
  switch (view.kind) {
    case "broker_refused":
    case "launcher_unreachable":
    case "launcher_rejected":
      return "not_started";
    case "launcher_lost":
      return "unknown";
    case "broker_fault":
      return view.contacted ? "unknown" : "not_started";
    case "launched":
      switch (view.result.outcome) {
        case "refused":
          return "not_started";
        case "output":
        case "timeout":
          return "process_ended";
        case "unavailable":
          if (view.result.reason === "spawn_failed") return "not_started";
          if (view.result.reason === "launcher_fault") return "unknown";
          return "process_ended";
      }
  }
};

/** §6/§9: an output is the app's to classify; a timeout is a timeout; anything else is "DM 불가". */
export const dmBrokerResultOf = (view: DmBrokerLaunchView): DmBrokerResult => {
  if (view.kind !== "launched") return { kind: "unavailable" };
  if (view.result.outcome === "output") return { kind: "output", raw: view.result.raw };
  if (view.result.outcome === "timeout") return { kind: "timeout" };
  return { kind: "unavailable" };
};

const launchSummary = (view: DmBrokerLaunchView): { outcome: string; reasons: string[] } => {
  switch (view.kind) {
    case "broker_refused":
      return { outcome: "broker_refused", reasons: [...view.refusals] };
    case "launcher_unreachable":
      return { outcome: "launcher_unreachable", reasons: [view.reason] };
    case "launcher_rejected":
      return { outcome: "launcher_rejected", reasons: [view.error] };
    case "launcher_lost":
      return { outcome: "launcher_lost", reasons: [view.reason] };
    case "broker_fault":
      return { outcome: "broker_fault", reasons: [] };
    case "launched":
      if (view.result.outcome === "refused") return { outcome: "refused", reasons: [...view.result.refusals] };
      if (view.result.outcome === "unavailable") return { outcome: "unavailable", reasons: [view.result.reason] };
      return { outcome: view.result.outcome, reasons: [] };
  }
};

const vendorResidue = (view: DmBrokerLaunchView): DmBrokerResidue[] => {
  if (view.kind === "launched" || view.kind === "launcher_rejected") {
    return view.cleanup.status === "verified"
      ? []
      : view.cleanup.residue.map((kind) => ({ scope: "vendor", kind: kind as DmBrokerResidueKind }));
  }
  // The launcher may have run and cleaned or not; only its own report could say.
  if (view.kind === "launcher_lost" || (view.kind === "broker_fault" && view.contacted)) {
    return [{ scope: "vendor", kind: "launcher_report_missing" }];
  }
  return [];
};

/**
 * The broker's one answer. `requestDirectory` is the broker's own cleanup of
 * this request's directory (null when nothing was made for it);
 * `requestRoot` is residue the broker found in the root before the request.
 * Anything in either, or in the vendor's cleanup, is `cleanup_unknown`.
 */
export const dmBrokerAnswer = (input: {
  requestId: string | null;
  instance: DmInstanceScope | null;
  requestKey: Buffer | null;
  view: DmBrokerLaunchView;
  requestDirectory: DmCleanupOutcome | null;
  requestRoot: Array<"request_root_unusable" | "request_root_leftover">;
}): DmBrokerAnswer => {
  const result = dmBrokerResultOf(input.view);
  const residue: DmBrokerResidue[] = [
    ...vendorResidue(input.view),
    ...(input.requestDirectory?.status === "cleanup_unknown"
      ? input.requestDirectory.residue.map((entry) => ({ scope: "request_directory" as const, kind: entry.kind }))
      : []),
    ...input.requestRoot.map((kind) => ({ scope: "request_root" as const, kind })),
  ];
  const unique = [...new Map(residue.map((entry) => [`${entry.scope}\0${entry.kind}`, entry])).values()];
  return {
    v: DM_BROKER_PROTOCOL_VERSION,
    type: "result",
    requestId: input.requestId,
    instance: input.instance,
    transmission: dmTransmissionOf(input.view),
    result,
    resultDigest: input.requestKey ? dmResultDigest(input.requestKey, result) : null,
    launch: launchSummary(input.view),
    cleanup: unique.length === 0 ? { status: "verified" } : { status: "cleanup_unknown", residue: unique },
  };
};
