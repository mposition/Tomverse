import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// What one failing retention step costs the rest of the run.
//
// `cleanupExpiredData()` is about twenty independent sweeps awaited in one
// sequence. Awaiting them bare meant the first to throw ended the run, and
// every later sweep was skipped -- not for that run only, but on every run,
// because a step that throws for a reason that is still there tomorrow throws
// again tomorrow. The steps behind it stop happening and nothing says so: the
// job reports "failed", which it would also report if only the last step had
// failed.
//
// The step that makes this concrete is `scheduled_account_deletions`, fifth in
// the order. It is the sweep that keeps the promise made to someone who asked
// for their account to be deleted -- seven days, per ACCOUNT_DELETION_GRACE_MS
// in lib/accountDeletion.ts and per the sentence every locale shows them -- and
// it sat behind four sweeps that have nothing to do with it.
//
// The unit test in tests/maintenanceStepsCore.test.mjs covers the runner. This
// one covers the wiring: that `cleanupExpiredData` actually routes its steps
// through it, which is the part a refactor can quietly undo.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";

/** Per-test behaviour. Mocks are installed once; these closures vary. */
let creditReservationBehaviour: () => number = () => 1;
let oauthKeyBehaviour: () => void = () => undefined;
let deletedAccountIds: string[] = [];

const reset = () => {
  creditReservationBehaviour = () => 1;
  oauthKeyBehaviour = () => undefined;
  deletedAccountIds = [];
  costAdjustmentBacklogPending = 0;
  costAdjustmentBacklogOldestMs = null;
  sweepNoCostReasons = emptyNoCost();
  sweepZeroReservedCostModels = {};
  sweepUnexpectedOutcome = 0;
  sweepAgedPending = 0;
  sweepEligiblePending = 0;
  sweepOldestEligibleMs = null;
  reportedIncidents.length = 0;
};

// The rows the sweep would find. Only `user.findMany` returns anything: it is
// what lets the fifth step do observable work, which is the point of the first
// test below.
const prismaStub = {
  user: {
    findMany: async () => [{ id: "user-past-its-grace-period" }],
    updateMany: async () => ({ count: 1 }),
  },
  account: { findMany: async () => [], update: async () => ({}) },
  session: { deleteMany: async () => ({ count: 2 }) },
  billingPromotionRedemption: {
    findMany: async () => [],
    update: async () => ({}),
    updateMany: async () => ({ count: 4 }),
  },
  providerErrorEvent: { deleteMany: async () => ({ count: 6 }) },
  productAnalyticsEvent: { deleteMany: async () => ({ count: 7 }) },
  notificationDelivery: { deleteMany: async () => ({ count: 8 }) },
  providerHealthCheck: { deleteMany: async () => ({ count: 21 }) },
  adminNotificationLog: { deleteMany: async () => ({ count: 22 }) },
  providerProbeResult: { deleteMany: async () => ({ count: 23 }) },
  scheduledJobRun: { deleteMany: async () => ({ count: 24 }) },
  providerModelCatalogRun: { deleteMany: async () => ({ count: 25 }) },
  $executeRaw: async () => 9,
  $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prismaStub),
};

mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: prismaStub } });

mock.module(mod("lib/oauthTokenCrypto.ts"), {
  namedExports: {
    assertOAuthTokenEncryptionConfigured: () => oauthKeyBehaviour(),
    encryptOAuthAccountTokens: (account: unknown) => account,
    OAUTH_TOKEN_ENCRYPTED_PREFIX: "enc:v1:",
  },
});

mock.module(mod("lib/chatSecurity.ts"), {
  namedExports: {
    reconcileExpiredChatCreditReservations: async () =>
      creditReservationBehaviour(),
  },
});

