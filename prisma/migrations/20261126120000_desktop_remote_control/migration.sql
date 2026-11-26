-- Tomverse Desktop remote control (docs/ops/desktop-remote-control.md): the
-- account's other signed-in devices see the Code tasks a PC runs and answer
-- the approval request on its screen. Two new tables; no existing row or
-- column is touched.
--
--   DesktopRemoteDevice   one row per Desktop that reports, written only by
--                         that device's own Desktop bearer. A short-lived,
--                         redacted report: deleted a few minutes after the
--                         PC's last sync (lib/maintenance.ts), when the PC
--                         turns remote control off, and with the device.
--   DesktopRemoteCommand  one answer, stop or follow-up from a signed-in web
--                         session. The PC picks it up once and decides; the
--                         server never applies it. Deleted 15 minutes after
--                         it was made, and with its device.
--
-- Both are reached from MobileDevice by cascade, so deleting a device, or the
-- account that owns it, deletes them.
--
-- The timestamps are TIMESTAMPTZ: every expiry here is compared with the
-- database clock, and a naive timestamp would move with the session's zone.
--
-- Rollback (nothing else reads these tables):
--   DROP TABLE "DesktopRemoteCommand";
--   DROP TABLE "DesktopRemoteDevice";
BEGIN;

CREATE TABLE "DesktopRemoteDevice" (
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DesktopRemoteDevice_pkey" PRIMARY KEY ("deviceId"),
    -- The route validates a 24 KiB body; this is the backstop for any other writer.
    CONSTRAINT "DesktopRemoteDevice_snapshot_check" CHECK (jsonb_typeof("snapshot") = 'object' AND pg_column_size("snapshot") <= 65536)
);

CREATE TABLE "DesktopRemoteCommand" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "approvalId" TEXT,
    "approvalDigest" TEXT,
    "decision" TEXT,
    "text" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "deliveredAt" TIMESTAMPTZ(3),
    "result" TEXT,
    "resultReason" TEXT,
    "resultAt" TIMESTAMPTZ(3),

    CONSTRAINT "DesktopRemoteCommand_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DesktopRemoteCommand_kind_check" CHECK ("kind" IN ('approval', 'stop', 'follow_up')),
    -- Allow once or deny: "allow for this run" is never answered from another device.
    CONSTRAINT "DesktopRemoteCommand_decision_check" CHECK ("decision" IS NULL OR "decision" IN ('once', 'deny')),
    CONSTRAINT "DesktopRemoteCommand_result_check" CHECK ("result" IS NULL OR "result" IN ('applied', 'refused')),
    CONSTRAINT "DesktopRemoteCommand_resultReason_check" CHECK ("resultReason" IS NULL OR "resultReason" IN ('not_open', 'changed', 'pc_only', 'duplicate', 'expired', 'device', 'unavailable')),
    -- An approval names its request and the digest the person saw; only a follow-up carries text.
    CONSTRAINT "DesktopRemoteCommand_shape_check" CHECK (
        (("kind" = 'approval') = ("approvalId" IS NOT NULL AND "approvalDigest" IS NOT NULL AND "decision" IS NOT NULL))
        AND (("kind" = 'follow_up') = ("text" IS NOT NULL))
        AND ("approvalId" IS NOT NULL OR ("approvalDigest" IS NULL AND "decision" IS NULL))
    ),
    CONSTRAINT "DesktopRemoteCommand_text_check" CHECK ("text" IS NULL OR char_length("text") BETWEEN 1 AND 2000),
    CONSTRAINT "DesktopRemoteCommand_result_shape_check" CHECK (("result" IS NULL) = ("resultAt" IS NULL) AND ("resultReason" IS NULL OR "result" = 'refused'))
);

CREATE INDEX "DesktopRemoteDevice_userId_expiresAt_idx" ON "DesktopRemoteDevice"("userId", "expiresAt");

CREATE INDEX "DesktopRemoteDevice_expiresAt_idx" ON "DesktopRemoteDevice"("expiresAt");

CREATE INDEX "DesktopRemoteCommand_deviceId_deliveredAt_expiresAt_idx" ON "DesktopRemoteCommand"("deviceId", "deliveredAt", "expiresAt");

CREATE INDEX "DesktopRemoteCommand_createdAt_idx" ON "DesktopRemoteCommand"("createdAt");

-- One answer per approval request: a second web answer for the same request is refused here too.
CREATE UNIQUE INDEX "DesktopRemoteCommand_deviceId_approvalId_key" ON "DesktopRemoteCommand"("deviceId", "approvalId");

ALTER TABLE "DesktopRemoteDevice" ADD CONSTRAINT "DesktopRemoteDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "MobileDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DesktopRemoteCommand" ADD CONSTRAINT "DesktopRemoteCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "DesktopRemoteDevice"("deviceId") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
