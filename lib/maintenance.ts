import "server-only";

import { prisma } from "@/lib/prisma";
import { encryptOAuthAccountTokens } from "@/lib/oauthTokenCrypto";

const encryptExistingOAuthTokens = async () => {
  const accounts = await prisma.account.findMany({
    where: {
      OR: [
        { access_token: { not: null } },
        { refresh_token: { not: null } },
        { id_token: { not: null } },
        { session_state: { not: null } },
      ],
    },
    select: {
      id: true,
      access_token: true,
      refresh_token: true,
      id_token: true,
      session_state: true,
    },
    take: 500,
  });

  let encryptedCount = 0;
  for (const account of accounts) {
    const encrypted = encryptOAuthAccountTokens(account);
    const changed =
      encrypted.access_token !== account.access_token ||
      encrypted.refresh_token !== account.refresh_token ||
      encrypted.id_token !== account.id_token ||
      encrypted.session_state !== account.session_state;
    if (!changed) continue;

    await prisma.account.update({
      where: { id: account.id },
      data: {
        access_token: encrypted.access_token,
        refresh_token: encrypted.refresh_token,
        id_token: encrypted.id_token,
        session_state: encrypted.session_state,
      },
    });
    encryptedCount += 1;
  }

  return encryptedCount;
};

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
  const oauthTokensEncrypted = await encryptExistingOAuthTokens();

  return {
    sessions: sessions.count,
    usageBuckets: Number(usageBuckets),
    requestLeases: Number(requestLeases),
    shareSnapshots: Number(shareSnapshots),
    oauthTokensEncrypted,
  };
}
