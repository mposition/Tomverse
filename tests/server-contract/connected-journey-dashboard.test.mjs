import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, mock, test } from "node:test";
const root = resolve(import.meta.dirname, "../..");
const mod = path => pathToFileURL(resolve(root, path)).href;
let rows = [], queries = [], fail = false, writes = [], sent = [];
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  productAnalyticsEvent: {
    groupBy: async () => [],
    findMany: async query => {
      if (query.where.eventName !== "connected_journey_step") return [];
      queries.push(query);
      if (fail) throw Error("sensitive database failure");
      return rows;
    },
    create: async ({ data }) => { writes.push(data); return data; },
  }, user: { count: async () => 0 },
} } });
const { getProductAnalyticsDashboard } = await import("../../lib/productAnalyticsDashboard.ts");
const { recordProductAnalyticsEvent } = await import("../../lib/productAnalyticsServer.ts");
beforeEach(() => {
  rows = []; queries = []; fail = false; writes = []; sent = [];
  process.env.NEXTAUTH_SECRET = "connected-journey-test-secret";
  process.env.GA4_MEASUREMENT_ID = "G-TEST";
  process.env.GA4_API_SECRET = "mock-only";
  globalThis.fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); };
});
const fixtureJourneyKey = randomUUID();
const properties = stage => ({ journey_key: fixtureJourneyKey, journey_kind: "review_chat", journey_entry: "review_studio", journey_stage: stage });
test("dashboard reads the full 30-day cohort and returns no ratio without mature starts", async () => {
  rows = [{ userId: "A", occurredAt: new Date(Date.now() - 1000), properties: properties("started") }];
  const dashboard = await getProductAnalyticsDashboard();
  assert.equal(dashboard.available, true);
  assert.equal(dashboard.connectedJourneys.groups[0].rate, null);
  assert.equal(dashboard.connectedJourneys.groups[0].pending, 1);
  assert.equal(queries[0].take, undefined);
  assert.equal(+queries[0].where.occurredAt.lte - +queries[0].where.occurredAt.gte, 31 * 86400000);
});
test("query failure is unavailable, never a zero-percent connected journey result", async () => {
  fail = true;
  const dashboard = await getProductAnalyticsDashboard();
  assert.equal(dashboard.available, true);
  assert.equal(dashboard.connectedJourneys, null);
});
test("server recording excludes journey events and fields from both GA4 fanout paths", async () => {
  const input = { eventName: "connected_journey_step", source: "client", userId: "A", modelCount: 0, plan: "Free", properties: properties("started"), dedupeKey: randomUUID(), sendToGa4: true, attribution: { client_id: randomUUID(), session_id: "1234567890", utm_source: "direct", utm_medium: "none", utm_campaign: "none", language: "en", country: "AU" } };
  await recordProductAnalyticsEvent(input);
  assert.equal(writes.length, 1); assert.deepEqual(sent, []);
  await recordProductAnalyticsEvent({ ...input, dedupeKey: randomUUID(), eventName: "chat_started" });
  assert.equal(sent.length, 1);
  assert.ok(Object.keys(sent[0].events[0].params).every(key => !key.startsWith("journey_") && key !== "continuation_kind"));
});
test("dashboard returns per-entry dropoff counts without ids, and an empty ledger is not a failure", async () => {
  const key = randomUUID(), at = ago => new Date(Date.now() - ago);
  const p = (stage, extra = {}) => ({ ...properties(stage), journey_key: key, ...extra });
  rows = [
    { userId: "account-secret", occurredAt: at(2 * 86400000), properties: p("started") },
    { userId: "account-secret", occurredAt: at(2 * 86400000 - 10), properties: p("preview_ready") },
    { userId: "account-secret", occurredAt: at(2 * 86400000 - 20), properties: p("issue", { journey_reason: "draft_conflict" }) },
  ];
  const dashboard = await getProductAnalyticsDashboard();
  const group = dashboard.connectedJourneys.groups[0];
  assert.deepEqual([group.mature, group.replied, group.dropoff.unreplied, group.dropoff.withReason], [1, 0, 1, 1]);
  assert.deepEqual(group.dropoff.lastStage, { started: 0, preview: 1, ready: 0, sent: 0 });
  assert.deepEqual(group.dropoff.reasons, [{ reason: "draft_conflict", unreplied: 1, replied: 0 }]);
  const serialized = JSON.stringify(dashboard.connectedJourneys);
  assert.equal(serialized.includes("account-secret"), false);
  assert.equal(serialized.includes(key), false);
  rows = [];
  const empty = await getProductAnalyticsDashboard();
  assert.deepEqual(empty.connectedJourneys.groups, []);
});
