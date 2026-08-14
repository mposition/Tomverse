import "server-only";

import { prisma } from "@/lib/prisma";
import {
  assertOAuthTokenEncryptionConfigured,
  encryptOAuthAccountTokens,
  OAUTH_TOKEN_ENCRYPTED_PREFIX,
} from "@/lib/oauthTokenCrypto";
import { expireCreditLots } from "@/lib/creditLedger";
import { reconcileExpiredChatCreditReservations } from "@/lib/chatSecurity";
import { purgeExpiredChatLimitDecisions } from "@/lib/chatLimitDecisions";
import { purgeExpiredAccountDataExportRequests } from "@/lib/accountDataExportTickets";
import { compactAgedContextManifests } from "@/lib/routingManifestRetention";
import { deleteExpiredContextBundleConsumptions } from "@/lib/chatContextBundleService";
import { dispatchPendingMemoryExtractionRuns } from "@/lib/memoryExtractionWorker";
import { purgeExpiredTraceErrorEvidence } from "@/lib/traceErrorEvidence";
import { purgeClosedAutoFixCases } from "@/lib/feedbackAutoFixShadow";
import {
  sendFoundingTesterPassEndedEmail,
  sendFoundingTesterPassReminderEmail,
} from "@/lib/billingEmails";
import {
  FOUNDING_TESTER_PASS_EXPIRED_STATUS,
  FOUNDING_TESTER_PASS_STATUS,
} from "@/lib/foundingTesterPassCore";
import { deleteTomverseAccount } from "@/lib/accountDeletion";
import { createMaintenanceStepRunner } from "@/lib/maintenanceStepsCore";
import { retentionCutoff } from "@/lib/retentionPolicyCore";
import { deleteR2Object, listExpiredR2Objects } from "@/lib/r2";
import {
  GUEST_ATTACHMENT_PREFIX,
  getGuestAttachmentTtlMinutes,
} from "@/lib/guestAttachments";

const OAUTH_ACCOUNT_BATCH_SIZE = 200;
const GUEST_ATTACHMENT_SWEEP_BATCH = 500;
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

/**
 * Reclaims ephemeral guest uploads past their TTL.
 *
 * A guest file is deleted as soon as the composer drops it or the turn that
 * used it finishes, but neither of those is guaranteed to run: a closed tab
 * between "picked a file" and "pressed send" leaves an orphan nothing else
 * references. This is the backstop that makes the retention promise true, and
 * the only place a guest object outlives its session.
 *
 * Failures are reported, never thrown: a storage outage must not take the rest
 * of the maintenance run down with it. Nothing about the file's *contents* is
 * logged -- only counts and, on failure, the opaque key.
 */
const sweepExpiredGuestAttachments = async (now: Date) => {
  const cutoff = new Date(now.getTime() - getGuestAttachmentTtlMinutes() * 60_000);
  let deleted = 0;
  let failed = 0;
  try {
    const keys = await listExpiredR2Objects(
      GUEST_ATTACHMENT_PREFIX,
      cutoff,
      GUEST_ATTACHMENT_SWEEP_BATCH
    );
    for (const key of keys) {
      try {
        await deleteR2Object(key);
        deleted += 1;
      } catch (error) {
        failed += 1;
        console.error("Guest attachment cleanup failed for one object:", {
          key,
          error,
        });
      }
    }
  } catch (error) {
    console.error("Guest attachment cleanup could not list objects:", error);
    return { deleted, failed, listed: false };
  }
  return { deleted, failed, listed: true };
};

