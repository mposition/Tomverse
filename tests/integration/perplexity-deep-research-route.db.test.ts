import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";

// Financial + persistence contract for the one model that submits work to a
// provider and settles it later: perplexity/sonar-deep-research.
//
// POST /api/chat reserves credits, submits the job, and persists a pending
// Message + PerplexityAsyncJob; POST /api/chat/deep-research/status finalizes
// both and settles or refunds the reservation. Every failure mode in between
// has to leave money and rows consistent, so these drive the REAL route
// handlers against a real PostgreSQL and mock nothing but the session and
// Perplexity's own HTTP endpoint.
//
// Runs under scripts/run-db-integration-tests.mjs in its own process:
// mock.module is process-global, and this file replaces next-auth for every
// module that imports it.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

const DEEP_RESEARCH_MODEL_ID = "perplexity/sonar-deep-research";
const PERPLEXITY_SUBMIT_URL = "https://api.perplexity.ai/v1/async/sonar";

process.env.PERPLEXITY_API_KEY ||= "db-integration-test-key";

// --- session seam ----------------------------------------------------------
let sessionOverride: unknown = null;
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => sessionOverride },
});

// --- Perplexity HTTP seam --------------------------------------------------
type PerplexityCall = {
  method: string;
  url: string;
  body: { request?: { messages?: Array<{ role: string; content: string }> } } | null;
};

type ScriptedResponse = { status?: number; json?: unknown; text?: string };

let perplexityCalls: PerplexityCall[] = [];
let submitScript: ScriptedResponse[] = [];
let pollScript: ScriptedResponse[] = [];
let otherHostCalls: string[] = [];

const scriptedResponse = (scripted: ScriptedResponse | undefined) => {
  const status = scripted?.status ?? 200;
  const body =
    scripted?.text ?? JSON.stringify(scripted?.json ?? { status: "IN_PROGRESS" });
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

const shift = (script: ScriptedResponse[]) =>
  script.length > 1 ? script.shift()! : script[0]!;

/**
 * Holds every poll inside Perplexity's own HTTP call until `count` of them
 * have arrived.
 *
 * The route reads the job row, takes the already-finalized early return if it
 * can, and only then talks to Perplexity. So a barrier here is a barrier on
 * "both requests have read pre-finalize state" -- which is the interleaving
 * the claim path exists for, and the one a bare `Promise.all` reaches only
 * when the scheduler happens to cooperate.
 */
let pollBarrier: {
  arrive: () => Promise<void>;
  arrived: number;
} | null = null;

const armPollBarrier = (count: number) => {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const barrier = {
    arrived: 0,
    arrive: async () => {
      barrier.arrived += 1;
      if (barrier.arrived >= count) release();
      await opened;
    },
  };
  pollBarrier = barrier;
  return barrier;
};

// Nothing in this suite may reach the network. Perplexity is scripted; any
// other host (a monitoring webhook, say) gets an inert 204 and is recorded.
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : String((input as Request).url);
  const method = (init?.method || "GET").toUpperCase();

  if (!url.startsWith("https://api.perplexity.ai/")) {
    otherHostCalls.push(url);
    return new Response(null, { status: 204 });
  }

  perplexityCalls.push({
    method,
    url,
    body: init?.body ? JSON.parse(String(init.body)) : null,
  });
  if (url !== PERPLEXITY_SUBMIT_URL && pollBarrier) await pollBarrier.arrive();
  return scriptedResponse(url === PERPLEXITY_SUBMIT_URL ? shift(submitScript) : shift(pollScript));
}) as typeof fetch;

// --- structured log capture ------------------------------------------------
// The route's failure diagnostics are JSON on console.error; scenario D reads
// them back to prove an already-submitted provider job stays identifiable.
let capturedLogs: string[] = [];
const realConsoleError = console.error;
console.error = (...args: unknown[]) => {
  capturedLogs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
};

// Imported inside before(), not at the top: the mocks above have to be in
// place before the route modules (and their next-auth import) are evaluated.
type RouteModule = { POST: (request: Request) => Promise<Response> };
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let buildChatTurnContext: (typeof import("@/lib/chatTurnContext"))["buildChatTurnContext"];
let issueChatContextBundle: (typeof import("@/lib/chatContextBundleService"))["issueChatContextBundle"];
let chatRoute: RouteModule;
let statusRoute: RouteModule;
let deepResearchSettlement: typeof import("@/lib/deepResearchSettlement");
let chatSecurity: typeof import("@/lib/chatSecurity");

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  chatRoute = (await import(mod("app/api/chat/route.ts"))) as RouteModule;
  statusRoute = (await import(
    mod("app/api/chat/deep-research/status/route.ts")
  )) as RouteModule;
  ({ buildChatTurnContext } = (await import(
    mod("lib/chatTurnContext.ts")
  )) as typeof import("@/lib/chatTurnContext"));
  ({ issueChatContextBundle } = (await import(
    mod("lib/chatContextBundleService.ts")
  )) as typeof import("@/lib/chatContextBundleService"));
  deepResearchSettlement = (await import(
    mod("lib/deepResearchSettlement.ts")
  )) as typeof import("@/lib/deepResearchSettlement");
  chatSecurity = (await import(
    mod("lib/chatSecurity.ts")
  )) as typeof import("@/lib/chatSecurity");
});

const resetDeepResearchTestData = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ProviderErrorEvent",
      "ProviderDailyUsage",
      "ProductAnalyticsEvent",
      "PerplexityAsyncJob",
      "ChatCreditReservation",
      "ChatRequestLease",
      "ChatUsageBucket",
      "CreditDebtEntry",
      "CreditLedgerEntry",
      "CreditLot",
      "Message",
      "Conversation",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await resetDeepResearchTestData();
  perplexityCalls = [];
  otherHostCalls = [];
  capturedLogs = [];
  submitScript = [{ json: { id: `pplx-${randomUUID()}`, status: "CREATED" } }];
  pollScript = [{ json: { status: "IN_PROGRESS" } }];
  sessionOverride = null;
  pollBarrier = null;
});

afterEach(() => {
  assert.deepEqual(otherHostCalls, [], "a test reached an unexpected host");
});

