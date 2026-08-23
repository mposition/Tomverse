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
  applyPendingAttemptCostAdjustments,
  pendingAttemptCostAdjustmentBacklog,
} from "@/lib/chatAttemptCostLedger";
import {
  COST_INTENT_CUTOVER_ENV,
  STALE_ATTEMPT_SWEEP_BATCH,
  staleAttemptBacklog,
  sweepStaleRoutingAttempts,
} from "@/lib/routingAttemptSweep";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

/**
 * How long an unapplied cost correction may sit before it is an incident.
 *
 * Two runs of the fifteen-minute maintenance cron, plus a margin: one run
 * failing to apply a delta is a blip, and two in a row is something nobody is
 * going to notice from the logs alone.
 */
const STALE_COST_ADJUSTMENT_AFTER_MS = 45 * 60 * 1000;

/**
 * How long an attempt may stay sweepable before the sweep is behind.
 *
 * Thirty minutes to be judged stale at all, plus two fifteen-minute runs. One
 * run failing to reach it is a batch boundary or a blip; an attempt still open
 * an hour after it was created is the sweep not keeping up.
 */
const STALE_ATTEMPT_BACKLOG_AFTER_MS = 60 * 60 * 1000;
import { purgeExpiredChatLimitDecisions } from "@/lib/chatLimitDecisions";
import { purgeExpiredAccountDataExportRequests } from "@/lib/accountDataExportTickets";
import { compactAgedContextManifests } from "@/lib/routingManifestRetention";
import { deleteExpiredContextBundleConsumptions } from "@/lib/chatContextBundleService";
import { dispatchPendingMemoryExtractionRuns } from "@/lib/memoryExtractionWorker";
import { purgeExpiredTraceErrorEvidence } from "@/lib/traceErrorEvidence";
import { purgeClosedAutoFixCases } from "@/lib/feedbackAutoFixShadow";
import {
  FOUNDING_TESTER_PASS_ENDED_TEMPLATE,
  FOUNDING_TESTER_PASS_REMINDER_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import { enqueueStandardEmail } from "@/lib/standardEmailLane";
import {
  FOUNDING_TESTER_PASS_EXPIRED_STATUS,
  FOUNDING_TESTER_PASS_STATUS,
} from "@/lib/foundingTesterPassCore";
import { deleteTomverseAccount } from "@/lib/accountDeletion";
import { createMaintenanceStepRunner } from "@/lib/maintenanceStepsCore";
import { purgeExpiredRenderSnapshots } from "@/lib/emailSnapshotRetention";
import { retentionCutoff } from "@/lib/retentionPolicyCore";
import {
  drainKnowledgeCleanupQueue,
  KNOWLEDGE_CLEANUP_EXECUTION_LIMIT,
  sweepAbandonedKnowledgeObjects,
} from "@/lib/assistantKnowledgeLifecycle";
import { processPendingKnowledgeFiles } from "@/lib/assistantKnowledgeProcessor";
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

/**
 * Exported for the DB integration test.
 *
 * The whole maintenance run needs a set of keys this one step does not, so a
 * test that had to call `cleanupExpiredData()` to reach it would be testing the
 * environment as much as the behaviour.
 */
export const sendFoundingTesterPassReminders = async (now: Date) => {
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
          id: true,
          email: true,
          settings: { select: { language: true } },
        },
      },
    },
  });
  let sent = 0;
  for (const row of rows) {
    if (!row.accessEndsAt) continue;
    const accessEndsAt = row.accessEndsAt;
    try {
      // The claim and the outbox row commit together, which is what the queue
      // buys here. The old shape claimed first, sent second and undid the claim
      // when the send threw -- and a crash in that window marked the reminder
      // sent without one existing. Now either both rows are there or neither is
      // (docs/policy/email-notifications.md §2.4).
      const enqueued = await prisma.$transaction(
        async (tx) => {
          const claimed = await tx.billingPromotionRedemption.updateMany({
            where: { id: row.id, reminderSentAt: null, expiredAt: null },
            data: { reminderSentAt: new Date() },
          });
          if (claimed.count !== 1) return false;
          await enqueueStandardEmail({
            tx,
            templateKey: FOUNDING_TESTER_PASS_REMINDER_TEMPLATE,
            emailAddress: row.user.email,
            userId: row.user.id,
            language: row.user.settings?.language,
            payload: { periodEnd: accessEndsAt.toISOString() },
            referenceType: "BillingPromotionRedemption",
            referenceId: row.id,
          });
          return true;
        },
        // Wider than the default because enqueueStandardEmail resolves the
        // template version and the jurisdiction on its own connection first,
        // and the very first send of a newly registered template inserts rows.
        { maxWait: 5_000, timeout: 15_000 }
      );
      if (enqueued) sent += 1;
    } catch (error) {
      console.error("Founding Tester Pass reminder enqueue failed:", {
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

/** Exported for the DB integration test; see above. */
export const sendFoundingTesterPassEndedNotices = async (now: Date) => {
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
          id: true,
          email: true,
          settings: { select: { language: true } },
        },
      },
    },
  });
  let sent = 0;
  for (const row of rows) {
    if (!row.accessEndsAt) continue;
    const accessEndsAt = row.accessEndsAt;
    try {
      // Same shape as the reminder, and for the same reason: the old order sent
      // first and marked second, so a failure to mark sent the notice again on
      // the next sweep.
      const enqueued = await prisma.$transaction(
        async (tx) => {
          const marked = await tx.billingPromotionRedemption.updateMany({
            where: { id: row.id, expiryNoticeSentAt: null },
            data: { expiryNoticeSentAt: now },
          });
          if (marked.count !== 1) return false;
          await enqueueStandardEmail({
            tx,
            templateKey: FOUNDING_TESTER_PASS_ENDED_TEMPLATE,
            emailAddress: row.user.email,
            userId: row.user.id,
            language: row.user.settings?.language,
            payload: { periodEnd: accessEndsAt.toISOString() },
            referenceType: "BillingPromotionRedemption",
            referenceId: row.id,
          });
          return true;
        },
        { maxWait: 5_000, timeout: 15_000 }
      );
      if (enqueued) sent += 1;
    } catch (error) {
      console.error("Founding Tester Pass ended enqueue failed:", {
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

  // The provider-cost ledger's two recovery passes.
  //
  // These are idempotent and do not depend on one another for correctness --
  // the sweep already accepts a reservation that is merely expired, and
  // nothing in this run creates the adjustments the replay applies. They run
  // after the primary reconciliation to keep maintenance reporting and
  // operational ownership predictable, not because either needs the other.
  //
  // Until this run existed neither had a production caller at all: a sweep
  // nobody ran, and a partial index nobody consumed, which from the data is
  // indistinguishable from having nothing to recover.
  const staleRoutingAttempts = await step("stale_routing_attempts", async () => {
    const swept = await sweepStaleRoutingAttempts(now);
    const backlog = await staleAttemptBacklog(now);

    // A contract violation, not a workload. One is enough: the sweep cannot
    // produce these outcomes by construction, so seeing one means the ledger
    // grew a path nobody expected or this sweep started writing a record it
    // should not.
    if (swept.unexpectedCostOutcome > 0) {
      await reportOperationalIncident({
        code: "CHAT_COST_SWEEP_UNEXPECTED_OUTCOME",
        title: "The attempt sweep produced a cost outcome it cannot produce",
        severity: "error",
        context: { component: "chat-cost-ledger", ...swept.noCostReasons, unexpected: swept.unexpectedCostOutcome },
      });
    }

    // Four of the no-cost reasons are defects with no grace period: a run
    // pointing at a reservation that is gone, a payload that will not
    // validate, a payload written *after* cost intents existed and carrying
    // none, and an intent naming a different model than the attempt that ran.
    // Each is a provider call nobody can price, caused by something wrong now
    // rather than by history.
    //
    // A turn that authorized nothing is not among them and is not even a
    // no-cost reason any more: it has an intent like every other dispatch, so
    // it gets a cost row with a ceiling of zero. The models it happens on are
    // still reported by name -- a deliberately free model and a price an
    // administrator flattened to zero look identical from here, and the
    // difference is *which model* -- and `npm run check:model-pricing-db`
    // reads the catalogue to say whether that price was meant.
    const defects =
      swept.noCostReasons.dangling_reservation +
      swept.noCostReasons.invalid_cost_intent_payload +
      swept.noCostReasons.missing_cost_intent +
      swept.noCostReasons.cost_intent_identity_mismatch;
    if (defects > 0) {
      await reportOperationalIncident({
        code: "CHAT_COST_INTENT_UNAVAILABLE",
        title: "A crashed attempt could not be priced, and not because of legacy data",
        severity: "error",
        context: { component: "chat-cost-ledger", ...swept.noCostReasons },
      });
    }

    // The cutover is what tells history apart from a defect. Unset, the
    // distinction cannot be made at all -- so the missing configuration is
    // itself the thing to report, rather than silently answering "legacy".
    if (swept.noCostReasons.unclassified_missing_cost_intent > 0) {
      await reportOperationalIncident({
        code: "CHAT_COST_INTENT_CUTOVER_UNSET",
        title: `Set ${COST_INTENT_CUTOVER_ENV} so a missing cost intent can be classified`,
        severity: "warning",
        context: {
          component: "chat-cost-ledger",
          unclassified: swept.noCostReasons.unclassified_missing_cost_intent,
        },
      });
    }

    // `failed` is a database that was briefly unavailable, and one of those is
    // not worth a call. What is worth a call is the sweep not keeping up:
    // either more eligible attempts than one batch can take, or an attempt
    // that has been eligible longer than two cron periods past the stale
    // window -- thirty minutes to become stale, plus two fifteen-minute runs.
    if (
      backlog.eligiblePending > STALE_ATTEMPT_SWEEP_BATCH ||
      (backlog.oldestEligibleMs ?? 0) > STALE_ATTEMPT_BACKLOG_AFTER_MS
    ) {
      await reportOperationalIncident({
        code: "CHAT_ATTEMPT_SWEEP_BACKLOG",
        title: "Crashed attempts are not being closed fast enough",
        severity: "error",
        context: {
          component: "chat-cost-ledger",
          eligiblePending: backlog.eligiblePending,
          agedPending: backlog.agedPending,
          oldestEligibleMs: backlog.oldestEligibleMs,
          failedThisRun: swept.failed,
          zeroReservedCostModels: Object.keys(swept.zeroReservedCostModels).join(", "),
        },
      });
    }
    return { ...swept, ...backlog };
  });

  const costAdjustments = await step("pending_cost_adjustments", async () => {
    const replayed = await applyPendingAttemptCostAdjustments();
    const backlog = await pendingAttemptCostAdjustmentBacklog(now);
    // Nothing here retries with a ceiling, and deliberately: a provider cost
    // delta is not data that may be abandoned after N attempts. What is needed
    // instead is for a delta that keeps failing to become visible, and the age
    // of the oldest unapplied one is the number that says so. Two runs is the
    // threshold because one run failing is a blip and two is a pattern.
    if ((backlog.oldestPendingMs ?? 0) > STALE_COST_ADJUSTMENT_AFTER_MS) {
      await reportOperationalIncident({
        code: "CHAT_COST_ADJUSTMENT_BACKLOG",
        title: "Provider cost corrections are not reaching the rollup",
        severity: "error",
        context: {
          component: "chat-cost-ledger",
          pending: backlog.pending,
          oldestPendingMs: backlog.oldestPendingMs,
          appliedThisRun: replayed.applied,
          failedThisRun: replayed.failed,
        },
      });
    }
    return { ...replayed, ...backlog };
  });

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

  // Raw email addresses and two credential hashes per sign-in attempt, kept by
  // nothing until now. `expiresAt` rather than `createdAt`: it is the moment
  // the row stops being able to authenticate anyone, and it is the indexed
  // column (`@@index([expiresAt])`), so this is an index scan rather than a
  // sequential one over a table that grows with every login attempt including
  // the ones for addresses that have no account.
  //
  // No carve-out for consumed or invalidated rows. A consumed row is spent and
  // an invalidated one was superseded by a newer attempt, so neither outlives
  // the unconsumed row beside it -- and a carve-out here would keep exactly
  // the rows belonging to people who did sign in.
  // One row per deep research request. Its user-visible half is a copy --
  // `resultText` is written into `Message.content` in the same transaction that
  // finalizes the job -- so what is kept here is an operational record, and the
  // clock is `updatedAt` because a job nobody polls again never reaches a
  // terminal status and would otherwise never be covered at all.
  // Both R2 deletion queues, one step, completed rows only.
  //
  // The `completedAt: { not: null }` filter is the whole safety of this: a
  // pending row is the only record of the object's R2 key anywhere in the
  // system, so deleting one strands the file in storage with no name and
  // nothing that could ever reap it. The queue is drained by
  // `assistant_knowledge_cleanup` and the image sweep; this only removes what
  // they already finished.
  const storageCleanupQueues = await step("storage_cleanup_queues", async () => {
    const cutoff = retentionCutoff("storageCleanupQueues", now);
    const where = {
      completedAt: { not: null, lt: cutoff },
    } as const;
    const [images, knowledge] = await Promise.all([
      prisma.imageAssetCleanup.deleteMany({ where }),
      prisma.assistantKnowledgeCleanup.deleteMany({ where }),
    ]);
    return { count: images.count + knowledge.count };
  });

  // Measurement rows for the estimator evaluation -- counts and ratios, no
  // prompt or completion text. Read only by report:token-estimate-calibration,
  // which wants recent traffic; a sample older than the estimator version it
  // was comparing describes a comparison nobody is running.
  const tokenEstimateShadowSamples = await step(
    "token_estimate_shadow_samples",
    () =>
      prisma.tokenEstimateShadowSample.deleteMany({
        where: {
          createdAt: { lt: retentionCutoff("tokenEstimateShadowSamples", now) },
        },
      })
  );

  const deepResearchJobs = await step("deep_research_jobs", () =>
    prisma.perplexityAsyncJob.deleteMany({
      where: { updatedAt: { lt: retentionCutoff("deepResearchJobs", now) } },
    })
  );

  const emailLoginAttempts = await step("email_login_attempts", () =>
    prisma.emailLoginAttempt.deleteMany({
      where: { expiresAt: { lt: retentionCutoff("emailLoginAttempts", now) } },
    })
  );

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
  // The personalisation inputs a message was rendered from, cleared once its
  // classification's window has passed (docs/policy/email-notifications.md
  // §10.3 rule 3). The row stays, `renderedHash` stays, and the proof that a
  // notice was sent stays -- only the reproducible window closes.
  //
  // Age is measured from the send, falling back to when the row was written:
  // a delivery that never sent still holds the same personal data, and leaving
  // it forever because it failed would be the wrong way round.
  const emailRenderSnapshots = await step("email_render_snapshots", () =>
    purgeExpiredRenderSnapshots()
  );

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

  // Assistant knowledge storage (import/memory policy §14.2). Two steps
  // because they answer different questions: the queue deletes the bytes of
  // rows that are already gone, and the orphan sweep takes objects no row ever
  // claimed. An active knowledge file is deliberately not swept at all -- it
  // has no expiry, which is the policy's decision rather than a gap here.
  const knowledgeCleanup = await step("assistant_knowledge_cleanup", () =>
    drainKnowledgeCleanupQueue(KNOWLEDGE_CLEANUP_EXECUTION_LIMIT, now)
  );
  const knowledgeOrphans = await step("assistant_knowledge_orphans", () =>
    sweepAbandonedKnowledgeObjects(now)
  );
  // The extraction driver, in the same shape memory extraction's is: reclaim
  // a file whose worker died, then actually process it. Reclaiming alone
  // leaves a claimable row waiting for a request that may never come.
  const knowledgeProcessing = await step("assistant_knowledge_processing", () =>
    processPendingKnowledgeFiles(now)
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
    assistantKnowledgeObjectsDeleted: knowledgeCleanup?.deleted ?? null,
    assistantKnowledgeCleanupExhausted: knowledgeCleanup?.exhausted ?? null,
    assistantKnowledgeOrphansDeleted: knowledgeOrphans?.deleted ?? null,
    assistantKnowledgeReclaimed: knowledgeProcessing?.reclaimed ?? null,
    assistantKnowledgeProcessed: knowledgeProcessing?.processed ?? null,
    sessions: sessions?.count ?? null,
    usageBuckets: usageBuckets === null ? null : Number(usageBuckets),
    requestLeases: requestLeases === null ? null : Number(requestLeases),
    storageCleanupQueues: storageCleanupQueues?.count ?? null,
    tokenEstimateShadowSamples: tokenEstimateShadowSamples?.count ?? null,
    deepResearchJobs: deepResearchJobs?.count ?? null,
    emailLoginAttempts: emailLoginAttempts?.count ?? null,
    providerErrorEvents: providerErrorEvents?.count ?? null,
    providerHealthChecks: providerHealthChecks?.count ?? null,
    providerProbeResults: providerProbeResults?.count ?? null,
    scheduledJobRuns: scheduledJobRuns?.count ?? null,
    providerModelCatalogRuns: providerModelCatalogRuns?.count ?? null,
    notificationLogs: notificationLogs?.count ?? null,
    emailRenderSnapshots,
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
    staleRoutingAttempts,
    costAdjustments,
    testerPassReminders,
    testerPassExpirations,
    testerPassEndedNotices,
    scheduledAccountsDeleted,
    failedSteps: failures,
  };
}
