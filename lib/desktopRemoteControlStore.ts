import "server-only";

import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import {
  DESKTOP_REMOTE_COMMAND_RETENTION_MS,
  DESKTOP_REMOTE_COMMAND_TTL_MS,
  DESKTOP_REMOTE_LIMITS,
  DESKTOP_REMOTE_SNAPSHOT_TTL_MS,
  checkDesktopRemoteCommand,
  desktopRemoteCommand,
  desktopRemoteSnapshot,
  type DesktopRemoteCommand,
  type DesktopRemoteCommandRefusal,
  type DesktopRemoteCommandRequest,
  type DesktopRemoteCommandView,
  type DesktopRemoteDeviceView,
  type DesktopRemoteSyncRequest,
} from "@/lib/desktopRemoteControlContract";
import { prisma } from "@/lib/prisma";

/**
 * The server half of Desktop remote control (docs/ops/desktop-remote-control.md). It relays and records; it decides
 * nothing on the PC. A PC writes only its own row, through its own Desktop bearer. A web session reads and writes only
 * the PCs of its own account, and only while the PC's token family is live.
 *
 * Raw SQL on purpose: handing an answer to the PC is one conditional UPDATE ... RETURNING, so it is handed over at most
 * once under any race, and every expiry is compared with the database clock (the columns are TIMESTAMPTZ; the
 * `MobileTokenFamily` expiry is a naive UTC timestamp and is compared with `now() AT TIME ZONE 'UTC'`).
 */

type DesktopIdentity = { userId: string; deviceId: string; familyId: string };

export class DesktopRemoteRefused extends Error {
  constructor(readonly code: DesktopRemoteCommandRefusal) {
    super("The remote control request was refused.");
  }
}

type DeliveredRow = {
  id: string; kind: string; taskKey: string; approvalId: string | null; approvalDigest: string | null;
  decision: string | null; text: string | null; ageMs: number; createdMs: number;
};

/**
 * The PC's sync: replaces its report, records what it did with the answers it last received, and hands it the
 * answers that are waiting, each once. Returns null when the account is not active.
 */
