import "server-only";

import { prisma } from "@/lib/prisma";
import { AMUX_DM_RELAY_RECORD_EVERY_MS, AMUX_DM_RELAY_SEEN_SETTING_KEY } from "./ownerQueueDmRequestCore.ts";

/**
 * When the server last heard from the host's DM relay: one `AppSetting` row
 * whose `updatedAt` is the database clock of the last recorded sync call.
 * The relay calls every 30 s; the row moves at most once a minute, so the
 * record costs one statement a call and one row write a minute. Nothing reads
 * it to decide anything: the owner queue shows it (ownerQueueDmCore.ts).
 */
const RECORD_EVERY = `${AMUX_DM_RELAY_RECORD_EVERY_MS / 1_000} seconds`;

/** One statement; a failure is swallowed so the relay's tick never fails on it. */
export async function recordAmuxDmRelaySeen(): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value", "createdAt", "updatedAt")
    VALUES (${AMUX_DM_RELAY_SEEN_SETTING_KEY}, 'v22-question-sync',
      (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))
    ON CONFLICT ("key") DO UPDATE SET "updatedAt" = EXCLUDED."updatedAt"
    WHERE "AppSetting"."updatedAt" < EXCLUDED."updatedAt" - ${RECORD_EVERY}::interval`
    .then(() => undefined, () => {
      console.warn(JSON.stringify({ subsystem: "amux", event: "dm_relay_seen_record_failed" }));
    });
}

/** The last recorded call, or null when none was ever recorded. Throws when the read fails. */
export async function readAmuxDmRelaySeenAt(): Promise<Date | null> {
  const row = await prisma.appSetting.findUnique({
    where: { key: AMUX_DM_RELAY_SEEN_SETTING_KEY }, select: { updatedAt: true } });
  return row?.updatedAt ?? null;
}