// The provider-cost ledger's two recovery passes. Both had no production
// caller at all before this run began invoking them -- a sweep nobody ran and
// a partial index nobody consumed -- so the wiring is the thing worth pinning.
mock.module(mod("lib/routingAttemptSweep.ts"), {
  namedExports: {
    COST_INTENT_CUTOVER_ENV: "AUTO_ROUTER_COST_INTENT_CUTOVER_AT",
    STALE_ATTEMPT_SWEEP_BATCH: 200,
    sweepStaleRoutingAttempts: async () => ({
      examined: 31,
      closedCostInserted: 31,
      closedWithExistingCost: 0,
      closedWithoutCostIntent: sweepNoCostTotal(),
      noCostReasons: sweepNoCostReasons,
      zeroReservedCostModels: sweepZeroReservedCostModels,
      unexpectedCostOutcome: sweepUnexpectedOutcome,
      alreadyClosed: 0,
      failed: 0,
    }),
    staleAttemptBacklog: async () => ({
      agedPending: sweepAgedPending,
      eligiblePending: sweepEligiblePending,
      oldestEligibleMs: sweepOldestEligibleMs,
    }),
  },
});
mock.module(mod("lib/chatAttemptCostLedger.ts"), {
  namedExports: {
    applyPendingAttemptCostAdjustments: async () => ({
      examined: 32,
      applied: 32,
      failed: 0,
    }),
    pendingAttemptCostAdjustmentBacklog: async () => ({
      pending: costAdjustmentBacklogPending,
      oldestPendingMs: costAdjustmentBacklogOldestMs,
    }),
  },
});
mock.module(mod("lib/operationalMonitoring.ts"), {
  namedExports: {
    reportOperationalIncident: async (incident: { code: string }) => {
      reportedIncidents.push(incident.code);
    },
  },
});

// Every remaining collaborator returns a distinct number, so an assertion can
// name which step produced which figure rather than matching on a shared 0.
mock.module(mod("lib/creditLedger.ts"), {
  namedExports: { expireCreditLots: async () => 11 },
});
mock.module(mod("lib/chatLimitDecisions.ts"), {
  namedExports: { purgeExpiredChatLimitDecisions: async () => ({ deleted: 12 }) },
});
mock.module(mod("lib/accountDataExportTickets.ts"), {
  namedExports: { purgeExpiredAccountDataExportRequests: async () => 13 },
});
mock.module(mod("lib/routingManifestRetention.ts"), {
  namedExports: {
    compactAgedContextManifests: async () => ({ compacted: 21, remaining: 3 }),
  },
});
mock.module(mod("lib/chatContextBundleService.ts"), {
  namedExports: { deleteExpiredContextBundleConsumptions: async () => 14 },
});
mock.module(mod("lib/memoryExtractionWorker.ts"), {
  namedExports: {
    dispatchPendingMemoryExtractionRuns: async () => ({
      reclaimedRuns: 15,
      dispatchedRuns: 16,
      chunksProcessed: 17,
    }),
  },
});
mock.module(mod("lib/traceErrorEvidence.ts"), {
  namedExports: { purgeExpiredTraceErrorEvidence: async () => 18 },
});
mock.module(mod("lib/feedbackAutoFixShadow.ts"), {
  namedExports: { purgeClosedAutoFixCases: async () => 19 },
});
mock.module(mod("lib/billingEmails.ts"), {
  namedExports: {
    sendFoundingTesterPassReminderEmail: async () => ({ sent: true }),
    sendFoundingTesterPassEndedEmail: async () => ({ sent: true }),
  },
});
mock.module(mod("lib/accountDeletion.ts"), {
  namedExports: {
    deleteTomverseAccount: async (userId: string) => {
      deletedAccountIds.push(userId);
      return { deleted: true };
    },
  },
});
mock.module(mod("lib/r2.ts"), {
  namedExports: {
    listExpiredR2Objects: async () => [],
    deleteR2Object: async () => undefined,
  },
});
mock.module(mod("lib/guestAttachments.ts"), {
  namedExports: {
    GUEST_ATTACHMENT_PREFIX: "guest-attachments/",
    getGuestAttachmentTtlMinutes: () => 60,
  },
});
// Release C2's two knowledge steps. Mocked as a collaborator rather than by
// teaching the Prisma stub two more tables, so the assertions below name the
// step that produced each figure -- which is what the rest of this file does.
mock.module(mod("lib/assistantKnowledgeLifecycle.ts"), {
  namedExports: {
    drainKnowledgeCleanupQueue: async () => ({
      examined: 26,
      deleted: 26,
      failed: 0,
      exhausted: 27,
    }),
    sweepAbandonedKnowledgeObjects: async () => ({
      deleted: 28,
      failed: 0,
      listed: true,
    }),
  },
});
mock.module(mod("lib/assistantKnowledgeProcessor.ts"), {
  namedExports: {
    processPendingKnowledgeFiles: async () => ({
      reclaimed: 29,
      processed: 30,
      ready: 30,
      failed: 0,
    }),
  },
});

