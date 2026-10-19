import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import type { Session } from "next-auth";

import { POST } from "@/app/api/internal/marketing-generator-context/route";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import { MARKETING_COMPETITOR_ACTIONS } from "@/lib/marketingCompetitorCore";
import { createApprovedMarketingCompetitor } from "@/lib/marketingCompetitorStore";
import { marketingGeneratorContextAllowed } from "@/lib/marketingGeneratorContext";
import { createMarketingChannel, insertMarketingReport, runMarketingTransaction } from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";
import { clearMarketingLlmSettings, setMarketingLlmSettings } from "./marketingLlmSettingsFixture";
import { resetTestFixture } from "./resetTestFixture";

const SECRET = "c".repeat(48);
const DIGEST = "b".repeat(64);

const reset = () =>
  resetTestFixture(
    prisma,
    `TRUNCATE TABLE "MarketingPost", "MarketingChannel", "MarketingReport", "AiVisibilityRun", "MarketingCompetitor" RESTART IDENTITY CASCADE`,
  );

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

async function channelIn(status: string, channel = "linkedin") {
  const row = await createMarketingChannel(prisma, {
    channel,
    provider: "zernio",
    externalAccountRef: `zernio-${Math.random().toString(36).slice(2)}`,
    defaultLocale: "en",
    allowedLocales: ["en"],
    scopesDigest: DIGEST,
    policyVersion: 1,
  } as Parameters<typeof createMarketingChannel>[1]);
  return status === "connect_pending"
    ? row
    : prisma.marketingChannel.update({ where: { id: row.id }, data: { status } as never });
}

