import "server-only";

import { prisma } from "@/lib/prisma";
import {
  assertOAuthTokenEncryptionConfigured,
  encryptOAuthAccountTokens,
  OAUTH_TOKEN_ENCRYPTED_PREFIX,
} from "@/lib/oauthTokenCrypto";
import { expireCreditLots } from "@/lib/creditLedger";
import { reconcileExpiredChatCreditReservations } from "@/lib/chatSecurity";
import {
  sendFoundingTesterPassEndedEmail,
  sendFoundingTesterPassReminderEmail,
} from "@/lib/billingEmails";
import {
  FOUNDING_TESTER_PASS_EXPIRED_STATUS,
  FOUNDING_TESTER_PASS_STATUS,
} from "@/lib/foundingTesterPassCore";
import { deleteTomverseAccount } from "@/lib/accountDeletion";

const OAUTH_ACCOUNT_BATCH_SIZE = 200;
const TESTER_PASS_BATCH_SIZE = 100;
const TESTER_PASS_REMINDER_WINDOW_MS = 7 * 86_400_000;

export const deleteScheduledAccounts = async (now: Date) => {
  const users = await prisma.user.findMany({
    where: {
      accountStatus: "pending_deletion",
      accountDeletionScheduledFor: { lte: now },
    },
    orderBy: { accountDeletionScheduledFor: "asc" },
    select: { id: true },
    take: 50,
  });
  let deleted = 0;
  for (const user of users) {
    // Re-verify and claim atomically right before deleting: an admin
    // restore that lands between the findMany above and here already
    // flipped accountStatus away from pending_deletion, so this affects 0
    // rows and the account survives instead of being deleted out from
    // under the restore.
    const claimed = await prisma.user.updateMany({
      where: {
        id: user.id,
        accountStatus: "pending_deletion",
        accountDeletionScheduledFor: { lte: now },
      },
      data: { accountStatus: "deletion_processing" },
    });
    if (claimed.count !== 1) continue;
    const result = await deleteTomverseAccount(user.id, {
      cancelSubscription: false,
    });
    if (result.deleted) deleted += 1;
  }
  return deleted;
};

const resetReminderClaim = (id: string, claimedAt: Date) =>
  prisma.billingPromotionRedemption.updateMany({
    where: { id, reminderSentAt: claimedAt },
    data: { reminderSentAt: null },
  });

const sendFoundingTesterPassReminders = async (now: Date) => {
  const rows = await prisma.billingPromotionRedemption.findMany({
    where: {
      reminderSentAt: null,
      expiredAt: null,
      accessEndsAt: {
        gt: now,
        lte: new Date(now.getTime() + TESTER_PASS_REMINDER_WINDOW_MS),
      },
      promotion: { fulfillmentType: "internal_pass" },
    },
    orderBy: { accessEndsAt: "asc" },
    take: TESTER_PASS_BATCH_SIZE,
    select: {
      id: true,
      accessEndsAt: true,
      user: {
        select: {
          email: true,
          settings: { select: { language: true } },
        },
      },
    },
  });
  let sent = 0;
  for (const row of rows) {
    if (!row.accessEndsAt) continue;
    const claimedAt = new Date();
    const claimed = await prisma.billingPromotionRedemption.updateMany({
      where: { id: row.id, reminderSentAt: null, expiredAt: null },
      data: { reminderSentAt: claimedAt },
    });
    if (claimed.count !== 1) continue;
    try {
      const result = await sendFoundingTesterPassReminderEmail({
        to: row.user.email,
        periodEnd: row.accessEndsAt,
        language: row.user.settings?.language,
      });
      if (!result.sent) {
        await resetReminderClaim(row.id, claimedAt);
        continue;
      }
      sent += 1;
    } catch (error) {
      await resetReminderClaim(row.id, claimedAt).catch(() => undefined);
      console.error("Founding Tester Pass reminder email failed:", {
        redemptionId: row.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return sent;
};

const expireFoundingTesterPasses = async (now: Date) => {
  const rows = await prisma.billingPromotionRedemption.findMany({
    where: {
      expiredAt: null,
      accessEndsAt: { lte: now },
      promotion: { fulfillmentType: "internal_pass" },
    },
    orderBy: { accessEndsAt: "asc" },
    take: TESTER_PASS_BATCH_SIZE,
    select: { id: true, userId: true },
  });
  let expired = 0;
  let downgraded = 0;
  for (const row of rows) {
    const outcome = await prisma.$transaction(async (tx) => {
      const marked = await tx.billingPromotionRedemption.updateMany({
        where: { id: row.id, expiredAt: null },
        data: { expiredAt: now },
      });
      if (marked.count !== 1) return { expired: false, downgraded: false };
      const user = await tx.user.updateMany({
        where: {
          id: row.userId,
          stripeSubscriptionId: null,
          subscriptionStatus: FOUNDING_TESTER_PASS_STATUS,
          subscriptionCurrentPeriodEnd: { lte: now },
        },
        data: {
          plan: "Free",
          subscriptionStatus: FOUNDING_TESTER_PASS_EXPIRED_STATUS,
          subscriptionBillingInterval: null,
          subscriptionCancelAtPeriodEnd: true,
        },
      });
      if (user.count !== 1) {
        await tx.billingPromotionRedemption.update({
          where: { id: row.id },
          data: { expiryNoticeSentAt: now },
        });
      }
      return { expired: true, downgraded: user.count === 1 };
    });
    if (outcome.expired) expired += 1;
    if (outcome.downgraded) downgraded += 1;
  }
  return { expired, downgraded };
};

const sendFoundingTesterPassEndedNotices = async (now: Date) => {
  const rows = await prisma.billingPromotionRedemption.findMany({
    where: {
      expiredAt: { not: null },
      expiryNoticeSentAt: null,
      promotion: { fulfillmentType: "internal_pass" },
    },
    orderBy: { expiredAt: "asc" },
    take: TESTER_PASS_BATCH_SIZE,
    select: {
      id: true,
      accessEndsAt: true,
      user: {
        select: {
          email: true,
          settings: { select: { language: true } },
        },
      },
    },
  });
  let sent = 0;
  for (const row of rows) {
    if (!row.accessEndsAt) continue;
    try {
      const result = await sendFoundingTesterPassEndedEmail({
        to: row.user.email,
        periodEnd: row.accessEndsAt,
        language: row.user.settings?.language,
      });
      if (!result.sent) continue;
      const marked = await prisma.billingPromotionRedemption.updateMany({
        where: { id: row.id, expiryNoticeSentAt: null },
        data: { expiryNoticeSentAt: now },
      });
      sent += marked.count;
    } catch (error) {
      console.error("Founding Tester Pass ended email failed:", {
        redemptionId: row.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return sent;
};

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
  const now = new Date();

  const creditReservations = await reconcileExpiredChatCreditReservations();
  const testerPassReminders = await sendFoundingTesterPassReminders(now);
  const testerPassExpirations = await expireFoundingTesterPasses(now);
  const testerPassEndedNotices = await sendFoundingTesterPassEndedNotices(now);
  const scheduledAccountsDeleted = await deleteScheduledAccounts(now);

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
    creditReservations,
    testerPassReminders,
    testerPassExpirations,
    testerPassEndedNotices,
    scheduledAccountsDeleted,
  };
}