type CleanupResult = Record<string, unknown> & {
  failedSteps: { step: string; error: string }[];
  staleRoutingAttempts: {
    closedCostInserted: number;
    zeroReservedCostModels: Record<string, number>;
    eligiblePending: number;
    agedPending: number;
    oldestEligibleMs: number | null;
  } | null;
  costAdjustments: { applied: number; pending: number } | null;
};
const emptyNoCost = () => ({
  no_reservation: 0,
  legacy_missing_cost_intent: 0,
  missing_cost_intent: 0,
  cost_intent_identity_mismatch: 0,
  unclassified_missing_cost_intent: 0,
  dangling_reservation: 0,
  invalid_cost_intent_payload: 0,
});
let sweepNoCostReasons = emptyNoCost();
const sweepNoCostTotal = () =>
  Object.values(sweepNoCostReasons).reduce((sum, count) => sum + count, 0);
let sweepZeroReservedCostModels: Record<string, number> = {};
let sweepUnexpectedOutcome = 0;
let sweepAgedPending = 0;
let sweepEligiblePending = 0;
let sweepOldestEligibleMs: number | null = null;
let costAdjustmentBacklogPending = 0;
let costAdjustmentBacklogOldestMs: number | null = null;
const reportedIncidents: string[] = [];

type MaintenanceModule = { cleanupExpiredData: () => Promise<CleanupResult> };

// Loaded lazily: this file is transformed to CJS, where top-level await is not
// available.
let loaded: MaintenanceModule | null = null;
const load = async () => {
  if (loaded) return loaded;
  loaded = (await import(mod("lib/maintenance.ts"))) as MaintenanceModule;
  return loaded;
};

test("a step that throws does not skip the steps behind it", async () => {
  reset();
  creditReservationBehaviour = () => {
    throw new Error("the reservation table is unhappy");
  };

  const { cleanupExpiredData } = await load();
  const result = await cleanupExpiredData();

  // The step that failed reports nothing, under its own name.
  assert.equal(result.creditReservations, null);
  assert.deepEqual(
    result.failedSteps.map((failure) => failure.step),
    ["chat_credit_reservations"]
  );
  assert.match(result.failedSteps[0].error, /the reservation table is unhappy/);

  // The fifth step -- the seven-day account deletion promise -- still ran. This
  // is the assertion the change exists for.
  assert.deepEqual(deletedAccountIds, ["user-past-its-grace-period"]);
  assert.equal(result.scheduledAccountsDeleted, 1);

  // So did everything after it, all the way to the last step.
  assert.equal(result.sessions, 2);
  assert.equal(result.creditLotsExpired, 11);
  assert.equal(result.limitDecisions, 12);
  assert.equal(result.accountDataExportRequests, 13);
  assert.equal(result.contextManifestsCompacted, 21);
  // The backlog is reported beside the count: a sweep that compacted its whole
  // batch and left work behind is the signal the batch is too small, and it is
  // only visible if the step says so.
  assert.equal(result.contextManifestsAwaitingCompaction, 3);
  assert.equal(result.contextBundleConsumptions, 14);
  assert.equal(result.memoryExtractionDispatched, 16);
  assert.equal(result.traceErrorEvidence, 18);
  assert.equal(result.autoFixCases, 19);
  assert.equal(result.notificationDeliveries, 8);
  // The two steps that enforce policies /admin/retention had been publishing
  // with nothing behind them.
  assert.equal(result.providerHealthChecks, 21);
  assert.equal(result.notificationLogs, 22);
  // And the three tables the unswept-tables report found, which had no
  // ceiling at all before they were given one.
  assert.equal(result.providerProbeResults, 23);
  assert.equal(result.scheduledJobRuns, 24);
  assert.equal(result.providerModelCatalogRuns, 25);
  // Release C2's storage sweeps. Two steps because they answer different
  // questions: tombstoned bytes, and objects no row ever claimed.
  assert.equal(result.assistantKnowledgeObjectsDeleted, 26);
  assert.equal(result.assistantKnowledgeCleanupExhausted, 27);
  assert.equal(result.assistantKnowledgeOrphansDeleted, 28);
  // And the extraction driver, which reclaims a file whose worker died and
  // then actually processes it -- reclaiming alone was the gap the memory
  // extraction slice already paid for.
  assert.equal(result.assistantKnowledgeReclaimed, 29);
  assert.equal(result.assistantKnowledgeProcessed, 30);
});

