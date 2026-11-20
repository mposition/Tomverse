import "server-only";

import { prisma } from "@/lib/prisma";

import { readNewestDecisionMakerRequestCreatedAfter } from "@/lib/amux/decisionMakerRequestStore";
import {
  AMUX_DM_RELAY_LAST_SYNC_KEY,
  AMUX_DM_RELAY_QUESTION_MS,
  parseAmuxDmRelayLastSync,
} from "@/lib/amux/dmRelayHeartbeatCore";

/**
 * The heartbeat's bounds. It runs first inside the sync route's budget
 * (`AMUX_ROUTE_BUDGET_MS`, 15 s), so it may cost that route at most about two
 * seconds: half a second to get a connection, one second for the statement and
 * half of it for a row lock, and the whole transaction is abandoned at 1.5 s.
 */
export const AMUX_DM_RELAY_HEARTBEAT_MAX_WAIT_MS = 500;
export const AMUX_DM_RELAY_HEARTBEAT_TIMEOUT_MS = 1_500;
const STATEMENT_TIMEOUT_MS = "1000";
const LOCK_TIMEOUT_MS = "500";

/**
 * The one writer of the relay's last call (lib/amux/dmRelayHeartbeatCore.ts).
 * Called by the v22 question sync route right after the sync token is checked,
 * before the routing switch, so a relay that is calling is seen as calling
 * whatever the switch says. One AppSetting row, no migration: a heartbeat, not
 * a history and not an audit event.
 *
 * Never throws and never waits past its bounds: a heartbeat that could not be
 * written must not hold up the relay's tick. A write that keeps failing shows
 * up as a silent relay, which is the safe direction.
 */
export async function recordAmuxDmRelaySync(now = new Date()): Promise<void> {
  const value = now.toISOString();
  await prisma
    .$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT_MS}, true), set_config('lock_timeout', ${LOCK_TIMEOUT_MS}, true)`;
        await tx.appSetting.upsert({
          where: { key: AMUX_DM_RELAY_LAST_SYNC_KEY },
          create: { key: AMUX_DM_RELAY_LAST_SYNC_KEY, value },
          update: { value },
        });
      },
      {
        maxWait: AMUX_DM_RELAY_HEARTBEAT_MAX_WAIT_MS,
        timeout: AMUX_DM_RELAY_HEARTBEAT_TIMEOUT_MS,
      }
    )
    .catch(() => {
      console.warn(JSON.stringify({ subsystem: "amux", event: "dm_relay_heartbeat_write_failed" }));
    });
}

/**
 * When the relay last called, or null when no call was ever recorded. A read
 * that fails throws: the monitor turns that into its own alert rather than
 * mistaking it for a silent relay, and a screen can show "unknown".
 */
export async function readAmuxDmRelayLastSyncAt(): Promise<Date | null> {
  const row = await prisma.appSetting.findUnique({
    where: { key: AMUX_DM_RELAY_LAST_SYNC_KEY },
    select: { value: true },
  });
  return parseAmuxDmRelayLastSync(row?.value);
}

/**
 * When the newest Decision Maker request the relay could still be waiting on
 * was created, or null when none is that recent. Throws like the read above.
 */
export async function readAmuxDmRelayLastQuestionAt(now = new Date()): Promise<Date | null> {
  return readNewestDecisionMakerRequestCreatedAfter(prisma, now.getTime() - AMUX_DM_RELAY_QUESTION_MS);
}
