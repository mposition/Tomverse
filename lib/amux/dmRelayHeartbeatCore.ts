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
 * One tick can be long: a question the relay routed is handed to the broker,
 * and the relay waits for its answer (up to `DM_BROKER_RESPONSE_DEADLINE`, 34
 * minutes, after an assignment window of 2 minutes) before the next sync. So a
 * relay that routed a question recently is asking, not silent.
 *
 * Pure: the monitor (lib/infrastructureThresholdMonitor.ts) and any screen that
 * shows the relay's state use the same rule.
 */

import { resolveDeploymentEnvironment } from "../deploymentEnvironment.ts";

/** The AppSetting row the sync route writes on every authorised call. */
export const AMUX_DM_RELAY_LAST_SYNC_KEY = "amuxDmRelayLastSyncAt";

/**
 * Ten idle ticks. Long enough that a slow app answer or one restart (the unit's
 * RestartSec is 60 seconds) is not an alert, short enough to page well inside
 * the hour.
 */
export const AMUX_DM_RELAY_SILENT_MS = 5 * 60_000;

/**
 * How long after a Decision Maker request was created the relay may still be
 * inside that question's tick: the 2-minute assignment window, the broker's
 * 34-minute response deadline, and 4 minutes for the result's writes.
 */
export const AMUX_DM_RELAY_QUESTION_MS = 40 * 60_000;

/** How often a relay that stays silent pages again. */
export const AMUX_DM_RELAY_REMINDER_MS = 3 * 60 * 60_000;

/**
 * The Ubuntu relay serves production, and is only expected to call while
 * that deployment's routes are open
 * (`TOMVERSE_AMUX_DM_ROUTING=enabled`, lib/amux/decisionMakerInternalRoute.ts
 * `AMUX_DM_ROUTING_ENV`). Read here by name, not imported, so the monitor does
 * not load the Decision Maker route module.
 */
export const amuxDmRelayExpected = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.TOMVERSE_AMUX_DM_ROUTING === "enabled" &&
  resolveDeploymentEnvironment(env) === "production";

/** A stored value, or null when it is missing or not a time. */
export const parseAmuxDmRelayLastSync = (value: string | null | undefined): Date | null => {
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
};

export type AmuxDmRelayLiveness =
  | { state: "calling"; lastSyncAt: Date }
  | { state: "asking"; lastSyncAt: Date | null; lastQuestionAt: Date }
  | { state: "silent"; lastSyncAt: Date | null; minutesSilent: number | null };

/**
 * Calling when the last sync is at most `AMUX_DM_RELAY_SILENT_MS` old (a record
 * from the future, a clock step, counts: it is a call, just mis-dated). Asking
 * when it is older but the newest Decision Maker request is at most
 * `AMUX_DM_RELAY_QUESTION_MS` old: the relay may be waiting for that answer.
 * Silent otherwise, including when no call was ever recorded.
 */
export const judgeAmuxDmRelayLiveness = (
  lastSyncAt: Date | null,
  lastQuestionAt: Date | null,
  now: Date
): AmuxDmRelayLiveness => {
  if (lastSyncAt && now.getTime() - lastSyncAt.getTime() <= AMUX_DM_RELAY_SILENT_MS) {
    return { state: "calling", lastSyncAt };
  }
  if (lastQuestionAt && now.getTime() - lastQuestionAt.getTime() <= AMUX_DM_RELAY_QUESTION_MS) {
    return { state: "asking", lastSyncAt, lastQuestionAt };
  }
  if (!lastSyncAt) return { state: "silent", lastSyncAt: null, minutesSilent: null };
  return {
    state: "silent",
    lastSyncAt,
    minutesSilent: Math.floor((now.getTime() - lastSyncAt.getTime()) / 60_000),
  };
};