test("a clean run reports no failed steps and every count", async () => {
  reset();

  const { cleanupExpiredData } = await load();
  const result = await cleanupExpiredData();

  assert.deepEqual(result.failedSteps, []);
  assert.equal(result.creditReservations, 1);
  assert.equal(result.scheduledAccountsDeleted, 1);

  // Nothing reports `null` on a clean run: `null` means "this step did not
  // report", so a step quietly dropped from the runner would show up here.
  const unreported = Object.entries(result)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  assert.deepEqual(unreported, []);
});

// The encryption key is checked before the first step and is not one: without
// it the OAuth sweep would write plaintext, so it stays fail-closed for the
// whole run rather than degrading to one failed step among twenty.
test("a missing OAuth encryption key still fails the whole run", async () => {
  reset();
  oauthKeyBehaviour = () => {
    throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY is not configured");
  };

  const { cleanupExpiredData } = await load();
  await assert.rejects(cleanupExpiredData(), /OAUTH_TOKEN_ENCRYPTION_KEY/);
  assert.deepEqual(deletedAccountIds, []);
});

// The provider-cost ledger's recovery passes only exist if something runs
// them. Until this run called them, `sweepStaleRoutingAttempts` and
// `applyPendingAttemptCostAdjustments` were a function and a partial index
// with tests and no caller -- which looks identical, from the data, to a
// system with nothing to recover.

test("the maintenance run drives the cost ledger's recovery passes", async () => {
  reset();
  const { cleanupExpiredData } = await load();
  const result = await cleanupExpiredData();

  assert.equal(result.staleRoutingAttempts?.closedCostInserted, 31);
  assert.equal(result.costAdjustments?.applied, 32);
  // The backlog is reported beside the count, for the same reason the manifest
  // sweep reports its own: a pass that applied everything it found and left
  // work behind is only visible if the step says so.
  assert.equal(result.costAdjustments?.pending, 0);
  assert.deepEqual(reportedIncidents, []);
});

test("corrections older than two runs are an incident, not a log line", async () => {
  reset();
  costAdjustmentBacklogPending = 4;
  costAdjustmentBacklogOldestMs = 46 * 60 * 1000;

  const { cleanupExpiredData } = await load();
  await cleanupExpiredData();

  // No retry ceiling and no dead letter: a provider cost delta is not data
  // that may be abandoned after N attempts. What it needs instead is to stop
  // being invisible, and the age of the oldest unapplied one says it.
  assert.deepEqual(reportedIncidents, ["CHAT_COST_ADJUSTMENT_BACKLOG"]);
});

test("a backlog inside one run is not yet an incident", async () => {
  reset();
  costAdjustmentBacklogPending = 2;
  costAdjustmentBacklogOldestMs = 5 * 60 * 1000;

  const { cleanupExpiredData } = await load();
  await cleanupExpiredData();

  // One run failing to apply a delta is a blip; the alert is for a pattern.
  assert.deepEqual(reportedIncidents, []);
});

// The sweep's signals, each with the threshold its meaning earns. Alerting on
// the no-cost total would either shout about instrumentation-only runs or stay
// silent about a writer that stopped recording intents.

