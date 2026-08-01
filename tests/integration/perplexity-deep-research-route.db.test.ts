import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
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
let chatRoute: RouteModule;
let statusRoute: RouteModule;

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  chatRoute = (await import(mod("app/api/chat/route.ts"))) as RouteModule;
  statusRoute = (await import(
    mod("app/api/chat/deep-research/status/route.ts")
  )) as RouteModule;
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
test("two concurrent terminal polls settle the job once and agree on the final state", async () => {
  const user = await seedProUser();
  const conversation = await seedConversation(user.id);
  const perplexityJobId = `pplx-${randomUUID()}`;
  submitScript = [{ json: { id: perplexityJobId, status: "CREATED" } }];
  const { assistantMessageId } = await submitDeepResearch(conversation.id);

  pollScript = [
    {
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
    },
  ];

  const [first, second] = await Promise.all([
    pollStatus(assistantMessageId).then((response) => response.json()),
    pollStatus(assistantMessageId).then((response) => response.json()),
  ]);
  const statuses = [first, second].map(
    (payload) => (payload as { status?: string }).status
  );
  assert.equal(
    statuses.filter((status) => status === "completed").length,
    1,
    `exactly one poll may claim the job, saw ${JSON.stringify(statuses)}`
  );

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

  const reservation = await onlyReservation();
  assert.equal(reservation.status, "settled");
  assert.equal(reservation.outcome, "completed");
  // Charged once at the provider's reported cost -- not 60_000.
  assert.equal(reservation.settledCostMicroUsd, BigInt(30_000));
  assert.equal(reservation.settledInputTokens, 400);
  assert.equal(reservation.settledOutputTokens, 900);
  assert.equal(
    await prisma.chatCreditReservation.count({ where: { status: "settled" } }),
    1
  );
  assert.equal(
    await prisma.perplexityAsyncJob.count({ where: { status: "completed" } }),
    1
  );
});
