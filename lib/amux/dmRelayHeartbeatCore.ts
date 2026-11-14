/**
 * When the AMUX Decision Maker relay last called the app, and when that is too
 * long ago (docs/ops/amux/bridge-monitoring.md §6).
 *
 * The relay (`tomverse-amux-dm-relay.service` on the Ubuntu host) calls
 * `POST /api/internal/amux/decision-maker/v22-questions/sync` on every tick it
 * is not halted, and waits 30 seconds between idle ticks
 * (apps/tomverse-orchestrator/src/dm_relay/io.rs, `DM_RELAY_IDLE`). A halted
 * relay stays `active` under systemd but stops calling, so the app's own record
 * of the last call is the one signal that catches both a dead process and a
 * halted one. On 2026-11-09 the calls stopped at 10:30 AEST and nothing said so
 * for five days.
 *
 * Pure: the monitor (lib/infrastructureThresholdMonitor.ts) and any screen that
 * shows the relay's state use the same rule.
 */

/** The AppSetting row the sync route writes on every authorised call. */
export const AMUX_DM_RELAY_LAST_SYNC_KEY = "amuxDmRelayLastSyncAt";

/**
 * Ten idle ticks. Long enough that a slow app answer or one restart (the unit's
 * RestartSec is 60 seconds) is not an alert, short enough to page well inside
 * the hour.
 */
export const AMUX_DM_RELAY_SILENT_MS = 5 * 60_000;

/** How often a relay that stays silent pages again. */
export const AMUX_DM_RELAY_REMINDER_MS = 3 * 60 * 60_000;

/**
 * The relay is only expected to call while the app's routes are open
 * (`TOMVERSE_AMUX_DM_ROUTING=enabled`, lib/amux/decisionMakerInternalRoute.ts
 * `AMUX_DM_ROUTING_ENV`). Read here by name, not imported, so the monitor does
 * not load the Decision Maker route module.
 */
export const amuxDmRelayExpected = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.TOMVERSE_AMUX_DM_ROUTING === "enabled";

/** A stored value, or null when it is missing or not a time. */
export const parseAmuxDmRelayLastSync = (value: string | null | undefined): Date | null => {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
};

export type AmuxDmRelayLiveness =
  | { state: "calling"; lastSyncAt: Date }
  | { state: "silent"; lastSyncAt: Date | null; minutesSilent: number | null };

/**
 * Silent when no call was ever recorded or the last one is older than
 * `AMUX_DM_RELAY_SILENT_MS`. A record from the future (a clock step) counts as
 * calling: it is a call, just mis-dated.
 */
export const judgeAmuxDmRelayLiveness = (
  lastSyncAt: Date | null,
  now: Date
): AmuxDmRelayLiveness => {
  if (!lastSyncAt) return { state: "silent", lastSyncAt: null, minutesSilent: null };
  const age = now.getTime() - lastSyncAt.getTime();
  if (age <= AMUX_DM_RELAY_SILENT_MS) return { state: "calling", lastSyncAt };
  return { state: "silent", lastSyncAt, minutesSilent: Math.floor(age / 60_000) };
};
