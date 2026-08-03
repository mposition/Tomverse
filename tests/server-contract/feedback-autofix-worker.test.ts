import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Contract for the Phase 2 shadow worker (lib/feedbackAutoFixShadow.ts).
 *
 * What must hold:
 *   - fail-closed: the flag off means no reads, no writes, no claims;
 *   - claims are compare-and-swap: a case can be won exactly once, and a
 *     terminal case is never picked up again;
 *   - missing evidence delays with a growing not-before instant instead of
 *     failing, and gives up honestly after the attempt ceiling;
 *   - classification ends in awaiting_human_review (candidate) or ineligible
 *     (everything else) -- never a code change, never a network call when
 *     Sentry reads are not configured;
 *   - the diagnostic summary carries technical facts only.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

type CaseRow = Record<string, unknown> & {
  id: string;
  state: string;
  attemptCount: number;
  leaseExpiresAt: Date | null;
};

type World = {
  cases: CaseRow[];
  feedback: Record<string, Record<string, unknown>>;
  providerEventCount: number;
  limitEventCount: number;
  fetchCalls: number;
};

const freshWorld = (): World => ({
  cases: [],
  feedback: {},
  providerEventCount: 0,
  limitEventCount: 0,
  fetchCalls: 0,
});

let world = freshWorld();
let mocksInstalled = false;

const matchesCaseWhere = (row: CaseRow, where: Record<string, unknown>) => {
  const now = Date.now();
  if (where.id !== undefined && row.id !== where.id) return false;
  if (typeof where.state === "string" && row.state !== where.state) {
    return false;
  }
  if (
    where.state &&
    typeof where.state === "object" &&
    "in" in (where.state as Record<string, unknown>)
  ) {
    const list = (where.state as { in: string[] }).in;
    if (!list.includes(row.state)) return false;
  }
  if (where.leaseExpiresAt !== undefined) {
    const bound = (where.leaseExpiresAt as { lte?: Date }).lte;
    if (bound !== undefined) {
      if (!row.leaseExpiresAt || row.leaseExpiresAt.getTime() > bound.getTime()) {
        return false;
      }
    }
  }
  if (where.attemptCount !== undefined) {
    const bound = (where.attemptCount as { gte?: number }).gte;
    if (bound !== undefined && row.attemptCount < bound) return false;
  }
  if (where.updatedAt !== undefined) {
    const bound = (where.updatedAt as { lt?: Date }).lt;
    if (bound !== undefined) return false; // purge tests use their own rows
  }
  void now;
  return true;
};

const matchesOr = (row: CaseRow, where: Record<string, unknown>) => {
  const clauses = where.OR as Array<Record<string, unknown>> | undefined;
  if (!clauses) return matchesCaseWhere(row, where);
  return clauses.some((clause) => matchesCaseWhere(row, clause));
};

const applyData = (row: CaseRow, data: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(data)) {
    if (
      value &&
      typeof value === "object" &&
      "increment" in (value as Record<string, unknown>)
    ) {
      row[key] =
        Number(row[key] ?? 0) + Number((value as { increment: number }).increment);
    } else {
      row[key] = value;
    }
  }
};

async function loadWorker() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const fakePrisma = {
      feedbackAutoFixCase: {
        findMany: async ({
          where,
          take,
        }: {
          where: Record<string, unknown>;
          take: number;
        }) => world.cases.filter((row) => matchesOr(row, where)).slice(0, take),
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const rows = world.cases.filter((row) =>
            matchesCaseWhere(row, where)
          );
          for (const row of rows) applyData(row, data);
          return { count: rows.length };
        },
        deleteMany: async () => ({ count: 0 }),
      },
      feedback: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          world.feedback[where.id] ?? null,
      },
      providerErrorEvent: {
        count: async () => world.providerEventCount,
      },
      chatLimitDecisionEvent: {
        count: async () => world.limitEventCount,
      },
    };
    mock.module(mod("lib/prisma.ts"), {
      namedExports: { prisma: fakePrisma },
    });
  }
  return (await import(
    `${mod("lib/feedbackAutoFixShadow.ts")}?spy=cached`
  )) as typeof import("../../lib/feedbackAutoFixShadow");
}

const withShadowFlag = async <T>(run: () => Promise<T>): Promise<T> => {
  const previous = process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED;
  process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED = "true";
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED;
    } else {
      process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED = previous;
    }
  }
};

const receivedCase = (id: string, overrides: Partial<CaseRow> = {}): CaseRow => ({
  id,
  feedbackId: `fb-${id}`,
  traceId: `trace-${id}`,
  occurrenceId: `occ-${id}`,
  state: "received",
  attemptCount: 0,
  leaseExpiresAt: null,
  claimedAt: null,
  ...overrides,
});

