import "server-only";

import { prisma } from "@/lib/prisma";

export async function cleanupExpiredData() {
  const sessions = await prisma.session.deleteMany({
    where: { expires: { lte: new Date() } },
  });

  const usageBuckets = await prisma.$executeRaw`
    DELETE FROM "ChatUsageBucket"
    WHERE
      (
        ("period" = 'lock-15m' OR "period" LIKE '%minute%')
        AND "periodStart" < NOW() - INTERVAL '1 day'
      )
      OR (
        "period" LIKE '%day%'
        AND "periodStart" < DATE_TRUNC('day', NOW())
      )
      OR (
        "period" LIKE '%month%'
        AND "periodStart" < DATE_TRUNC('month', NOW())
      )
      OR (
        "period" NOT LIKE '%minute%'
        AND "period" NOT LIKE '%day%'
        AND "period" NOT LIKE '%month%'
        AND "period" <> 'lock-15m'
        AND "updatedAt" < NOW() - INTERVAL '90 days'
      )
  `;

  const requestLeases = await prisma.$executeRaw`
    DELETE FROM "ChatRequestLease"
    WHERE "expiresAt" <= NOW()
  `;

  const shareSnapshots = await prisma.$executeRaw`
    UPDATE "Conversation"
    SET
      "shareEnabled" = FALSE,
      "shareToken" = NULL,
      "shareSnapshot" = NULL,
      "shareExpiresAt" = NULL,
      "shareRevokedAt" = COALESCE("shareRevokedAt", NOW())
    WHERE
      (
        "shareExpiresAt" <= NOW()
        OR "shareRevokedAt" IS NOT NULL
        OR "shareEnabled" = FALSE
      )
      AND (
        "shareToken" IS NOT NULL
        OR "shareSnapshot" IS NOT NULL
        OR "shareExpiresAt" IS NOT NULL
      )
  `;

  return {
    sessions: sessions.count,
    usageBuckets: Number(usageBuckets),
    requestLeases: Number(requestLeases),
    shareSnapshots: Number(shareSnapshots),
  };
}