after(async () => {
  console.error = realConsoleError;
  await resetDeepResearchTestData();
  await prisma.$disconnect();
});

// --- fixtures --------------------------------------------------------------
const seedProUser = async () => {
  const user = await prisma.user.create({
    data: {
      email: `deep-research-${randomUUID()}@example.test`,
      plan: "Pro",
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  sessionOverride = { user: { id: user.id, email: user.email } };
  return user;
};

const seedConversation = (userId: string) =>
  prisma.conversation.create({
    data: {
      userId,
      title: "Deep research integration",
      selectedModels: JSON.stringify([DEEP_RESEARCH_MODEL_ID]),
    },
  });

const submitDeepResearch = async (
  conversationId: string,
  options: {
    assistantMessageId?: string;
    messages?: Array<{ role: "user" | "assistant"; content: string }>;
    contextBundle?: string;
  } = {}
) => {
  const assistantMessageId = options.assistantMessageId ?? randomUUID();
  const response = await chatRoute.POST(
    new Request("http://127.0.0.1:3100/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: options.messages ?? [
          { role: "user", content: "2026년 전고체 배터리 시장을 조사해줘" },
        ],
        modelId: DEEP_RESEARCH_MODEL_ID,
        conversationId,
        assistantMessageId,
        deepResearchDepth: "standard",
        ...(options.contextBundle
          ? { contextBundle: options.contextBundle }
          : {}),
      }),
    })
  );
  return { assistantMessageId, response };
};

const pollStatus = (assistantMessageId: string) =>
  statusRoute.POST(
    new Request("http://127.0.0.1:3100/api/chat/deep-research/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assistantMessageId }),
    })
  );

const perplexitySubmitCalls = () =>
  perplexityCalls.filter((call) => call.url === PERPLEXITY_SUBMIT_URL);

const onlyReservation = async () => {
  const reservations = await prisma.chatCreditReservation.findMany();
  assert.equal(reservations.length, 1, "expected exactly one credit reservation");
  return reservations[0]!;
};

/**
 * Every accounting bucket, as a comparable snapshot -- the credit ledger's
 * shape. ChatUsageBucket also stores per-request API rate-limit counters
 * ("api:<hash>" keys, see lib/apiSecurity.ts); those legitimately move on
 * every poll, so they are excluded rather than masking a real double-charge.
 */
const usageBucketSnapshot = async () =>
  (
    await prisma.chatUsageBucket.findMany({
      where: { NOT: { key: { startsWith: "api:" } } },
      orderBy: [{ key: "asc" }, { period: "asc" }, { periodStart: "asc" }],
      select: { key: true, period: true, count: true },
    })
  ).map((row) => `${row.key}|${row.period}|${row.count}`);

/**
 * Credits currently counted against the caller, read the way the product
 * reads them: the reservation records exactly which usage buckets it charged
 * (lib/chatSecurity.ts), and /api/user/usage subtracts those same bucket
 * counts from the plan allowance. A refund therefore has to bring them back
 * to zero, not merely flip the reservation's own status column.
 */
const chargedCredits = async (reservationId: string) => {
  const durable = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: reservationId },
  });
  const entries = (
    durable.reservationPayload as unknown as {
      entries: Array<{ key: string; period: string; periodStart: string; metric: string }>;
    }
  ).entries.filter(
    (entry) => entry.metric === "credits" || entry.metric === "plan-credits"
  );
  assert.ok(entries.length > 0, "the reservation charged no credit bucket at all");
  const counts = await Promise.all(
    entries.map(async (entry) => {
      const row = await prisma.chatUsageBucket.findUnique({
        where: {
          key_period_periodStart: {
            key: entry.key,
            period: entry.period,
            periodStart: new Date(entry.periodStart),
          },
        },
        select: { count: true },
      });
      return usageBucketCount(row?.count);
    })
  );
  return Math.max(...counts);
};

const failureCounters = async () => ({
  provider: await prisma.chatUsageBucket.count({
    where: { key: { contains: ":failure" } },
  }),
  errorEvents: await prisma.providerErrorEvent.count(),
});

// --- A. local message-contract rejection -----------------------------------
test("a request with no usable user turn is refused locally: no provider call, full refund, no rows", async () => {
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);

  const { assistantMessageId, response } = await submitDeepResearch(conversation.id, {
    // Exactly the shape the welcome-bubble regression produced, plus an
    // empty user turn so nothing survives normalization.
    messages: [
      { role: "assistant", content: "Hello! How can I help you today?" },
      { role: "user", content: "   " },
    ],
  });

  assert.equal(response.status, 400);
  const payload = (await response.json()) as { code?: string; traceId?: string };
  assert.equal(payload.code, "DEEP_RESEARCH_INVALID_MESSAGES");
  assert.ok(payload.traceId, "the error response carries a trace id");

  assert.equal(perplexitySubmitCalls().length, 0, "Perplexity was called");

  const reservation = await onlyReservation();
  assert.equal(reservation.status, "refunded");
  assert.equal(reservation.outcome, "failed");
  assert.equal(reservation.settledCredits, 0);
  assert.equal(reservation.settledCostMicroUsd, BigInt(0));
  assert.ok(reservation.reservedCredits > 0, "credits really were reserved first");
  assert.equal(
    await chargedCredits(reservation.id),
    0,
    "reserved credits were not returned to the user's usage buckets"
  );

  assert.equal(await prisma.message.count({ where: { id: assistantMessageId } }), 0);
  assert.equal(await prisma.perplexityAsyncJob.count(), 0);

  const counters = await failureCounters();
  assert.equal(counters.provider, 0, "a local bug was counted as a provider failure");
  assert.equal(counters.errorEvents, 0, "a local bug raised a provider error event");
});