const verifiedFeedback = (
  id: string,
  overrides: Record<string, unknown> = {}
) => ({
  errorReportVerification: "verified",
  errorClassificationSource: "server",
  clientErrorCode: null,
  evidenceAvailability: "recorded",
  traceEvidence: {
    occurrenceId: `occ-${id}`,
    traceId: `trace-${id}`,
    environment: "staging",
    release: "sha-1234567",
    routeClass: "chat",
    phase: "request",
    errorCode: "AI_PROVIDER_ERROR",
    classificationSource: "server",
    httpStatus: 500,
    provider: "openai",
    modelId: "gpt-5-6-luna",
    retryable: false,
    sentryEventId: null,
    occurredAt: new Date("2099-01-01T00:00:00.000Z"),
  },
  ...overrides,
});

test.beforeEach(() => {
  world = freshWorld();
});

test("the flag off means no work at all", async () => {
  const { runFeedbackAutoFixShadowWorker } = await loadWorker();
  world.cases.push(receivedCase("c1"));
  const result = await runFeedbackAutoFixShadowWorker();
  assert.deepEqual(result, { enabled: false, claimed: 0, processed: 0 });
  assert.equal(world.cases[0].state, "received", "nothing was touched");
});

test("an application candidate ends awaiting human review with a bounded summary", async () => {
  await withShadowFlag(async () => {
    const { runFeedbackAutoFixShadowWorker } = await loadWorker();
    world.cases.push(receivedCase("c2"));
    world.feedback["fb-c2"] = verifiedFeedback("c2");
    world.providerEventCount = 3;

    const result = await runFeedbackAutoFixShadowWorker();
    assert.equal(result.claimed, 1);
    assert.equal(result.processed, 1);
    const row = world.cases[0];
    assert.equal(row.state, "awaiting_human_review");
    assert.equal(row.classification, "application_candidate");
    assert.equal(row.leaseExpiresAt, null, "the lease is released");
    const summary = row.diagnosticSummary as Record<string, unknown>;
    assert.equal(summary.errorCode, "AI_PROVIDER_ERROR");
    assert.equal(summary.providerEventCount, 3);
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes("message"), "no report body in the summary");
    // No Sentry env in this suite: the fetch path must not have run.
    assert.equal((summary.sentry as Record<string, unknown>).fetched, false);
  });
});

test("a terminal case is never claimed again", async () => {
  await withShadowFlag(async () => {
    const { runFeedbackAutoFixShadowWorker } = await loadWorker();
    world.cases.push(receivedCase("c3"));
    world.feedback["fb-c3"] = verifiedFeedback("c3", {
      evidenceAvailability: "existing_limit_event",
      traceEvidence: null,
    });

    const first = await runFeedbackAutoFixShadowWorker();
    assert.equal(first.claimed, 1);
    assert.equal(world.cases[0].state, "ineligible");
    assert.equal(world.cases[0].classification, "operational_limit");

    const second = await runFeedbackAutoFixShadowWorker();
    assert.equal(second.claimed, 0, "terminal states stay terminal");
  });
});

test("missing evidence delays with a future not-before, then gives up honestly", async () => {
  await withShadowFlag(async () => {
    const { runFeedbackAutoFixShadowWorker } = await loadWorker();
    world.cases.push(receivedCase("c4"));
    world.feedback["fb-c4"] = verifiedFeedback("c4", {
      evidenceAvailability: "not_yet_available",
      traceEvidence: null,
    });

    const first = await runFeedbackAutoFixShadowWorker();
    assert.equal(first.claimed, 1);
    const row = world.cases[0];
    assert.equal(row.state, "evidence_delayed");
    assert.equal(row.attemptCount, 1);
    assert.ok(
      row.leaseExpiresAt && row.leaseExpiresAt.getTime() > Date.now(),
      "the retry is scheduled in the future"
    );

    // Not due yet: a second pass leaves it alone.
    const second = await runFeedbackAutoFixShadowWorker();
    assert.equal(second.claimed, 0);

    // Past the ceiling the sweep closes it as evidence_incomplete.
    row.attemptCount = 6;
    row.leaseExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const third = await runFeedbackAutoFixShadowWorker();
    assert.equal(third.exhausted, 1);
    assert.equal(row.state, "ineligible");
    assert.equal(row.classification, "evidence_incomplete");
  });
});

test("an unverified report closes as untrusted even if a case was queued", async () => {
  await withShadowFlag(async () => {
    const { runFeedbackAutoFixShadowWorker } = await loadWorker();
    world.cases.push(receivedCase("c5"));
    world.feedback["fb-c5"] = verifiedFeedback("c5", {
      errorReportVerification: "missing_token",
    });

    await runFeedbackAutoFixShadowWorker();
    assert.equal(world.cases[0].state, "ineligible");
    assert.equal(world.cases[0].classification, "untrusted_trace");
  });
});
