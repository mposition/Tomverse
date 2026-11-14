import "server-only";

import { prisma } from "@/lib/prisma";

import {
  AMUX_DM_RELAY_LAST_SYNC_KEY,
  parseAmuxDmRelayLastSync,
} from "@/lib/amux/dmRelayHeartbeatCore";

/**
 * The one writer of the relay's last call (lib/amux/dmRelayHeartbeatCore.ts).
 * Called by the v22 question sync route right after the sync token is checked,
 * before the routing switch, so a relay that is calling is seen as calling
 * whatever the switch says. One AppSetting row, no migration: a heartbeat, not
 * a history and not an audit event.
 *
 * Never throws: a heartbeat that could not be written must not fail the relay's
 * tick. A write that keeps failing shows up as a silent relay, which is the
 * safe direction.
 */
export async function recordAmuxDmRelaySync(now = new Date()): Promise<void> {
  const value = now.toISOString();
  await prisma.appSetting
    .upsert({
      where: { key: AMUX_DM_RELAY_LAST_SYNC_KEY },
      create: { key: AMUX_DM_RELAY_LAST_SYNC_KEY, value },
      update: { value },
    })
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