// --- B. provider submit failure --------------------------------------------
test("a Perplexity submit failure refunds in full, leaves no rows, and counts one provider failure", async () => {
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  submitScript = [
    {
      status: 400,
      text: JSON.stringify({
        error: {
          message:
            "After the (optional) system message(s), user or tool message(s) should alternate with assistant message(s).",
          type: "invalid_message",
          code: 400,
        },
      }),
    },
  ];

  const { assistantMessageId, response } = await submitDeepResearch(conversation.id);

  assert.equal(response.status, 502);
  const payload = (await response.json()) as { code?: string; traceId?: string };
  assert.equal(payload.code, "DEEP_RESEARCH_SUBMIT_FAILED");
  assert.ok(payload.traceId);

  assert.equal(perplexitySubmitCalls().length, 1);

  const reservation = await onlyReservation();
  assert.equal(reservation.status, "refunded");
  assert.equal(reservation.outcome, "failed");
  assert.equal(reservation.settledCredits, 0);
  assert.equal(reservation.settledCostMicroUsd, BigInt(0));
  assert.equal(await chargedCredits(reservation.id), 0);

  assert.equal(await prisma.message.count({ where: { id: assistantMessageId } }), 0);
  assert.equal(await prisma.perplexityAsyncJob.count(), 0);

  const errorEvents = await prisma.providerErrorEvent.findMany();
  assert.equal(errorEvents.length, 1, "expected exactly one provider error event");
  assert.equal(errorEvents[0]!.provider, "perplexity");
  assert.equal(errorEvents[0]!.diagnosticCode, "DEEP_RESEARCH_SUBMIT_FAILED");
  // One failure, counted once in each health window (day / 5m) -- never twice
  // in the same window.
  for (const key of [
    "provider:perplexity:failure",
    `model:${DEEP_RESEARCH_MODEL_ID}:failure`,
  ]) {
    const buckets = await prisma.chatUsageBucket.findMany({
      where: { key },
      select: { period: true, count: true },
    });
    assert.ok(buckets.length > 0, `${key} was never counted`);
    for (const bucket of buckets) {
      assert.equal(
        usageBucketCount(bucket.count),
        1,
        `${key} counted ${bucket.count} failures in ${bucket.period}`
      );
    }
  }
});

// --- C. submit success ------------------------------------------------------
test("a successful submit persists the pending Message and the job together, reservation still reserved", async () => {
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  const perplexityJobId = `pplx-${randomUUID()}`;
  submitScript = [{ json: { id: perplexityJobId, status: "CREATED" } }];

  const { assistantMessageId, response } = await submitDeepResearch(conversation.id);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Chat-Response-Mode"), "async-job");
  assert.ok(response.headers.get("X-Request-ID"));
  const payload = (await response.json()) as {
    deepResearchJobId?: string;
    status?: string;
  };
  assert.equal(payload.deepResearchJobId, assistantMessageId);
  assert.equal(payload.status, "submitted");

  // The submitted conversation satisfied Perplexity's contract.
  const submitted = perplexitySubmitCalls();
  assert.equal(submitted.length, 1);
  const sentMessages = submitted[0]!.body?.request?.messages ?? [];
  assert.deepEqual(
    sentMessages.map((message) => message.role),
    ["user"]
  );

  const message = await prisma.message.findUniqueOrThrow({
    where: { id: assistantMessageId },
  });
  assert.equal(message.role, "assistant");
  assert.equal(message.status, "pending");
  assert.equal(message.pendingJobId, perplexityJobId);
  assert.equal(message.conversationId, conversation.id);

  const job = await prisma.perplexityAsyncJob.findUniqueOrThrow({
    where: { assistantMessageId },
  });
  assert.equal(job.perplexityJobId, perplexityJobId);
  assert.equal(job.status, "submitted");
  assert.equal(job.conversationId, conversation.id);
  assert.equal(job.modelId, DEEP_RESEARCH_MODEL_ID);

  const reservation = await onlyReservation();
  assert.equal(reservation.status, "reserved");
  assert.equal(reservation.settledCredits, 0);
  assert.equal(reservation.providerRequestId, perplexityJobId);
  assert.equal(job.reservationId, reservation.id);
  assert.equal(
    await chargedCredits(reservation.id),
    reservation.reservedCredits,
    "credits must stay held while the job runs"
  );

  // Neither row exists without the other: the pair is all-or-nothing.
  assert.equal(await prisma.message.count({ where: { status: "pending" } }), 1);
  assert.equal(await prisma.perplexityAsyncJob.count(), 1);
});

// --- D. persistence failure after a successful submit ----------------------
test("a post-submit transaction failure refunds, writes no job row, and keeps the provider job id identifiable", async () => {
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  const perplexityJobId = `pplx-${randomUUID()}`;
  submitScript = [{ json: { id: perplexityJobId, status: "CREATED" } }];

  // A deterministic, safe way to fail the persistence transaction: the
  // assistant message id is already taken, so tx.message.create violates the
  // primary key after Perplexity has already accepted the job.
  const assistantMessageId = randomUUID();
  await prisma.message.create({
    data: {
      id: assistantMessageId,
      conversationId: conversation.id,
      role: "assistant",
      content: "Pre-existing row",
      status: "normal",
    },
  });

  const { response } = await submitDeepResearch(conversation.id, {
    assistantMessageId,
  });

  assert.equal(response.status, 502);
  const payload = (await response.json()) as { code?: string; traceId?: string };
  assert.ok(payload.traceId, "the error response carries a trace id");

  const reservation = await onlyReservation();
  assert.equal(reservation.status, "refunded");
  assert.equal(reservation.outcome, "failed");
  assert.equal(reservation.settledCredits, 0);
  assert.equal(reservation.settledCostMicroUsd, BigInt(0));
  assert.equal(await chargedCredits(reservation.id), 0);

  assert.equal(await prisma.perplexityAsyncJob.count(), 0, "an orphan job row survived");
  // The pre-existing row is untouched, and no partial pending row was left.
  const message = await prisma.message.findUniqueOrThrow({
    where: { id: assistantMessageId },
  });
  assert.equal(message.content, "Pre-existing row");
  assert.equal(message.status, "normal");
  assert.equal(message.pendingJobId, null);
  assert.equal(await prisma.message.count(), 1);

  // The provider job Perplexity did accept is still traceable from this app:
  // the reservation kept the id, and the failure log names it.
  assert.equal(reservation.providerRequestId, perplexityJobId);
  const submitLog = capturedLogs.find((line) =>
    line.includes("deep_research_submit_failed")
  );
  assert.ok(submitLog, "the submit failure was not logged");
  const parsedLog = JSON.parse(submitLog!) as {
    traceId?: string;
    submittedPerplexityJobId?: string;
    messageShape?: { normalizedRoleSequence?: string };
  };
  assert.equal(parsedLog.traceId, payload.traceId);
  assert.equal(parsedLog.submittedPerplexityJobId, perplexityJobId);
  assert.equal(parsedLog.messageShape?.normalizedRoleSequence, "u");
  assert.ok(
    !submitLog!.includes("전고체"),
    "message content leaked into the failure log"
  );
});

