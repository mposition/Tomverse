/**
 * What a worker's dispatch health is, as the Admin worker list reads it
 * (owner decision 2026-11-15): "can take work" must mean the claim would
 * actually assign it work.
 *
 * Production 2026-11-15: the box's Claude login expired, the bridge logged
 * `quota source unavailable for claude-*` every five minutes, the claim
 * silently left out every Anthropic route, and Admin still showed those
 * workers as able to take work. The sign-in stage failed every hour and the
 * login keepalive warned a day ahead, both only in the box journal.
 *
 * Three facts, each already the claim's own rule:
 * - the worker quarantine (lib/amux/workerCircuitCore.ts);
 * - the usage reading: an Anthropic route needs one no older than an hour
 *   (lib/amux/planningCore.ts evaluateAmuxQuotaTelemetry); another
 *   provider's fresh exhausted reading holds it too;
 * - the box health signals the bridge forwards (login keepalive, sign-in
 *   stage, sidecar), the newest per source.
 *
 * Pure and dependency-free.
 */

export const AMUX_WORKER_HEALTH_SOURCES = ["login_keepalive", "auth_stage", "sidecar"] as const;
export type AmuxWorkerHealthSource = (typeof AMUX_WORKER_HEALTH_SOURCES)[number];

/** A usage reading older than this is not fresh (the claim's own bound,
 * AMUX_QUOTA_FRESH_SECONDS in lib/amux/planningCore.ts). */
export const AMUX_WORKER_USAGE_FRESH_MS = 60 * 60_000;
/** A health signal not repeated for this long no longer describes the worker. */
export const AMUX_WORKER_HEALTH_SIGNAL_STALE_MS = 3 * 60 * 60_000;

/** Signals that mean the worker cannot run until a person signs it in again. */
const LOGIN_REQUIRED = new Set(["login_required", "refresh_failed", "auth_stage_failed",
  "login_missing", "login_unreadable"]);
/** Signals that warn ahead of time. */
const WARNING = new Set(["relogin_soon"]);

export const amuxWorkerHealthSignalBlocks = (signal: string) => LOGIN_REQUIRED.has(signal);
export const amuxWorkerHealthSignalWarns = (signal: string) => WARNING.has(signal);
/** Signals raised as an operational incident when they arrive. */
export const amuxWorkerHealthSignalRaised = (signal: string) =>
  LOGIN_REQUIRED.has(signal) || WARNING.has(signal);

export type AmuxWorkerHealthSignalView = {
  source: string;
  signal: string;
  observedAt: string;
  firstSeenAt: string;
  /** Non-secret facts: a refresh token's expiry at most. */
  expiresAt: string | null;
};

export type AmuxWorkerHealthView = {
  workerName: string;
  circuit: { state: "closed" | "open" | "probing"; consecutive: number;
    lastKind: string | null; lastAt: string | null; retryAt: string | null };
  usage: { state: "fresh" | "stale" | "missing"; observedAt: string | null;
    exhausted: boolean };
  signals: AmuxWorkerHealthSignalView[];
};

/**
 * Why the claim would not assign this worker work now; null when it would.
 * Only the claim's own rules hold a worker here. A box sign-in signal is a
 * warning (`amuxWorkerHealthNotice`): the worker's copy may still be valid
 * for hours after the source login is gone, and the claim keeps assigning it
 * until its runs fail or its usage can no longer be read.
 */
export type AmuxWorkerHealthHold =
  | "infra_quarantined"
  | "usage_unobserved"
  | "usage_exhausted";

export function amuxWorkerHealthHold(view: AmuxWorkerHealthView | null | undefined,
  input: { provider: string }): AmuxWorkerHealthHold | null {
  if (!view) return null;
  if (view.circuit.state === "open") return "infra_quarantined";
  const anthropic = input.provider.trim().toLowerCase() === "anthropic" ||
    input.provider.trim().toLowerCase() === "claude";
  if (anthropic && view.usage.state !== "fresh") return "usage_unobserved";
  if (view.usage.state === "fresh" && view.usage.exhausted) return "usage_exhausted";
  return null;
}

/** A warning shown beside a worker, whatever its status. */
export type AmuxWorkerHealthNotice = "login_attention" | "relogin_soon" | "probing";

export function amuxWorkerHealthNotice(view: AmuxWorkerHealthView | null | undefined):
  AmuxWorkerHealthNotice | null {
  if (!view) return null;
  if (view.signals.some((signal) => amuxWorkerHealthSignalBlocks(signal.signal))) return "login_attention";
  if (view.signals.some((signal) => amuxWorkerHealthSignalWarns(signal.signal))) return "relogin_soon";
  if (view.circuit.state === "probing") return "probing";
  return null;
}

/** The usage state of a worker's newest reading. */
export function amuxWorkerUsageState(observedAtMs: number | null, nowMs: number):
  "fresh" | "stale" | "missing" {
  if (observedAtMs === null) return "missing";
  return nowMs - observedAtMs <= AMUX_WORKER_USAGE_FRESH_MS ? "fresh" : "stale";
}