export async function cleanupExpiredData() {
  // Not a step: without the encryption key the OAuth sweep would write
  // plaintext, so this stays fail-closed for the whole run.
  assertOAuthTokenEncryptionConfigured();
  const now = new Date();

  // Every piece of work below is independent of every other, and each runs
  // under its own name so that one failing does not skip the rest. See
  // lib/maintenanceStepsCore.ts for why. The order is unchanged: the tester
  // pass steps read what the one before them wrote, and running them in
  // sequence keeps a notice in the same run as the expiry it announces.
  const { step, failures } = createMaintenanceStepRunner();

  const creditReservations = await step("chat_credit_reservations", () =>
    reconcileExpiredChatCreditReservations()
  );
  const testerPassReminders = await step("tester_pass_reminders", () =>
    sendFoundingTesterPassReminders(now)
  );
  const testerPassExpirations = await step("tester_pass_expirations", () =>
    expireFoundingTesterPasses(now)
  );
  const testerPassEndedNotices = await step("tester_pass_ended_notices", () =>
    sendFoundingTesterPassEndedNotices(now)
  );
  const scheduledAccountsDeleted = await step("scheduled_account_deletions", () =>
    deleteScheduledAccounts(now)
  );

  const sessions = await step("expired_sessions", () =>
    prisma.session.deleteMany({
      where: { expires: { lte: new Date() } },
    })
  );

  const usageBuckets = await step("usage_buckets", () => prisma.$executeRaw`
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
  `);

  const requestLeases = await step("request_leases", () => prisma.$executeRaw`
    DELETE FROM "ChatRequestLease"
    WHERE "expiresAt" <= NOW()
  `);

  const providerErrorEvents = await step("provider_error_events", () =>
    prisma.providerErrorEvent.deleteMany({
      where: { createdAt: { lt: retentionCutoff("providerErrors", now) } },
    })
  );

  // The two policies /admin/retention published and nothing performed.
  //
  // Provider check records are read newest-first everywhere they are read at
  // all -- the verification cooldown wants the last attempt, the recovery
  // evidence list takes the most recent hundred -- so a 30-day floor is far
  // above anything that reads them, and matches the sanitized provider error
  // diagnostics they sit beside.
  const providerHealthChecks = await step("provider_health_checks", () =>
    prisma.providerHealthCheck.deleteMany({
      where: { createdAt: { lt: retentionCutoff("providerChecks", now) } },
    })
  );

  // Written every probe cycle and read by nothing at all. Without this the
  // table is pure accumulation: the failure path that matters already logs and
  // moves the provider's health counters, and the row is only there for a
  // person to query afterwards.
  const providerProbeResults = await step("provider_probe_results", () =>
    prisma.providerProbeResult.deleteMany({
      where: { startedAt: { lt: retentionCutoff("providerProbeResults", now) } },
    })
  );

  // Every reader of this table is newest-first or last-cycle, so the tail has
  // no audience. An unattended failure older than the window is past being
  // auto-fixable too.
  const scheduledJobRuns = await step("scheduled_job_runs", () =>
    prisma.scheduledJobRun.deleteMany({
      where: { startedAt: { lt: retentionCutoff("scheduledJobRuns", now) } },
    })
  );

  const providerModelCatalogRuns = await step("provider_model_catalog_runs", () =>
    prisma.providerModelCatalogRun.deleteMany({
      where: {
        startedAt: { lt: retentionCutoff("providerModelCatalogRuns", now) },
      },
    })
  );

  // Alert delivery logs, with the same carve-out the notification queue below
  // has and for the same reason: a failed delivery nobody has acknowledged is
  // still on the work queue, oldest first. Sweeping it on age would take the
  // one row an operator has not dealt with and leave the ones they have.
  const notificationLogs = await step("notification_logs", () =>
    prisma.adminNotificationLog.deleteMany({
      where: {
        createdAt: { lt: retentionCutoff("notificationLogs", now) },
        NOT: { status: "failed", acknowledgedAt: null },
      },
    })
  );

  // Same 30-day window as the provider error diagnostics above; the count is
  // the only thing recorded -- never the evidence contents. Feedback rows
  // linked to a purged occurrence keep their verification outcome (the FK
  // nulls out via onDelete: SetNull).
  const traceErrorEvidence = await step("trace_error_evidence", () =>
    purgeExpiredTraceErrorEvidence()
  );

  // Shadow diagnosis cases that reached a terminal state keep their value for
  // 90 days of metric aggregation, then age out; open cases are never purged.
  const autoFixCases = await step("autofix_cases", () => purgeClosedAutoFixCases());

  const productAnalyticsEvents = await step("product_analytics_events", () =>
    prisma.productAnalyticsEvent.deleteMany({
      where: { occurredAt: { lt: retentionCutoff("productAnalytics", now) } },
    })
  );

  // Limit decisions are support diagnostics, not billing records: 90 days is
  // long enough to answer "why was I blocked last quarter" and short enough
  // that the table cannot grow without bound.
  const limitDecisions = await step("limit_decisions", () =>
    purgeExpiredChatLimitDecisions(now)
  );

  const promotionRiskIdentifiers = await step("promotion_risk_identifiers", () =>
    prisma.billingPromotionRedemption.updateMany({
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
    })
  );

  const shareSnapshots = await step("share_snapshots", () => prisma.$executeRaw`
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
  `);
  // Settled notification deliveries are an operational audit trail, not a
  // queue: 30 days is long enough to answer "did that report ever reach us"
  // and short enough that the table cannot grow without bound. Pending rows
  // are never swept -- they still owe a delivery.
  const notificationDeliveries = await step("notification_deliveries", () =>
    prisma.notificationDelivery.deleteMany({
      where: {
        status: { in: ["delivered", "abandoned"] },
        updatedAt: { lt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
      },
    })
  );

  const oauthTokensEncrypted = await step("oauth_token_encryption", () =>
    encryptExistingOAuthTokens()
  );
  const creditLotsExpired = await step("credit_lot_expiry", () => expireCreditLots());
  const guestAttachments = await step("guest_attachments", () =>
    sweepExpiredGuestAttachments(now)
  );

  // A consumed §10 context bundle stops being worth remembering the moment
  // the bundle itself expires: past that, verification refuses it before
  // consumption is ever consulted. Swept here rather than on the request
  // path, where a delete racing a claim is exactly what a nonce table must
  // not do.
  const contextBundleConsumptions = await step("context_bundle_consumptions", () =>
    deleteExpiredContextBundleConsumptions(now)
  );

  // Memory extraction's recovery dispatcher (import/memory policy §11, §11.1).
  //
  // Two steps, and the second is the one that matters. A worker that died
  // mid-run leaves the run `running` with a lease nobody holds, and the claim
  // is fenced on `leaseGeneration` rather than on a deadline, so it does not
  // become claimable until this sweep moves it back to `pending`. Reclaiming
  // alone was the gap §11.1 names: the run becomes claimable and then nothing
  // claims it, so it waits for a request that may never come. Driving it here
  // is what actually guarantees a run finishes.
  const memoryExtraction = await step("memory_extraction_dispatch", () =>
    dispatchPendingMemoryExtractionRuns(now)
  );

  // The export ticket dies at its five-minute expiry; the row is what tells an
  // account owner their data was downloaded last month, so it is kept for the
  // same 90 days as the other security audit trails. Purging it on expiry
  // would leave an audit covering only the last five minutes, which is the
  // same as having none.
  const accountDataExportRequests = await step("account_data_export_requests", () =>
    purgeExpiredAccountDataExportRequests(now)
  );

  // MANIFEST-02. Aged manifests keep the hash an audit verifies with and lose
  // the per-part detail that describes the request. Deletion is not this
  // step's job and never waits for it: a manifest cascades away with the
  // account the moment the account goes, retention window or not.
  const contextManifests = await step("context_manifest_compaction", () =>
    compactAgedContextManifests(now)
  );

  // `null` reads as "this step did not report", which is what a step that threw
  // did. It is deliberately distinct from the `0` of a step that ran and found
  // nothing, and the callers that sum these numbers skip it rather than
  // counting a failure as no work.
  return {
    accountDataExportRequests,
    contextManifestsCompacted: contextManifests?.compacted ?? null,
    // A backlog that is not shrinking is the signal the batch size is too
    // small for the volume, and it is only visible if the step reports it.
    contextManifestsAwaitingCompaction: contextManifests?.remaining ?? null,
    contextBundleConsumptions,
    memoryExtractionRuns: memoryExtraction?.reclaimedRuns ?? null,
    memoryExtractionDispatched: memoryExtraction?.dispatchedRuns ?? null,
    memoryExtractionChunks: memoryExtraction?.chunksProcessed ?? null,
    guestAttachments,
    sessions: sessions?.count ?? null,
    usageBuckets: usageBuckets === null ? null : Number(usageBuckets),
    requestLeases: requestLeases === null ? null : Number(requestLeases),
    providerErrorEvents: providerErrorEvents?.count ?? null,
    providerHealthChecks: providerHealthChecks?.count ?? null,
    providerProbeResults: providerProbeResults?.count ?? null,
    scheduledJobRuns: scheduledJobRuns?.count ?? null,
    providerModelCatalogRuns: providerModelCatalogRuns?.count ?? null,
    notificationLogs: notificationLogs?.count ?? null,
    traceErrorEvidence,
    autoFixCases,
    productAnalyticsEvents: productAnalyticsEvents?.count ?? null,
    limitDecisions: limitDecisions?.deleted ?? null,
    promotionRiskIdentifiers: promotionRiskIdentifiers?.count ?? null,
    notificationDeliveries: notificationDeliveries?.count ?? null,
    shareSnapshots: shareSnapshots === null ? null : Number(shareSnapshots),
    oauthTokensEncrypted,
    creditLotsExpired,
    creditReservations,
    testerPassReminders,
    testerPassExpirations,
    testerPassEndedNotices,
    scheduledAccountsDeleted,
    failedSteps: failures,
  };
}