// --- E. completion settles once --------------------------------------------
test("a completed job stores the report and settles the reservation exactly once", async () => {
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  const perplexityJobId = `pplx-${randomUUID()}`;
  submitScript = [{ json: { id: perplexityJobId, status: "CREATED" } }];
  const { assistantMessageId } = await submitDeepResearch(conversation.id);

  // One in-progress poll, then a completed one carrying the provider's own
  // reported cost -- the number the settlement must charge.
  pollScript = [
    { json: { status: "IN_PROGRESS" } },
    {
      json: {
        status: "COMPLETED",
        response: {
          choices: [{ message: { content: "최종 딥리서치 보고서" } }],
          usage: {
            prompt_tokens: 500,
            completion_tokens: 1_200,
            cost: { total_cost: 0.045 },
          },
        },
      },
    },
  ];

  const inProgress = (await (await pollStatus(assistantMessageId)).json()) as {
    status?: string;
  };
  assert.equal(inProgress.status, "in_progress");
  assert.equal(
    (await prisma.perplexityAsyncJob.findUniqueOrThrow({ where: { assistantMessageId } }))
      .status,
    "in_progress"
  );

  const completed = (await (await pollStatus(assistantMessageId)).json()) as {
    status?: string;
    content?: string;
  };
  assert.equal(completed.status, "completed");
  assert.equal(completed.content, "최종 딥리서치 보고서");

  const message = await prisma.message.findUniqueOrThrow({
    where: { id: assistantMessageId },
  });
  assert.equal(message.status, "normal");
  assert.equal(message.content, "최종 딥리서치 보고서");
  assert.equal(message.pendingJobId, null);

  const job = await prisma.perplexityAsyncJob.findUniqueOrThrow({
    where: { assistantMessageId },
  });
  assert.equal(job.status, "completed");
  assert.equal(job.resultText, "최종 딥리서치 보고서");
  assert.ok(job.completedAt);

  const settled = await onlyReservation();
  assert.equal(settled.status, "settled");
  assert.equal(settled.outcome, "completed");
  assert.ok(settled.settledAt);
  assert.ok(settled.settledCredits > 0);
  // 0.045 USD as reported by Perplexity, not a token estimate.
  assert.equal(settled.settledCostMicroUsd, BigInt(45_000));
  assert.equal(settled.settledInputTokens, 500);
  assert.equal(settled.settledOutputTokens, 1_200);
  assert.equal(settled.providerRequestId, perplexityJobId);
  assert.ok(settled.providerUsageSnapshot, "the provider cost snapshot was not stored");

  // A second poll (another tab) must not re-settle or re-charge anything.
  const ledgerAfterFirst = await usageBucketSnapshot();
  const settledAtAfterFirst = settled.settledAt?.toISOString();
  const repeat = (await (await pollStatus(assistantMessageId)).json()) as {
    status?: string;
    content?: string;
  };
  assert.equal(repeat.status, "completed");
  assert.equal(repeat.content, "최종 딥리서치 보고서");

  const afterRepeat = await onlyReservation();
  assert.equal(afterRepeat.settledCredits, settled.settledCredits);
  assert.equal(afterRepeat.settledCostMicroUsd, settled.settledCostMicroUsd);
  assert.equal(afterRepeat.settledAt?.toISOString(), settledAtAfterFirst);
  assert.deepEqual(
    await usageBucketSnapshot(),
    ledgerAfterFirst,
    "a repeat poll moved the credit ledger"
  );
  // The cached terminal state is served without calling Perplexity again.
  assert.equal(
    perplexityCalls.filter((call) => call.method === "GET").length,
    2,
    "a repeat poll re-queried the provider"
  );
});

// --- F. terminal failure paths ---------------------------------------------
for (const scenario of [
  {
    name: "an explicitly FAILED job",
    poll: {
      json: { status: "FAILED", error_message: "The model could not complete this request." },
    },
      expectedMessage: "The Perplexity deep research job failed.",
    diagnosticCode: "DEEP_RESEARCH_JOB_FAILED",
  },
  {
    name: "a COMPLETED job with an empty report",
    poll: { json: { status: "COMPLETED", response: { choices: [] } } },
    expectedMessage: "The deep research job completed with an empty report.",
    diagnosticCode: "AI_EMPTY_RESPONSE",
  },
] as const) {
  test(`${scenario.name} refunds in full and stays idempotent across repeat polls`, async () => {
    const user = await seedProUser();
    const conversation = await seedConversation(user.id);
    const { assistantMessageId } = await submitDeepResearch(conversation.id);
    pollScript = [scenario.poll];

    const failed = (await (await pollStatus(assistantMessageId)).json()) as {
      status?: string;
      error?: string;
    };
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, scenario.expectedMessage);

    const message = await prisma.message.findUniqueOrThrow({
      where: { id: assistantMessageId },
    });
    assert.equal(message.status, "error");
    assert.equal(message.pendingJobId, null);
    const job = await prisma.perplexityAsyncJob.findUniqueOrThrow({
      where: { assistantMessageId },
    });
    assert.equal(job.status, "failed");
    assert.equal(job.errorMessage, scenario.expectedMessage);

    const reservation = await onlyReservation();
    assert.equal(reservation.status, "refunded");
    assert.equal(reservation.settledCredits, 0);
    assert.equal(reservation.settledCostMicroUsd, BigInt(0));
    assert.equal(await chargedCredits(reservation.id), 0);

    const ledgerAfterFirst = await usageBucketSnapshot();
    const failureCountAfterFirst = await failureCounters();

    const repeat = (await (await pollStatus(assistantMessageId)).json()) as {
      status?: string;
    };
    assert.equal(repeat.status, "failed");
    assert.deepEqual(
      await usageBucketSnapshot(),
      ledgerAfterFirst,
      "a repeat poll refunded twice"
    );
    assert.deepEqual(
      await failureCounters(),
      failureCountAfterFirst,
      "a repeat poll counted the same failure twice"
    );
  });
}