test("an instrumentation-only run is not a signal", async () => {
  reset();
  sweepNoCostReasons.no_reservation = 12;

  const { cleanupExpiredData } = await load();
  const result = await cleanupExpiredData();

  assert.equal(result.staleRoutingAttempts?.closedCostInserted, 31);
  assert.deepEqual(reportedIncidents, []);
});

test("legacy payloads age out quietly; a post-cutover one does not", async () => {
  reset();
  sweepNoCostReasons.legacy_missing_cost_intent = 40;
  const { cleanupExpiredData } = await load();
  await cleanupExpiredData();
  assert.deepEqual(reportedIncidents, [], "history is not a defect");

  reset();
  // Written after cost intents existed and carrying none: the writer that was
  // supposed to record one did not, and no grace period applies.
  sweepNoCostReasons.missing_cost_intent = 1;
  await (await load()).cleanupExpiredData();
  assert.deepEqual(reportedIncidents, ["CHAT_COST_INTENT_UNAVAILABLE"]);
});

test("a dangling reservation and an unreadable payload are each immediate", async () => {
  for (const reason of ["dangling_reservation", "invalid_cost_intent_payload"] as const) {
    reset();
    sweepNoCostReasons[reason] = 1;
    await (await load()).cleanupExpiredData();
    assert.deepEqual(reportedIncidents, ["CHAT_COST_INTENT_UNAVAILABLE"], reason);
  }
});

test("an unset cutover reports itself rather than answering legacy", async () => {
  reset();
  sweepNoCostReasons.unclassified_missing_cost_intent = 3;
  await (await load()).cleanupExpiredData();
  assert.deepEqual(reportedIncidents, ["CHAT_COST_INTENT_CUTOVER_UNSET"]);
});

test("an outcome the sweep cannot produce is an incident on the first one", async () => {
  reset();
  sweepUnexpectedOutcome = 1;
  await (await load()).cleanupExpiredData();
  assert.deepEqual(reportedIncidents, ["CHAT_COST_SWEEP_UNEXPECTED_OUTCOME"]);
});

test("the backlog alarms on what the sweep would act on, not on what is merely old", async () => {
  // A deep-research turn legitimately streaming past the stale window is aged
  // and not eligible. Alarming on age alone would fire on healthy traffic.
  reset();
  sweepAgedPending = 5_000;
  sweepEligiblePending = 0;
  await (await load()).cleanupExpiredData();
  assert.deepEqual(reportedIncidents, []);

  // More eligible than one batch can take.
  reset();
  sweepEligiblePending = 201;
  await (await load()).cleanupExpiredData();
  assert.deepEqual(reportedIncidents, ["CHAT_ATTEMPT_SWEEP_BACKLOG"]);

  // Or one that has been eligible longer than the stale window plus two runs.
  reset();
  sweepEligiblePending = 1;
  sweepOldestEligibleMs = 61 * 60 * 1000;
  await (await load()).cleanupExpiredData();
  assert.deepEqual(reportedIncidents, ["CHAT_ATTEMPT_SWEEP_BACKLOG"]);
});

test("a turn that authorized nothing is reported by model and never paged", async () => {
  // These attempts get a cost row -- a ceiling of zero is a real audit record
  // -- so nothing is missing and nothing is paged. What the run does say is
  // which model it was, because a free model and a price an administrator
  // flattened to zero are the same thing from inside the sweep.
  reset();
  sweepZeroReservedCostModels = { "openai/some-free-model": 25 };
  const quiet = await (await load()).cleanupExpiredData();
  assert.deepEqual(reportedIncidents, []);
  assert.deepEqual(quiet.staleRoutingAttempts?.zeroReservedCostModels, {
    "openai/some-free-model": 25,
  });
});

test("an intent naming a model the attempt did not run is an incident", async () => {
  reset();
  sweepNoCostReasons.cost_intent_identity_mismatch = 1;
  await (await load()).cleanupExpiredData();
  assert.deepEqual(reportedIncidents, ["CHAT_COST_INTENT_UNAVAILABLE"]);
});
