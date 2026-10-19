import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import type { Session } from "next-auth";

import { POST } from "@/app/api/internal/marketing-intel-reports/route";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import { MARKETING_COMPETITOR_ACTIONS } from "@/lib/marketingCompetitorCore";
import {
  createApprovedMarketingCompetitor,
  holdApprovedMarketingCompetitorSources,
} from "@/lib/marketingCompetitorStore";
import {
  MARKETING_GENERATOR_REPORT_ACTION,
  marketingGeneratorReportProvenance,
} from "@/lib/marketingIntelReportCore";
import { runMarketingTransaction } from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

const SECRET = "r".repeat(48);
const DIGEST = "b".repeat(64);

// The registry starts empty in each test (the reset clears the migration's
// proposals too), so no competitor is approved unless a test approves it.
const reset = () =>
  resetTestFixture(prisma, `TRUNCATE TABLE "MarketingReport", "MarketingCompetitor" RESTART IDENTITY CASCADE`);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const inAMinute = () => new Date(Date.now() + 60_000).toISOString();

type Unsigned = Record<string, unknown>;
const intel = (overrides: Unsigned = {}): Unsigned => ({
  generatorRunId: RUN,
  reportId: "intel-1",
  kind: "market_intel",
  periodStart: "2026-10-09T00:00:00.000Z",
  periodEnd: "2026-10-16T00:00:00.000Z",
  deadlineAt: DEADLINE,
  payload: {
    facts: [
      {
        competitorId: "poe",
        factType: "launch_date",
        value: { kind: "date", value: "2026-10-01" },
        sourceUrl: "https://poe.com/blog/launch",
        checkedAt: "2026-10-16T00:00:00.000Z",
      },
    ],
    unrepresentableFactCount: 2,
  },
  ...overrides,
});
const brief = (overrides: Unsigned = {}): Unsigned =>
  intel({
    reportId: "brief-1",
    kind: "brief",
    payload: { topicIds: ["topic_compare"], claimIds: [], sourceDigests: [DIGEST] },
    ...overrides,
  });

// One signed deadline per test, so a resend is the same report byte for byte,
// and one run id per test: the audit chain outlives the reset, and a key it
// already holds from an earlier run is that run's report.
let DEADLINE = inAMinute();
let RUN = "run-0";
beforeEach(() => {
  DEADLINE = inAMinute();
  RUN = `run-${Math.random().toString(36).slice(2, 12)}`;
});

const sign = (report: Unsigned) => ({
  ...report,
  provenance: marketingGeneratorReportProvenance(SECRET, report as never),
});

const call = (body: unknown, secret: string | null = SECRET) =>
  POST(
    new Request("http://localhost/api/internal/marketing-intel-reports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const withSecret = async (run: () => Promise<void>) => {
  const previous = process.env.MARKETING_GENERATOR_SUBMIT_SECRET;
  process.env.MARKETING_GENERATOR_SUBMIT_SECRET = SECRET;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.MARKETING_GENERATOR_SUBMIT_SECRET;
    else process.env.MARKETING_GENERATOR_SUBMIT_SECRET = previous;
  }
};

const withKillSwitch = async (run: () => Promise<void>) => {
  const previous = process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
  process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV] = "incident-2026-10-16";
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
    else process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV] = previous;
  }
};

// The audit chain outlives each reset, so a test reads only its own rows.
const auditsFor = async (ids: string[]) =>
  prisma.adminAuditLog.findMany({
    where: { action: MARKETING_GENERATOR_REPORT_ACTION, targetId: { in: ids } },
    select: { targetType: true, targetId: true, metadata: true },
  });

test("only the generator's secret, a signed body and the two generator kinds are answered", () =>
  withSecret(async () => {
    assert.equal((await call(sign(intel()), null)).status, 401);
    assert.equal((await call(sign(intel()), "x".repeat(48))).status, 401);
    assert.equal((await call({ ...sign(intel()), provenance: "0".repeat(64) })).status, 401);
    assert.equal((await call(sign(intel({ kind: "weekly_kpi" })))).status, 400);
    assert.equal((await call({ ...sign(intel()), verdict: "keep" })).status, 400);
    assert.equal(await prisma.marketingReport.count(), 0);
  }));