// --- G. concurrent terminal polls ------------------------------------------
/* ------------------------------------ exactly-once settlement (issue #1285) */

const COMPLETED_POLL = {
  json: {
    status: "COMPLETED",
    response: {
      choices: [{ message: { content: "동시 폴링 보고서" } }],
      usage: {
        prompt_tokens: 400,
        completion_tokens: 900,
        cost: { total_cost: 0.03 },
      },
    },
  },
};

/** Every reservation this suite would call settled, however it got there. */
const settledReservationCount = () =>
  prisma.chatCreditReservation.count({ where: { status: "settled" } });

/** A sweep pass that found nothing to do -- distinct from one that could not look. */
const emptySweep = () => ({
  examined: 0,
  settled: 0,
  alreadySettled: 0,
  settlementMismatch: 0,
  unreadable: 0,
  missingReservation: 0,
  failed: 0,
  queryFailed: false,
});

test("two concurrent claims settle exactly once, and the loser claims nothing", async () => {
  // Deterministic by construction, not by scheduling luck: the barrier holds
  // both requests inside Perplexity's own call, which the route reaches only
  // after it has read the job and declined the already-finalized early
  // return. Both are therefore provably racing on the claim.
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  submitScript = [{ json: { id: `pplx-${randomUUID()}`, status: "CREATED" } }];
  const { assistantMessageId } = await submitDeepResearch(conversation.id);
  pollScript = [COMPLETED_POLL];

  const barrier = armPollBarrier(2);
  const [first, second] = await Promise.all([
    pollStatus(assistantMessageId).then((response) => response.json()),
    pollStatus(assistantMessageId).then((response) => response.json()),
  ]);
  assert.equal(barrier.arrived, 2, "both polls must have raced the claim");

  const statuses = [first, second]
    .map((payload) => (payload as { status?: string }).status)
    .sort();
  // The CAS decides this one: exactly one poll may win the claim, and the
  // loser is told the job is still running rather than being handed a
  // completion it did not produce.
  assert.deepEqual(statuses, ["completed", "in_progress"]);

  const message = await prisma.message.findUniqueOrThrow({
    where: { id: assistantMessageId },
  });
  assert.equal(message.status, "normal");
  assert.equal(message.content, "동시 폴링 보고서");
  assert.equal(message.pendingJobId, null);

  const job = await prisma.perplexityAsyncJob.findUniqueOrThrow({
    where: { assistantMessageId },
  });
  assert.equal(job.status, "completed");
  assert.equal(job.resultText, "동시 폴링 보고서");

  // What must be exactly once is the settlement, and this is where it is
  // asserted -- on the ledger, not on how many responses said "completed".
  const reservation = await onlyReservation();
  assert.equal(reservation.status, "settled");
  assert.equal(reservation.outcome, "completed");
  // Charged once at the provider's reported cost -- not 60_000.
  assert.equal(reservation.settledCostMicroUsd, BigInt(30_000));
  assert.equal(reservation.settledInputTokens, 400);
  assert.equal(reservation.settledOutputTokens, 900);
  assert.equal(await settledReservationCount(), 1);
  assert.equal(
    await prisma.perplexityAsyncJob.count({ where: { status: "completed" } }),
    1
  );
});

test("a poll that finds an already-finalized job may answer completed, and that is not a claim", async () => {
  // The contract the old assertion got wrong. Two responses saying
  // "completed" is a legal interleaving: the second poll's first read landed
  // after the first had committed, so it answered from the stored outcome.
  // The job *is* completed, so that is the correct answer -- and it settled
  // nothing, which is the part that matters.
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  submitScript = [{ json: { id: `pplx-${randomUUID()}`, status: "CREATED" } }];
  const { assistantMessageId } = await submitDeepResearch(conversation.id);
  pollScript = [COMPLETED_POLL];

  const claimed = await pollStatus(assistantMessageId).then((r) => r.json());
  assert.equal((claimed as { status?: string }).status, "completed");
  const afterClaim = await usageBucketSnapshot();
  const pollsSoFar = perplexityCalls.length;

  const cached = await pollStatus(assistantMessageId).then((r) => r.json());
  assert.equal((cached as { status?: string }).status, "completed");
  assert.equal(
    (cached as { content?: string }).content,
    "동시 폴링 보고서",
    "the cached answer carries the stored report"
  );

  assert.equal(
    perplexityCalls.length,
    pollsSoFar,
    "a cached answer must not call Perplexity again"
  );
  assert.deepEqual(
    await usageBucketSnapshot(),
    afterClaim,
    "a cached answer must not move the ledger"
  );
  assert.equal(await settledReservationCount(), 1);
});

/**
 * Exactly what the route stores for COMPLETED_POLL.
 *
 * Hand-written, and therefore guarded: "a completed poll stores exactly what a
 * later settlement needs" asserts the route's own write deep-equals this. That
 * assertion is the whole reason the constant is safe to reuse below -- the
 * first version of it invented a plausible-looking snapshot, the recovered
 * settlement silently fell back to token pricing, and the reservation settled
 * at 8,000 microUSD instead of the 30,000 Perplexity actually charged. A
 * fixture that describes a column nobody writes is worse than no fixture,
 * because the test still passes.
 */
const COMPLETED_SETTLEMENT_USAGE = {
  outcome: "completed",
  inputTokens: 400,
  outputTokens: 900,
  providerUsageSnapshot: {
    source: "perplexity_response_usage",
    currency: "USD",
    totalCostMicroUsd: 30000,
    inputTokensCostMicroUsd: null,
    outputTokensCostMicroUsd: null,
    reasoningTokensCostMicroUsd: null,
    requestCostMicroUsd: null,
    citationTokensCostMicroUsd: null,
    searchQueriesCostMicroUsd: null,
    promptTokens: 400,
    completionTokens: 900,
    totalTokens: null,
    reasoningTokens: null,
    citationTokens: null,
    searchQueries: null,
    searchContextSize: null,
  },
} as const;

/**
 * The state a process killed between the finalize commit and the settle call
 * leaves behind, written directly because that is the only way to produce it
 * in one process: the transaction really committed, and the settlement really
 * never ran.
 */
