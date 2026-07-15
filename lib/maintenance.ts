import "server-only";

import { prisma } from "@/lib/prisma";
import {
  assertOAuthTokenEncryptionConfigured,
  encryptOAuthAccountTokens,
  OAUTH_TOKEN_ENCRYPTED_PREFIX,
} from "@/lib/oauthTokenCrypto";
import { expireCreditLots } from "@/lib/creditLedger";

const OAUTH_ACCOUNT_BATCH_SIZE = 200;

const encryptExistingOAuthTokens = async () => {
  let encryptedCount = 0;
  let cursor: string | undefined;

  while (true) {
    const accounts = await prisma.account.findMany({
      where: {
        OR: [
          {
            access_token: { not: null },
            NOT: { access_token: { startsWith: OAUTH_TOKEN_ENCRYPTED_PREFIX } },
          },
          {
            refresh_token: { not: null },
            NOT: { refresh_token: { startsWith: OAUTH_TOKEN_ENCRYPTED_PREFIX } },
          },
          {
            id_token: { not: null },
            NOT: { id_token: { startsWith: OAUTH_TOKEN_ENCRYPTED_PREFIX } },
          },
          {
            session_state: { not: null },
            NOT: { session_state: { startsWith: OAUTH_TOKEN_ENCRYPTED_PREFIX } },
          },
        ],
      },
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        access_token: true,
        refresh_token: true,
        id_token: true,
        session_state: true,
      },
      take: OAUTH_ACCOUNT_BATCH_SIZE,
    });

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

    if (accounts.length < OAUTH_ACCOUNT_BATCH_SIZE) break;
    cursor = accounts.at(-1)?.id;
    if (!cursor) break;
  }

  return encryptedCount;
};

export async function cleanupExpiredData() {
  assertOAuthTokenEncryptionConfigured();

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
        AND "periodStart" < DATE_TRUNC('month', NOW()) - INTERVAL '120 days'
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

  const providerErrorEvents = await prisma.providerErrorEvent.deleteMany({
    where: {
      createdAt: {
        lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      },
    },
  });

  const productAnalyticsEvents = await prisma.productAnalyticsEvent.deleteMany({
    where: {
      occurredAt: {
        lt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      },
    },
  });

  const promotionRiskIdentifiers =
    await prisma.billingPromotionRedemption.updateMany({
      where: {
        redeemedAt: {
          lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
        },
        OR: [
          { clientIpHash: { not: null } },
          { paymentMethodFingerprintHash: { not: null } },
        ],
      },
      data: {
        clientIpHash: null,
        paymentMethodFingerprintHash: null,
      },
    });

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
  const creditLotsExpired = await expireCreditLots();

  return {
    sessions: sessions.count,
    usageBuckets: Number(usageBuckets),
    requestLeases: Number(requestLeases),
    providerErrorEvents: providerErrorEvents.count,
    productAnalyticsEvents: productAnalyticsEvents.count,
    promotionRiskIdentifiers: promotionRiskIdentifiers.count,
    shareSnapshots: Number(shareSnapshots),
    oauthTokensEncrypted,
    creditLotsExpired,
  };
}