const operator = {
  user: { id: "marketing-operator", email: "owner@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;

/** A person adds an approved competitor, as the Admin route will. */
const approve = (competitorId: string, displayName: string, officialHosts: string[], trackedPages: string[] = []) =>
  runMarketingTransaction(prisma, async (tx) => {
    const auditLogId = await writeAdminAuditLog({
      session: operator,
      request: new Request("https://tomverse.app/api/admin/marketing/competitors"),
      action: MARKETING_COMPETITOR_ACTIONS.approved,
      targetType: "MarketingCompetitor",
      targetId: competitorId,
      summary: "Approved a competitor.",
      metadata: { actorHadMarketingWrite: true, previousDecisionAuditLogId: ":none", displayName, officialHosts, trackedPages },
      tx,
    });
    await createApprovedMarketingCompetitor(tx, { competitorId, displayName, officialHosts, trackedPages, auditLogId });
  });

test("market facts are recorded with the facts from no official host counted, not stored", () =>
  withSecret(async () => {
    const response = await call(sign(intel()));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { result } = (await response.json()) as {
      result: { status: string; reportRowId: string; existing: boolean; droppedFactCount: number };
    };
    assert.equal(result.status, "recorded");
    assert.equal(result.existing, false);
    assert.equal(result.droppedFactCount, 1);

    const row = await prisma.marketingReport.findUniqueOrThrow({ where: { id: result.reportRowId } });
    assert.equal(row.kind, "market_intel");
    // No competitor is approved: the fact is counted with the two the
    // generator could not represent.
    assert.deepEqual(row.payload, { facts: [], unrepresentableFactCount: 3 });
    assert.ok(row.retentionUntil > row.createdAt, "the trigger dated its retention");

    const audits = await auditsFor([row.id]);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].targetType, "MarketingReport");
    const metadata = audits[0].metadata as Record<string, unknown>;
    assert.equal(metadata.systemActor, "marketing-generator");
    assert.equal(metadata.kind, "market_intel");
    assert.equal(metadata.droppedFactCount, 1);
    assert.match(String(metadata.reportDigest), /^[0-9a-f]{64}$/);
    // No value in the audit row is a URL: the source stays with the report.
    const values = Object.values(metadata).filter((value): value is string => typeof value === "string");
    assert.equal(values.some((value) => /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)), false, "no URL in the audit row");
  }));

test("a resend is the same report only if it is the same bytes, and is read back after the gates close", () =>
  withSecret(async () => {
    const first = (await (await call(sign(intel()))).json()) as { result: { reportRowId: string } };
    const again = (await (await call(sign(intel()))).json()) as { result: Record<string, unknown> };
    assert.deepEqual(again.result, {
      status: "recorded",
      reportRowId: first.result.reportRowId,
      existing: true,
      droppedFactCount: 1,
      proposedCompetitorCount: 0,
    });

    const changed = await call(sign(intel({ payload: { facts: [], unrepresentableFactCount: 9 } })));
    assert.equal(changed.status, 409);
    // A different deadline is a different report under the same key.
    const resigned = await call(sign(intel({ deadlineAt: new Date(Date.now() + 90_000).toISOString() })));
    assert.equal(resigned.status, 409);

    await withKillSwitch(async () => {
      const readBack = (await (await call(sign(intel()))).json()) as { result: Record<string, unknown> };
      assert.equal(readBack.result.status, "recorded");
      assert.equal(readBack.result.existing, true);
      const fresh = (await (await call(sign(intel({ reportId: "intel-2" })))).json()) as {
        result: { status: string; reasons: string[] };
      };
      assert.deepEqual(fresh.result, { status: "refused", reasons: ["kill_switch"] });
    });
    assert.equal(await prisma.marketingReport.count(), 1);
  }));

test("a brief is kept as sent, and a brief resting on a claim the registry lacks is refused", () =>
  withSecret(async () => {
    const kept = (await (await call(sign(brief()))).json()) as { result: { status: string; reportRowId: string } };
    assert.equal(kept.result.status, "recorded");
    const row = await prisma.marketingReport.findUniqueOrThrow({ where: { id: kept.result.reportRowId } });
    assert.deepEqual(row.payload, { topicIds: ["topic_compare"], claimIds: [], sourceDigests: [DIGEST] });

    const unknown = (await (
      await call(sign(brief({ reportId: "brief-2", payload: { topicIds: [], claimIds: ["claim_x"], sourceDigests: [] } })))
    ).json()) as { result: Record<string, unknown> };
    assert.deepEqual(unknown.result, { status: "refused", reasons: ["report_claim_unknown"] });
    assert.equal(await prisma.marketingReport.count(), 1);
  }));

test("a report with too little time before the service's deadline is not started", () =>
  withSecret(async () => {
    const tight = (await (await call(sign(intel({ deadlineAt: new Date(Date.now() + 2_000).toISOString() })))).json()) as {
      result: Record<string, unknown>;
    };
    assert.deepEqual(tight.result, { status: "refused", reasons: ["intake_deadline_too_close"] });
    assert.equal(await prisma.marketingReport.count(), 0);
  }));