const interruptAfterFinalize = async (assistantMessageId: string) => {
  const job = await prisma.perplexityAsyncJob.findUniqueOrThrow({
    where: { assistantMessageId },
  });
  await prisma.$transaction([
    prisma.perplexityAsyncJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        resultText: "중단된 보고서",
        completedAt: new Date(),
        settlementUsage: COMPLETED_SETTLEMENT_USAGE,
      },
    }),
    prisma.message.update({
      where: { id: assistantMessageId },
      data: { content: "중단된 보고서", status: "normal", pendingJobId: null },
    }),
  ]);
  const reservation = await onlyReservation();
  assert.equal(
    reservation.status,
    "reserved",
    "the interrupted state is a finalized job whose reservation never settled"
  );
  return reservation;
};

test("a completed poll stores exactly what a later settlement needs", async () => {
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  submitScript = [{ json: { id: `pplx-${randomUUID()}`, status: "CREATED" } }];
  const { assistantMessageId } = await submitDeepResearch(conversation.id);
  pollScript = [COMPLETED_POLL];
  await pollStatus(assistantMessageId);

  const job = await prisma.perplexityAsyncJob.findUniqueOrThrow({
    where: { assistantMessageId },
  });
  // It has to parse, or a later settlement cannot read it back.
  deepResearchSettlement.deepResearchSettlementUsageSchema.parse(
    job.settlementUsage
  );
  // And it has to be exactly this, because the interruption fixture below
  // reuses the constant. Anything less than equality lets the route change
  // what it stores while the recovery tests keep passing against a shape
  // nothing writes -- which is how a recovered settlement came to price a
  // 30,000 microUSD job at 8,000 from tokens alone.
  assert.deepEqual(job.settlementUsage, COMPLETED_SETTLEMENT_USAGE);
});

test("a settlement interrupted after finalize is completed by the next poll, exactly once", async () => {
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  submitScript = [{ json: { id: `pplx-${randomUUID()}`, status: "CREATED" } }];
  const { assistantMessageId } = await submitDeepResearch(conversation.id);
  await interruptAfterFinalize(assistantMessageId);
  const pollsSoFar = perplexityCalls.length;

  const recovered = await pollStatus(assistantMessageId).then((r) => r.json());
  assert.equal((recovered as { status?: string }).status, "completed");
  assert.equal(
    perplexityCalls.length,
    pollsSoFar,
    "recovery reads the stored usage; it must not re-poll a finished job"
  );

  const settled = await onlyReservation();
  assert.equal(settled.status, "settled");
  assert.equal(settled.outcome, "completed");
  assert.equal(settled.settledCostMicroUsd, BigInt(30_000));
  assert.equal(settled.settledInputTokens, 400);
  assert.equal(settled.settledOutputTokens, 900);
  assert.equal(await settledReservationCount(), 1);

  // The count, not just the eventual shape: a second poll must find nothing
  // to do rather than charging the account again.
  const afterRecovery = await usageBucketSnapshot();
  await pollStatus(assistantMessageId);
  await pollStatus(assistantMessageId);
  assert.deepEqual(await usageBucketSnapshot(), afterRecovery);
  assert.equal(await settledReservationCount(), 1);
});

test("the maintenance sweep completes an interrupted settlement nobody polled again", async () => {
  // The tab was closed. Without the sweep this reservation sits `reserved`
  // until it expires, and the expiry reconciliation refunds a job that really
  // ran at Perplexity.
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  submitScript = [{ json: { id: `pplx-${randomUUID()}`, status: "CREATED" } }];
  const { assistantMessageId } = await submitDeepResearch(conversation.id);
  await interruptAfterFinalize(assistantMessageId);

  // Inside the grace window the sweep leaves it alone: a job finalized
  // seconds ago is probably being settled by the poll that finalized it.
  assert.deepEqual(
    await deepResearchSettlement.reconcileUnsettledDeepResearchSettlements(),
    emptySweep()
  );
  assert.equal((await onlyReservation()).status, "reserved");

  const past = new Date(
    Date.now() - deepResearchSettlement.DEEP_RESEARCH_SETTLEMENT_GRACE_MS - 1_000
  );
  await prisma.perplexityAsyncJob.updateMany({
    where: { assistantMessageId },
    data: { completedAt: past },
  });

  assert.deepEqual(
    await deepResearchSettlement.reconcileUnsettledDeepResearchSettlements(),
    { ...emptySweep(), examined: 1, settled: 1 }
  );
  const settled = await onlyReservation();
  assert.equal(settled.status, "settled");
  assert.equal(settled.settledCostMicroUsd, BigInt(30_000));

  // And the settled job leaves the work list entirely rather than being
  // re-examined every pass. That is what keeps the sweep from starving:
  // the backlog is "reservations still reserved", not "jobs with a handoff".
  const afterSweep = await usageBucketSnapshot();
  assert.deepEqual(
    await deepResearchSettlement.reconcileUnsettledDeepResearchSettlements(),
    emptySweep()
  );
  assert.deepEqual(await usageBucketSnapshot(), afterSweep);
  assert.equal(await settledReservationCount(), 1);
});

test("an interrupted deep research job is settled at its real cost, not refunded by the expiry sweep", async () => {
  // The money assertion. Both sweeps would act on this reservation and they
  // disagree: this one settles it at what Perplexity charged, the expiry one
  // refunds it in full. The maintenance pass runs them in the order that
  // makes the true cost win, and this proves the order is the one that
  // matters rather than an incidental line ordering.
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  submitScript = [{ json: { id: `pplx-${randomUUID()}`, status: "CREATED" } }];
  const { assistantMessageId } = await submitDeepResearch(conversation.id);
  const reservation = await interruptAfterFinalize(assistantMessageId);

  const past = new Date(
    Date.now() - deepResearchSettlement.DEEP_RESEARCH_SETTLEMENT_GRACE_MS - 1_000
  );
  await prisma.perplexityAsyncJob.updateMany({
    where: { assistantMessageId },
    data: { completedAt: past },
  });
  // Expired: the refund sweep would take it on its next pass.
  await prisma.chatCreditReservation.update({
    where: { id: reservation.id },
    data: { expiresAt: past },
  });

  await deepResearchSettlement.reconcileUnsettledDeepResearchSettlements();
  const reconcileResult =
    await chatSecurity.reconcileExpiredChatCreditReservations();

  const settled = await onlyReservation();
  assert.equal(settled.status, "settled");
  assert.equal(
    settled.outcome,
    "completed",
    "a job that really ran must not end up refunded as a failure"
  );
  assert.equal(settled.settledCostMicroUsd, BigInt(30_000));
  assert.equal(settled.settledInputTokens, 400);
  assert.equal(settled.settledOutputTokens, 900);
  assert.equal(
    reconcileResult.refunded,
    0,
    "the expiry sweep must find nothing left to refund"
  );
});