export async function syncDesktopRemote(identity: DesktopIdentity, body: DesktopRemoteSyncRequest) {
  const snapshot = JSON.stringify(body.snapshot);
  return prisma.$transaction(async (tx) => {
    const active = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "User" WHERE "id" = ${identity.userId} AND "accountStatus" = 'active'
    `;
    if (!active.length) return null;
    const written = await tx.$executeRaw`
      INSERT INTO "DesktopRemoteDevice" ("deviceId", "userId", "familyId", "snapshot", "revision", "createdAt", "updatedAt", "expiresAt")
      VALUES (${identity.deviceId}, ${identity.userId}, ${identity.familyId}, ${snapshot}::jsonb, 1, now(), now(),
        now() + (${DESKTOP_REMOTE_SNAPSHOT_TTL_MS}::integer * interval '1 millisecond'))
      ON CONFLICT ("deviceId") DO UPDATE SET
        "familyId" = EXCLUDED."familyId", "snapshot" = EXCLUDED."snapshot", "revision" = "DesktopRemoteDevice"."revision" + 1,
        "updatedAt" = now(), "expiresAt" = EXCLUDED."expiresAt"
      WHERE "DesktopRemoteDevice"."userId" = ${identity.userId}
    `;
    if (written !== 1) return null;
    for (const ack of body.acks) {
      await tx.$executeRaw`
        UPDATE "DesktopRemoteCommand" SET "result" = ${ack.result}, "resultReason" = ${ack.result === "refused" ? ack.reason ?? null : null},
          "resultAt" = now()
        WHERE "id" = ${ack.id} AND "deviceId" = ${identity.deviceId} AND "deliveredAt" IS NOT NULL AND "result" IS NULL
      `;
    }
    const rows = await tx.$queryRaw<DeliveredRow[]>`
      UPDATE "DesktopRemoteCommand" AS c SET "deliveredAt" = now()
      WHERE c."id" IN (
        SELECT "id" FROM "DesktopRemoteCommand"
        WHERE "deviceId" = ${identity.deviceId} AND "userId" = ${identity.userId} AND "deliveredAt" IS NULL AND "expiresAt" > now()
        ORDER BY "createdAt" LIMIT ${DESKTOP_REMOTE_LIMITS.commandsPerSync}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING c."id", c."kind", c."taskKey", c."approvalId", c."approvalDigest", c."decision", c."text",
        (EXTRACT(EPOCH FROM (now() - c."createdAt")) * 1000)::float8 AS "ageMs",
        (EXTRACT(EPOCH FROM c."createdAt") * 1000)::float8 AS "createdMs"
    `;
    await tx.$executeRaw`
      DELETE FROM "DesktopRemoteCommand"
      WHERE "deviceId" = ${identity.deviceId} AND "createdAt" < now() - (${DESKTOP_REMOTE_COMMAND_RETENTION_MS}::integer * interval '1 millisecond')
    `;
    const commands: DesktopRemoteCommand[] = [];
    for (const row of [...rows].sort((a, b) => a.createdMs - b.createdMs)) {
      const command = desktopRemoteCommand.safeParse({
        id: row.id, kind: row.kind, deviceId: identity.deviceId, taskKey: row.taskKey, ageMs: Math.max(0, Math.round(row.ageMs)),
        ...(row.kind === "approval" ? { approvalId: row.approvalId, digest: row.approvalDigest, decision: row.decision } : {}),
        ...(row.kind === "follow_up" ? { text: row.text } : {}),
      });
      if (command.success) commands.push(command.data);
    }
    return { deviceId: identity.deviceId, commands };
  });
}

/** The PC turned remote control off (or is signing out): its report and every answer waiting for it go now. */
export async function withdrawDesktopRemote(identity: Pick<DesktopIdentity, "userId" | "deviceId">) {
  return prisma.$executeRaw`
    DELETE FROM "DesktopRemoteDevice" WHERE "deviceId" = ${identity.deviceId} AND "userId" = ${identity.userId}
  `;
}

type DeviceRow = { deviceId: string; label: string; snapshot: unknown; updatedMs: number };
type CommandRow = {
  id: string; deviceId: string; kind: string; taskKey: string; approvalId: string | null; decision: string | null;
  delivered: boolean; expired: boolean; result: string | null; resultReason: string | null; createdMs: number;
};

const commandState = (row: CommandRow): DesktopRemoteCommandView["state"] =>
  row.result === "applied" ? "applied" : row.result === "refused" ? "refused" : row.delivered ? "delivered" : row.expired ? "expired" : "waiting";

/**
 * The account's PCs that report now, for the web screen. A report past its expiry, or of a device or token family that
 * is revoked or no longer the account's, is deleted here rather than shown.
 */
export async function listDesktopRemoteDevices(userId: string): Promise<DesktopRemoteDeviceView[]> {
  await prisma.$executeRaw`
    DELETE FROM "DesktopRemoteDevice" AS r
    WHERE r."userId" = ${userId} AND (r."expiresAt" <= now() OR NOT EXISTS (
      SELECT 1 FROM "MobileDevice" d JOIN "MobileTokenFamily" f ON f."deviceId" = d."id"
      WHERE d."id" = r."deviceId" AND d."userId" = r."userId" AND d."platform" = 'desktop' AND d."revokedAt" IS NULL
        AND f."id" = r."familyId" AND f."userId" = r."userId" AND f."revokedAt" IS NULL
        AND f."absoluteExpiresAt" > (now() AT TIME ZONE 'UTC')
    ))
  `;
  const devices = await prisma.$queryRaw<DeviceRow[]>`
    SELECT r."deviceId", d."label", r."snapshot", (EXTRACT(EPOCH FROM r."updatedAt") * 1000)::float8 AS "updatedMs"
    FROM "DesktopRemoteDevice" r JOIN "MobileDevice" d ON d."id" = r."deviceId"
    WHERE r."userId" = ${userId} AND d."userId" = ${userId} AND r."expiresAt" > now()
    ORDER BY r."updatedAt" DESC
    LIMIT 10
  `;
  if (!devices.length) return [];
  const commands = await prisma.$queryRaw<CommandRow[]>`
    SELECT "id", "deviceId", "kind", "taskKey", "approvalId", "decision", "deliveredAt" IS NOT NULL AS "delivered",
      "expiresAt" <= now() AS "expired", "result", "resultReason", (EXTRACT(EPOCH FROM "createdAt") * 1000)::float8 AS "createdMs"
    FROM "DesktopRemoteCommand"
    WHERE "userId" = ${userId} AND "deviceId" = ANY(${devices.map((device) => device.deviceId)}::text[])
      AND "createdAt" > now() - (${DESKTOP_REMOTE_COMMAND_RETENTION_MS}::integer * interval '1 millisecond')
    ORDER BY "createdAt" DESC
    LIMIT 100
  `;
  const views: DesktopRemoteDeviceView[] = [];
  for (const device of devices) {
    const snapshot = desktopRemoteSnapshot.safeParse(device.snapshot);
    if (!snapshot.success) continue;
    views.push({
      deviceId: device.deviceId,
      label: device.label.slice(0, 80),
      updatedAt: new Date(device.updatedMs).toISOString(),
      snapshot: snapshot.data,
      commands: commands.filter((row) => row.deviceId === device.deviceId).slice(0, 20).map((row) => ({
        id: row.id,
        kind: row.kind as DesktopRemoteCommandView["kind"],
        taskKey: row.taskKey,
        approvalId: row.approvalId,
        decision: row.decision as DesktopRemoteCommandView["decision"],
        state: commandState(row),
        reason: row.resultReason as DesktopRemoteCommandView["reason"],
        createdAt: new Date(row.createdMs).toISOString(),
      })),
    });
  }
  return views;
}

const AUDIT_ACTIONS = {
  approval: "desktop_remote.approval_answered",
  stop: "desktop_remote.task_stop_requested",
  follow_up: "desktop_remote.follow_up_sent",
} as const;

function auditSummary(input: DesktopRemoteCommandRequest) {
  if (input.kind === "approval") return `Answered a Desktop approval request from another device (${input.decision === "once" ? "allow once" : "deny"})`;
  if (input.kind === "stop") return "Asked a Desktop task to stop from another device";
  return "Sent a Desktop task a follow-up from another device";
}

/**
 * Records one answer, stop or follow-up from a signed-in web session, with the person's audit entry in the same
 * transaction. Refused unless the PC is the session's own, reports now, and its latest report has the task (and, for an
 * answer, the very request with the same digest, answerable from another device). A second answer for one request is
 * refused by the unique index. The PC checks everything again before it acts.
 */
export async function recordDesktopRemoteCommand(input: {
  session: Session;
  request: Request;
  command: DesktopRemoteCommandRequest;
}): Promise<{ id: string }> {
  const userId = input.session.user.id;
  const command = input.command;
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // The audit chain's lock comes before any row lock (lib/adminAudit.ts takeAuditChainLock).
    await takeAuditChainLock(tx);
    const device = await tx.$queryRaw<Array<{ snapshot: unknown }>>`
      SELECT r."snapshot" FROM "DesktopRemoteDevice" r
      JOIN "MobileDevice" d ON d."id" = r."deviceId"
      JOIN "MobileTokenFamily" f ON f."id" = r."familyId"
      WHERE r."deviceId" = ${command.deviceId} AND r."userId" = ${userId} AND r."expiresAt" > now()
        AND d."userId" = ${userId} AND d."platform" = 'desktop' AND d."revokedAt" IS NULL
        AND f."userId" = ${userId} AND f."deviceId" = r."deviceId" AND f."revokedAt" IS NULL
        AND f."absoluteExpiresAt" > (now() AT TIME ZONE 'UTC')
      FOR UPDATE OF r
    `;
    const snapshot = device[0] ? desktopRemoteSnapshot.safeParse(device[0].snapshot) : null;
    if (!snapshot?.success) throw new DesktopRemoteRefused("DEVICE_NOT_FOUND");
    const verdict = checkDesktopRemoteCommand(command, snapshot.data);
    if (!verdict.ok) throw new DesktopRemoteRefused(verdict.code);

    const id = randomUUID();
    const approval = command.kind === "approval" ? command : null;
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "DesktopRemoteCommand" ("id", "deviceId", "userId", "kind", "taskKey", "approvalId", "approvalDigest", "decision", "text", "createdAt", "expiresAt")
      VALUES (${id}, ${command.deviceId}, ${userId}, ${command.kind}, ${command.taskKey}, ${approval?.approvalId ?? null},
        ${approval?.digest ?? null}, ${approval?.decision ?? null}, ${command.kind === "follow_up" ? command.text : null}, now(),
        now() + (${DESKTOP_REMOTE_COMMAND_TTL_MS}::integer * interval '1 millisecond'))
      ON CONFLICT ("deviceId", "approvalId") DO NOTHING
      RETURNING "id"
    `;
    if (!inserted.length) throw new DesktopRemoteRefused("ALREADY_ANSWERED");

    await writeAdminAuditLog({
      tx,
      session: input.session,
      request: input.request,
      action: AUDIT_ACTIONS[command.kind],
      targetType: "DesktopRemoteCommand",
      targetId: id,
      summary: auditSummary(command),
      // Names and counts only: never the follow-up text, a command line or a path.
      metadata: {
        deviceId: command.deviceId,
        taskKey: command.taskKey,
        ...(approval ? {
          approvalId: approval.approvalId, decision: approval.decision, digest: approval.digest,
          approvalKind: snapshot.data.approval?.kind ?? null,
        } : {}),
        ...(command.kind === "follow_up" ? { textLength: command.text.length } : {}),
      },
    });
    return { id };
  });
}

/** Maintenance: reports past their expiry and answers past their retention. Both are short-lived by design. */
export async function purgeDesktopRemoteControl() {
  const commands = await prisma.$executeRaw`
    DELETE FROM "DesktopRemoteCommand"
    WHERE "createdAt" < now() - (${DESKTOP_REMOTE_COMMAND_RETENTION_MS}::integer * interval '1 millisecond')
  `;
  const devices = await prisma.$executeRaw`DELETE FROM "DesktopRemoteDevice" WHERE "expiresAt" <= now()`;
  return { commands, devices };
}
