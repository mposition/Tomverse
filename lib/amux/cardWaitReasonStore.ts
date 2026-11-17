import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

import {
  type AmuxCardWaitDetail,
  type AmuxCardWaitStage,
  amuxCardWaitCodeValid,
  amuxCardWaitDetail,
  amuxCardWaitIncident,
} from "./cardWaitReasonCore.ts";

/**
 * Stores why a card was passed over (lib/amux/cardWaitReasonCore.ts, owner
 * decision 2026-11-15). Diagnostic data only: nothing here decides a claim, a
 * promotion or a cost, and a failed write never changes what the tick did.
 * The incident is the existing operator alert path, best effort.
 */

export type AmuxCardWaitEntry = { taskId: string; stage: AmuxCardWaitStage; code: string;
  detail: AmuxCardWaitDetail };

/** How long the same reason may go unwritten; well inside the stale bound. */
const AMUX_CARD_WAIT_REFRESH_MS = 5 * 60_000;

const logFailure = (event: string, error: unknown) => console.warn(JSON.stringify({
  subsystem: "amux", event,
  message: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));

/**
 * Upserts one row per entry. The same stage and code keep their first-seen
 * time and count up; a different reason starts again.
 */
export async function recordAmuxCardWaitReasons(entries: readonly AmuxCardWaitEntry[],
  now = new Date(), db: typeof prisma = prisma) {
  const valid = entries.filter((entry) => amuxCardWaitCodeValid(entry.code));
  if (valid.length === 0) return;
  try {
    const existing = await db.amuxCardWaitReason.findMany({
      where: { taskId: { in: valid.map((entry) => entry.taskId) } },
      select: { taskId: true, stage: true, code: true, detail: true, lastSeenAt: true } });
    const prior = new Map(existing.map((row) => [row.taskId, row]));
    for (const entry of valid) {
      const detail = amuxCardWaitDetail(entry.detail) as Prisma.InputJsonObject;
      const same = prior.get(entry.taskId);
      const continued = same?.stage === entry.stage && same.code === entry.code;
      // The same reason seen again within a few minutes is not written
      // again: a tick runs every round and most cards wait the same way.
      if (continued && now.getTime() - same.lastSeenAt.getTime() < AMUX_CARD_WAIT_REFRESH_MS &&
          JSON.stringify(amuxCardWaitDetail(same.detail)) === JSON.stringify(detail)) continue;
      try {
        await db.amuxCardWaitReason.upsert({ where: { taskId: entry.taskId },
          create: { taskId: entry.taskId, stage: entry.stage, code: entry.code, detail,
            firstSeenAt: now, lastSeenAt: now, seenCount: 1 },
          update: continued ?
            { detail, lastSeenAt: now, seenCount: { increment: 1 } } :
            { stage: entry.stage, code: entry.code, detail, firstSeenAt: now,
              lastSeenAt: now, seenCount: 1, reportedAt: null } });
      } catch (error) {
        // A card removed meanwhile, or a concurrent pass's create: the next
        // pass writes it again.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
      }
    }
  } catch (error) { logFailure("amux_card_wait_record_failed", error); }
}

/** A claimed card no longer waits. */
export async function clearAmuxCardWaitReasons(taskIds: readonly string[],
  db: typeof prisma = prisma) {
  if (taskIds.length === 0) return;
  try { await db.amuxCardWaitReason.deleteMany({ where: { taskId: { in: [...taskIds] } } }); }
  catch (error) { logFailure("amux_card_wait_clear_failed", error); }
}

/** The stored reasons of these cards, by card. */
export async function readAmuxCardWaitReasons(taskIds: readonly string[],
  db: typeof prisma = prisma) {
  type Row = { taskId: string; stage: string; code: string;
    detail: ReturnType<typeof amuxCardWaitDetail>; firstSeenAt: Date; lastSeenAt: Date;
    seenCount: number };
  if (taskIds.length === 0) return new Map<string, Row>();
  const rows = await db.amuxCardWaitReason.findMany({
    where: { taskId: { in: [...taskIds] } },
    select: { taskId: true, stage: true, code: true, detail: true, firstSeenAt: true,
      lastSeenAt: true, seenCount: true } });
  return new Map<string, Row>(rows.map((row) => [row.taskId, { ...row,
    detail: amuxCardWaitDetail(row.detail) }]));
}

/**
 * Raises claim waits that have lasted an hour, once per wait, and drops rows
 * no pass has refreshed for a day. Best effort.
 */
export async function reportLongAmuxCardWaits(now = new Date(), db: typeof prisma = prisma) {
  try {
    await db.amuxCardWaitReason.deleteMany({ where: {
      lastSeenAt: { lt: new Date(now.getTime() - 24 * 60 * 60_000) } } });
    const rows = await db.amuxCardWaitReason.findMany({
      where: { stage: "claim", reportedAt: null,
        lastSeenAt: { gte: new Date(now.getTime() - 30 * 60_000) },
        task: { status: "todo", archivedAt: null, owner: null } },
      select: { taskId: true, stage: true, code: true, detail: true, firstSeenAt: true,
        reportedAt: true, task: { select: { displayKey: true } } },
      take: 100 });
    const incident = amuxCardWaitIncident(rows.map((row) => ({ taskId: row.taskId,
      displayKey: row.task.displayKey, stage: row.stage, code: row.code,
      detail: amuxCardWaitDetail(row.detail), firstSeenAtMs: row.firstSeenAt.getTime(),
      reportedAtMs: row.reportedAt?.getTime() ?? null })), now.getTime());
    if (!incident) return;
    await reportOperationalIncident({
      code: "AMUX_CARD_WAITING",
      title: "AMUX cards have waited over an hour for the same reason",
      error: new Error(`${incident.count} card(s): ${incident.tasks}`),
      severity: "warning",
      cooldownMs: 60 * 60_000,
      context: { component: "amux-v22-claim", count: incident.count,
        codes: Object.entries(incident.codes).map(([code, n]) => `${code}=${n}`).join(","),
        tasks: incident.tasks, admin: "/admin/amux-execution?tab=cards" },
    });
    await db.amuxCardWaitReason.updateMany({ where: { taskId: { in: incident.taskIds },
      reportedAt: null }, data: { reportedAt: now } });
  } catch (error) { logFailure("amux_card_wait_report_failed", error); }
}