test("the sweep will not invent a settlement for a job finalized before the column existed", async () => {
  // Migration reality: every row that predates `settlementUsage` holds NULL.
  // Whatever happened to those reservations has already happened, and
  // guessing their token counts would be writing a charge nobody measured.
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  submitScript = [{ json: { id: `pplx-${randomUUID()}`, status: "CREATED" } }];
  const { assistantMessageId } = await submitDeepResearch(conversation.id);
  await interruptAfterFinalize(assistantMessageId);
  await prisma.perplexityAsyncJob.updateMany({
    where: { assistantMessageId },
    data: {
      settlementUsage: Prisma.DbNull,
      completedAt: new Date(
        Date.now() -
          deepResearchSettlement.DEEP_RESEARCH_SETTLEMENT_GRACE_MS -
          1_000
      ),
    },
  });

  assert.deepEqual(
    await deepResearchSettlement.reconcileUnsettledDeepResearchSettlements(),
    emptySweep()
  );
  assert.equal((await onlyReservation()).status, "reserved");

  // And a poll on such a job still answers correctly -- it just has nothing
  // to settle from.
  const answered = await pollStatus(assistantMessageId).then((r) => r.json());
  assert.equal((answered as { status?: string }).status, "completed");
  assert.equal((await onlyReservation()).status, "reserved");
});

test("a settled backlog cannot starve the sweep out of reaching an unsettled job", async () => {
  // The starvation this query shape exists to prevent. A settled job keeps its
  // handoff -- it is evidence, not a queue token -- so a work list of "terminal
  // jobs with a handoff, oldest first" would return the same long-settled rows
  // every pass. Past `take`, the oldest N settled jobs starve every unsettled
  // one behind them, forever, while the sweep reports a clean pass.
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);

  // One real unsettled debt, made the OLDEST so that a job-only query would
  // still find it -- and then buried under more settled rows than the limit,
  // which is the case a job-only query cannot survive.
  submitScript = [{ json: { id: `pplx-${randomUUID()}`, status: "CREATED" } }];
  const { assistantMessageId } = await submitDeepResearch(conversation.id);
  const debt = await interruptAfterFinalize(assistantMessageId);
  const oldest = new Date(Date.now() - 86_400_000);
  await prisma.perplexityAsyncJob.updateMany({
    where: { assistantMessageId },
    data: { completedAt: oldest },
  });

  // 200 already-settled jobs, all newer than the debt. Written directly:
  // driving 200 requests through the route would take minutes and prove
  // nothing this does not.
  const noise = Array.from({ length: 200 }, (_, index) => index);
  await prisma.chatCreditReservation.createMany({
    data: noise.map((index) => ({
      id: `noise-reservation-${index}`,
      userId: user.id,
      subjectKey: `noise-${index}`,
      traceId: `noise-trace-${index}`,
      source: "chat",
      provider: "perplexity",
      modelId: DEEP_RESEARCH_MODEL_ID,
      status: "settled",
      outcome: "completed",
      idempotencyKey: `noise-idempotency-${index}`,
      reservationPayload: {},
      reservedCredits: 0,
      reservedCostMicroUsd: BigInt(0),
      planReservedCredits: 0,
      addOnReservedCredits: 0,
      expiresAt: new Date(Date.now() + 3_600_000),
    })),
  });
  await prisma.perplexityAsyncJob.createMany({
    data: noise.map((index) => ({
      perplexityJobId: `noise-pplx-${index}`,
      conversationId: conversation.id,
      assistantMessageId: `noise-message-${index}`,
      modelId: DEEP_RESEARCH_MODEL_ID,
      reservationId: `noise-reservation-${index}`,
      traceId: `noise-trace-${index}`,
      status: "completed",
      settlementUsage: COMPLETED_SETTLEMENT_USAGE,
      completedAt: new Date(oldest.getTime() + 1_000 + index),
    })),
  });

  // The default limit is 200, so a job-only work list would be entirely noise.
  const swept =
    await deepResearchSettlement.reconcileUnsettledDeepResearchSettlements();
  assert.deepEqual(
    swept,
    { ...emptySweep(), examined: 1, settled: 1 },
    "the sweep must see the one real debt and none of the settled noise"
  );

  const recovered = await prisma.chatCreditReservation.findUniqueOrThrow({
    where: { id: debt.id },
  });
  assert.equal(recovered.status, "settled");
  assert.equal(recovered.outcome, "completed");
  assert.equal(recovered.settledCostMicroUsd, BigInt(30_000));
});

test("the expiry sweep settles an interrupted job at its real cost even when it gets there first", async () => {
  // Ordering is a preference, not a mechanism: lib/maintenance.ts calls the
  // expiry reconciliation on its own, and startScheduledJob records a run
  // rather than holding a lock. So the guarantee cannot live in the order the
  // fifteen-minute route happens to use -- it has to live in the expiry sweep
  // itself, which is what this drives: the deep research sweep never runs.
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  submitScript = [{ json: { id: `pplx-${randomUUID()}`, status: "CREATED" } }];
  const { assistantMessageId } = await submitDeepResearch(conversation.id);
  const reservation = await interruptAfterFinalize(assistantMessageId);
  await prisma.chatCreditReservation.update({
    where: { id: reservation.id },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });

  const result = await chatSecurity.reconcileExpiredChatCreditReservations();
  assert.equal(
    result.refunded,
    0,
    "a job that really ran must never be refunded by the expiry sweep"
  );
  assert.equal(result.settledFromHandoff, 1);

  const settled = await onlyReservation();
  assert.equal(settled.status, "settled");
  assert.equal(settled.outcome, "completed");
  assert.equal(settled.settledCostMicroUsd, BigInt(30_000));
  assert.equal(settled.settledInputTokens, 400);
  assert.equal(settled.settledOutputTokens, 900);
});