test("a fact from a page a person approved is kept, and only from that page", () =>
  withSecret(async () => {
    await approve("poe", "Poe", ["poe.com"], ["https://poe.com/blog/launch"]);
    const report = intel({
      payload: {
        facts: [
          (intel().payload as { facts: unknown[] }).facts[0],
          {
            competitorId: "poe",
            factType: "launch_date",
            value: { kind: "date", value: "2026-10-02" },
            sourceUrl: "https://blog.poe.com/launch",
            checkedAt: "2026-10-16T00:00:00.000Z",
          },
          // The approved host, but a page nobody approved: not a source.
          {
            competitorId: "poe",
            factType: "launch_date",
            value: { kind: "date", value: "2026-10-03" },
            sourceUrl: "https://poe.com/pricing",
            checkedAt: "2026-10-16T00:00:00.000Z",
          },
        ],
        unrepresentableFactCount: 0,
      },
    });
    const { result } = (await (await call(sign(report))).json()) as {
      result: { status: string; reportRowId: string; droppedFactCount: number };
    };
    assert.equal(result.status, "recorded");
    assert.equal(result.droppedFactCount, 2);
    const row = await prisma.marketingReport.findUniqueOrThrow({ where: { id: result.reportRowId } });
    const payload = row.payload as { facts: Array<{ sourceUrl: string }>; unrepresentableFactCount: number };
    assert.deepEqual(payload.facts.map((fact) => fact.sourceUrl), ["https://poe.com/blog/launch"]);
    assert.equal(payload.unrepresentableFactCount, 2);
  }));

test("candidates become proposals once, and a known competitor is not touched", () =>
  withSecret(async () => {
    await approve("poe", "Poe", ["poe.com"]);
    const candidate = (competitorId: string, host: string) => ({
      competitorId,
      displayName: competitorId.toUpperCase(),
      officialHosts: [host],
      evidenceUrls: [`https://${host}/pricing`],
      rationale: "Sells the same comparison.",
    });
    const report = intel({ competitorCandidates: [candidate("alpha", "alpha.example"), candidate("poe", "evil.example")] });
    const first = (await (await call(sign(report))).json()) as {
      result: { status: string; proposedCompetitorCount: number };
    };
    assert.equal(first.result.status, "recorded");
    assert.equal(first.result.proposedCompetitorCount, 1);
    const alpha = await prisma.marketingCompetitor.findUniqueOrThrow({ where: { id: "alpha" } });
    assert.equal(alpha.status, "proposed");
    assert.equal(alpha.proposedBy, "generator");
    assert.equal(alpha.proposedRunId, RUN);
    const poe = await prisma.marketingCompetitor.findUniqueOrThrow({ where: { id: "poe" } });
    assert.deepEqual(poe.officialHosts, ["poe.com"]);

    // A resend is read back; it proposes nothing again.
    const again = (await (await call(sign(report))).json()) as {
      result: { existing: boolean; proposedCompetitorCount: number };
    };
    assert.equal(again.result.existing, true);
    assert.equal(again.result.proposedCompetitorCount, 1);
    const proposals = await prisma.adminAuditLog.count({
      where: { action: MARKETING_COMPETITOR_ACTIONS.proposed, targetId: "alpha", metadata: { path: ["generatorRunId"], equals: RUN } },
    });
    assert.equal(proposals, 1);
    // A candidate the registry would store differently is malformed, not a
    // bad signature: the generator signs exactly what is stored.
    const unsorted = await call(
      sign(intel({ reportId: "intel-unsorted", competitorCandidates: [{ ...candidate("beta", "www.beta.example"), officialHosts: ["www.beta.example", "beta.example"] }] })),
    );
    assert.equal(unsorted.status, 400);
    const sorted = (await (
      await call(
        sign(intel({ reportId: "intel-sorted", competitorCandidates: [{ ...candidate("beta", "beta.example"), officialHosts: ["beta.example", "www.beta.example"] }] })),
      )
    ).json()) as { result: { status: string; proposedCompetitorCount: number } };
    assert.equal(sorted.result.status, "recorded");
    assert.equal(sorted.result.proposedCompetitorCount, 1);
    assert.deepEqual((await prisma.marketingCompetitor.findUniqueOrThrow({ where: { id: "beta" } })).officialHosts, [
      "beta.example",
      "www.beta.example",
    ]);
    // A proposal is never a source.
    assert.deepEqual(Object.keys((await runMarketingTransaction(prisma, (tx) => holdApprovedMarketingCompetitorSources(tx))).hosts), ["poe"]);
  }));

test("the approved hosts a report read cannot change until it commits", async () => {
  await approve("poe", "Poe", ["poe.com"]);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held!: () => void;
  const holding = new Promise<void>((resolve) => {
    held = resolve;
  });
  const reader = runMarketingTransaction(
    prisma,
    async (tx) => {
      await holdApprovedMarketingCompetitorSources(tx);
      held();
      await released;
    },
    { timeout: 20_000 },
  );
  const lockElsewhere = () =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
      await tx.$queryRaw`SELECT 1 FROM "MarketingCompetitor" WHERE "id" = 'poe' FOR UPDATE`;
    });
  await holding;
  await assert.rejects(lockElsewhere(), /lock|55P03/iu);
  release();
  await reader;
  await lockElsewhere();
});