const call = (body: unknown, secret: string | null = SECRET) =>
  POST(
    new Request("http://localhost/api/internal/marketing-generator-context", {
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

test("only the generator's secret and a run id are answered", () =>
  withSecret(async () => {
    assert.equal((await call({ generatorRunId: "run-1" }, null)).status, 401);
    assert.equal((await call({ generatorRunId: "run-1" }, "x".repeat(48))).status, 401);
    assert.equal((await call({ generatorRunId: "run-1", channelId: "x" })).status, 400);
    assert.equal((await call({})).status, 400);
    // The body is counted while it is read, not after.
    assert.equal((await call({ generatorRunId: "run-1", pad: "x".repeat(4096) })).status, 413);
  }));

test("the context names approval-mode accounts, claims without evidence, and facts without their pages", () =>
  withSecret(async () => {
    const approval = await channelIn("approval_mode");
    await channelIn("connect_pending", "x");
    const now = new Date();
    await insertMarketingReport(prisma, {
      kind: "brief",
      periodStart: now,
      periodEnd: now,
      payload: { topicIds: ["topic_compare"], claimIds: [], sourceDigests: [DIGEST] },
      sourceVersion: "test",
    } as never);
    await insertMarketingReport(prisma, {
      kind: "market_intel",
      periodStart: now,
      periodEnd: now,
      payload: {
        facts: [
          {
            competitorId: "poe",
            factType: "launch_date",
            value: { kind: "date", value: "2026-10-01" },
            sourceUrl: "https://poe.com/blog/launch",
            checkedAt: now.toISOString(),
          },
        ],
        unrepresentableFactCount: 2,
      },
      sourceVersion: "test",
    } as never);

    const response = await call({ generatorRunId: "run-1" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    const { context } = JSON.parse(text) as {
      context: {
        channels: { id: string }[];
        claims: Record<string, unknown>[];
        assets: unknown[];
        brief: { payload: { topicIds: string[] } } | null;
        marketIntel: { payload: { facts: Record<string, unknown>[]; unrepresentableFactCount: number } } | null;
      };
    };
    assert.deepEqual(context.channels.map((row) => row.id), [approval.id]);
    for (const claim of context.claims) {
      assert.equal("evidence" in claim, false);
      assert.equal("factSource" in claim, false);
    }
    // The registry in this repository has no assets yet.
    assert.deepEqual(context.assets, []);
    assert.deepEqual(context.brief?.payload.topicIds, ["topic_compare"]);
    assert.equal(context.marketIntel?.payload.unrepresentableFactCount, 2);
    assert.deepEqual(Object.keys(context.marketIntel?.payload.facts[0] ?? {}).sort(), [
      "checkedAt",
      "competitorId",
      "factType",
      "value",
    ]);
    assert.equal(/https?:\/\//.test(text), false, "no URL reaches the generator");
  }));

test("the kill switch stops the context, even for the right secret", () =>
  withSecret(async () => {
    await channelIn("approval_mode");
    const previous = process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
    process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV] = "incident-2026-10-16";
    try {
      const response = await call({ generatorRunId: "run-1" });
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.equal(text.includes("approval_mode") || text.includes("channels"), false);
    } finally {
      if (previous === undefined) delete process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV];
      else process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV] = previous;
    }
  }));

test("the context gate follows the resolver's kill-switch rule", () => {
  assert.equal(marketingGeneratorContextAllowed({ ok: true, value: undefined }), true);
  assert.equal(marketingGeneratorContextAllowed({ ok: true, value: "" }), true);
  assert.equal(marketingGeneratorContextAllowed({ ok: true, value: "   " }), true);
  assert.equal(marketingGeneratorContextAllowed({ ok: true, value: "on" }), false);
  assert.equal(marketingGeneratorContextAllowed({ ok: false }), false);
});

// An approval needs a person's audit row on a real chain.
process.env.ADMIN_AUDIT_INTEGRITY_KEY ||= ["generator", "context", "audit", "test"].join("-");
const operator = {
  user: { id: "marketing-operator", email: "owner@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;

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

const propose = (id: string, status: "proposed" = "proposed") =>
  prisma.$executeRawUnsafe(
    `INSERT INTO "MarketingCompetitor" ("id", "displayName", "officialHosts", "status", "proposedBy", "evidenceUrls", "updatedAt")
     VALUES ($1, $1, ARRAY[$2], $3, 'seed', ARRAY[]::TEXT[], CURRENT_TIMESTAMP)`,
    id,
    `${id}.example`,
    status,
  );

test("the context tells A3 whom to track on which hosts, and every id it already knows", () =>
  withSecret(async () => {
    await approve("poe", "Poe", ["poe.com"]);
    await propose("alpha");
    const response = await call({ generatorRunId: "run-2" });
    assert.equal(response.status, 200);
    const text = await response.text();
    const { context } = JSON.parse(text) as {
      context: {
        competitors: {
          tracked: Array<{ competitorId: string; displayName: string; officialHosts: string[]; trackedPages: string[] }>;
          knownIds: string[];
        };
      };
    };
    // Only the approved one is tracked; the proposal is known but not a source.
    assert.deepEqual(context.competitors.tracked, [
      { competitorId: "poe", displayName: "Poe", officialHosts: ["poe.com"], trackedPages: [] },
    ]);
    assert.deepEqual(context.competitors.knownIds, ["alpha", "poe"]);
    assert.equal(/https?:\/\//.test(text), false, "a host is a name, not a URL");
  }));

test("every known id reaches A3, however large the registry and however old the answer", () =>
  withSecret(async () => {
    // The first row written, then 250 newer ones: any page cut at fewer than
    // 251 rows, newest first, would leave out the one written first.
    await propose("aaa-oldest");
    for (let index = 0; index < 250; index += 1) await propose(`c${String(index).padStart(3, "0")}`);
    const response = await call({ generatorRunId: "run-3" });
    assert.equal(response.status, 200);
    const { context } = (await response.json()) as { context: { competitors: { knownIds: string[] } } };
    assert.equal(context.competitors.knownIds.length, 251);
    assert.equal(context.competitors.knownIds.includes("aaa-oldest"), true);
  }));

test("A3 is given the pages a person approved, and those are the context's only URLs", () =>
  withSecret(async () => {
    await approve("poe", "Poe", ["poe.com"], ["https://poe.com/pricing"]);
    const response = await call({ generatorRunId: "run-4" });
    const text = await response.text();
    const { context } = JSON.parse(text) as {
      context: { competitors: { tracked: Array<{ trackedPages: string[] }> } };
    };
    assert.deepEqual(context.competitors.tracked[0].trackedPages, ["https://poe.com/pricing"]);
    assert.deepEqual(text.match(/https?:\/\/[^"]*/gu), ["https://poe.com/pricing"]);
  }));

test("the context carries the model selected in the Admin Console with its catalog pin, and nulls otherwise", () =>
  withSecret(async () => {
    const llm = async () => {
      const response = await call({ generatorRunId: "run-3" });
      assert.equal(response.status, 200);
      return ((await response.json()) as { context: { llm: { model: string | null; pin: { model: string } | null } } })
        .context.llm;
    };
    try {
      assert.deepEqual(await llm(), { model: null, pin: null });
      await setMarketingLlmSettings(prisma, "gpt-5.4-mini", "5");
      const selected = await llm();
      assert.equal(selected.model, "gpt-5.4-mini");
      assert.equal(selected.pin?.model, "gpt-5.4-mini");
      // A model the catalog cannot price within the ledger's limits is no selection at all.
      await setMarketingLlmSettings(prisma, "gpt-6-luna", "5");
      assert.deepEqual(await llm(), { model: null, pin: null });
    } finally {
      await clearMarketingLlmSettings(prisma);
    }
  }));