test("an expired reservation with no deep research handoff is still refunded", async () => {
  // The other half of the branch above: the handoff lookup must not turn the
  // expiry sweep into something that stops refunding ordinary stuck turns.
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  submitScript = [{ json: { id: `pplx-${randomUUID()}`, status: "CREATED" } }];
  await submitDeepResearch(conversation.id);
  const reservation = await onlyReservation();
  assert.equal(reservation.status, "reserved");
  await prisma.chatCreditReservation.update({
    where: { id: reservation.id },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });

  const result = await chatSecurity.reconcileExpiredChatCreditReservations();
  assert.equal(result.refunded, 1);
  assert.equal(result.settledFromHandoff, 0);
  assert.equal((await onlyReservation()).status, "refunded");
});

test("a settlement recovery that cannot read its own stored usage is reported, not counted as done", async () => {
  // "examined 0, failed 0" and "nothing to do" must never be the same answer.
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  submitScript = [{ json: { id: `pplx-${randomUUID()}`, status: "CREATED" } }];
  const { assistantMessageId } = await submitDeepResearch(conversation.id);
  await interruptAfterFinalize(assistantMessageId);
  await prisma.perplexityAsyncJob.updateMany({
    where: { assistantMessageId },
    data: {
      settlementUsage: { outcome: "not-an-outcome" },
      completedAt: new Date(
        Date.now() -
          deepResearchSettlement.DEEP_RESEARCH_SETTLEMENT_GRACE_MS -
          1_000
      ),
    },
  });

  assert.deepEqual(
    await deepResearchSettlement.reconcileUnsettledDeepResearchSettlements(),
    { ...emptySweep(), examined: 1, unreadable: 1 },
    "an unreadable handoff is its own outcome, not a silent success"
  );
  assert.equal(
    (await onlyReservation()).status,
    "reserved",
    "and nothing is settled from a payload nobody can read"
  );

  // The expiry sweep refuses to price it too, and refunds rather than
  // guessing -- which is the conservative direction when the record of what
  // the job cost is unreadable.
  const reservation = await onlyReservation();
  await prisma.chatCreditReservation.update({
    where: { id: reservation.id },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });
  const result = await chatSecurity.reconcileExpiredChatCreditReservations();
  assert.equal(result.settledFromHandoff, 0);
  assert.equal(result.refunded, 1);
});

test("a reservation already refunded by the old behaviour is reported as a mismatch, not as settled", async () => {
  // The damage this fix arrives too late for: rows that a pre-fix deployment
  // already refunded for work that really ran. Nothing here can undo one --
  // re-settling a terminal reservation is exactly what the lock forbids -- so
  // the requirement is that it is countable rather than folded into the
  // "somebody else settled it" case and invisible.
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  submitScript = [{ json: { id: `pplx-${randomUUID()}`, status: "CREATED" } }];
  const { assistantMessageId } = await submitDeepResearch(conversation.id);
  const reservation = await interruptAfterFinalize(assistantMessageId);
  await prisma.perplexityAsyncJob.updateMany({
    where: { assistantMessageId },
    data: {
      completedAt: new Date(
        Date.now() -
          deepResearchSettlement.DEEP_RESEARCH_SETTLEMENT_GRACE_MS -
          1_000
      ),
    },
  });
  // Exactly what the pre-fix expiry sweep left behind.
  await prisma.chatCreditReservation.update({
    where: { id: reservation.id },
    data: { status: "refunded", outcome: "failed", settledAt: new Date() },
  });

  const job = await prisma.perplexityAsyncJob.findFirstOrThrow({
    where: { assistantMessageId },
  });
  assert.deepEqual(await deepResearchSettlement.settleDeepResearchJob(job), {
    kind: "settlement_mismatch",
    storedOutcome: "completed",
    reservationOutcome: "failed",
  });

  // The sweep's work list is reservations still `reserved`, so a row already
  // refunded is out of scope for it -- the mismatch surfaces where the job is
  // looked at directly, which is the poll path.
  assert.deepEqual(
    await deepResearchSettlement.reconcileUnsettledDeepResearchSettlements(),
    emptySweep()
  );
});

/* -------------------------------------------------- §22 memory attribution */

const persistedAnswer = (assistantMessageId: string) =>
  prisma.message.findUnique({
    where: { id: assistantMessageId },
    select: { memoryUsedCount: true, memoryTokens: true },
  });

test("an answer with no context bundle records no memory attribution", async () => {
  // NULL is the honest reading: memory was never possible for this request.
  // §22's injection ratio depends on it being distinguishable from an answer
  // that could have carried memory and did not.
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);

  const { assistantMessageId, response } = await submitDeepResearch(
    conversation.id
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await persistedAnswer(assistantMessageId), {
    memoryUsedCount: null,
    memoryTokens: null,
  });
});

test("an answer that carried a bundle records zero, not nothing", async () => {
  // The distinction the whole metric rests on. A verified bundle whose
  // retrieval selected nothing must persist 0 — recording NULL here would
  // move the answer out of the denominator and quietly flatter the ratio.
  //
  // Injection is gated off today (no approved §12.4 pair), so the context the
  // route builds is the empty one. Issuing the bundle from that same context
  // is what makes it verify: the bundle asserts the context it was priced
  // against, and here that context is "no memory".
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  const prompt = "2026년 전고체 배터리 시장을 조사해줘";
  const context = await buildChatTurnContext({
    userId: user.id,
    query: prompt,
  });
  const bundle = issueChatContextBundle({
    subjectKey: user.id,
    conversationId: conversation.id,
    modelIds: [DEEP_RESEARCH_MODEL_ID],
    context,
  });

  const { assistantMessageId, response } = await submitDeepResearch(
    conversation.id,
    { messages: [{ role: "user", content: prompt }], contextBundle: bundle.token }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await persistedAnswer(assistantMessageId), {
    memoryUsedCount: 0,
    memoryTokens: 0,
  });
});
