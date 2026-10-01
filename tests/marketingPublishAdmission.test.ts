// The publisher's admission, asked inside the claim and again inside the dispatch
// (S2 plan, S2d2: "rerun the entire resolver ... immediately before every vendor
// call").

import assert from "node:assert/strict";
import test from "node:test";

import { resolvePublishAdmission } from "@/lib/marketingAutonomousAdmission";
import type {
  MarketingAdmissionChannel,
  MarketingHealthObservation,
  MarketingTransaction,
} from "@/lib/marketingStore";

const NOW = new Date("2026-10-01T09:00:00.000Z");

const statementText = (query: unknown): string => {
  if (Array.isArray(query)) return query.join("?");
  const strings = (query as { strings?: readonly string[] }).strings;
  return strings ? strings.join("?") : String(query);
};

const database = (options: { clock?: unknown; settings?: Record<string, string> } = {}) => {
  const seen: string[] = [];
  const settings = options.settings ?? {
    "marketingAutomation.publishEnabled": "true",
    "marketingAutomation.autoPublishEnabled": "true",
    "marketingAutomation.configGeneration": JSON.stringify({ generation: 2 }),
  };
  const fake = {
    async $queryRaw(query: unknown) {
      const sql = statementText(query);
      seen.push(sql);
      if (sql.includes("clock_timestamp")) {
        return options.clock === undefined ? [{ now: NOW }] : (options.clock as unknown[]);
      }
      if (sql.includes("AppSetting")) {
        return Object.entries(settings).map(([key, value]) => ({ key, value }));
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
  return { database: fake as unknown as MarketingTransaction, seen };
};

const channel = (status: string): MarketingAdmissionChannel =>
  ({ id: "c1", channel: "linkedin", status, connectionGeneration: 3 }) as MarketingAdmissionChannel;

const health = (ageMs: number, overrides: Partial<MarketingHealthObservation> = {}) => ({
  channelId: "c1",
  connectionGeneration: 3,
  healthy: true,
  observedAt: new Date(NOW.getTime() - ageMs),
  ...overrides,
});

test("in this build nothing is admitted, and the reasons say which decisions are missing", async () => {
  // The recovery contract and the platform budget are unreadable until a person
  // decides what makes them ready; the price-fallback alert is not wired. Each is
  // a refusal, which is the state the plan requires before activation.
  for (const status of ["approval_mode", "autonomous_mode"]) {
    const { database: db } = database();
    const answer = await resolvePublishAdmission(db, channel(status), health(1_000));
    assert.equal(answer.publish, false, status);
    for (const reason of [
      "input_unreadable:recoveryContractAvailable",
      "input_unreadable:platformBudgetAvailable",
      "input_false:priceFallbackAlertReady",
    ]) {
      assert.ok(answer.reasons.includes(reason as never), `${status}: ${reason}`);
    }
  }
});

test("an approval-mode channel is asked the approval question, not the autonomy one", async () => {
  const { database: db } = database();
  const answer = await resolvePublishAdmission(db, channel("approval_mode"), health(1_000));
  assert.equal(
    answer.reasons.some((reason) => reason.includes("commentsMonitorHealthy")),
    false,
  );
  assert.equal(answer.reasons.includes("deployment_unknown" as never), false);
});

test("an autonomous channel is asked the autonomy question, which includes the approval one", async () => {
  const { database: db } = database();
  const answer = await resolvePublishAdmission(db, channel("autonomous_mode"), health(1_000));
  assert.ok(answer.reasons.includes("input_unreadable:commentsMonitorHealthy" as never));
  assert.ok(answer.reasons.includes("input_unreadable:recoveryContractAvailable" as never));
});

test("a channel in any other mode is refused", async () => {
  for (const status of ["paused", "disconnected", "connect_pending"]) {
    const { database: db } = database();
    const answer = await resolvePublishAdmission(db, channel(status), health(1_000));
    assert.equal(answer.publish, false);
    assert.deepEqual(answer.reasons, ["input_invalid:channelMode"]);
  }
});

test("health is judged against the database clock read in the same transaction", async () => {
  const fresh = await resolvePublishAdmission(
    database().database,
    channel("approval_mode"),
    health(5_000),
  );
  assert.equal(
    fresh.reasons.some((reason) => reason.endsWith(":adapterHealthy")),
    false,
    "five seconds old is fresh",
  );
  for (const [label, observation] of [
    ["stale", health(5 * 60 * 1000)],
    ["future-dated", health(-60_000)],
    ["another connection", health(1_000, { connectionGeneration: 2 })],
    ["unhealthy", health(1_000, { healthy: false })],
  ] as const) {
    const answer = await resolvePublishAdmission(
      database().database,
      channel("approval_mode"),
      observation,
    );
    assert.ok(answer.reasons.includes("input_false:adapterHealthy" as never), label);
  }
  const none = await resolvePublishAdmission(database().database, channel("approval_mode"), null);
  assert.ok(none.reasons.includes("input_unreadable:adapterHealthy" as never));
});

test("a clock that cannot be read refuses", async () => {
  // The settings are read first and the clock last, so the instant reported is
  // after every read; without it there is no freshness to judge.
  const { database: db, seen } = database({ clock: [] });
  const answer = await resolvePublishAdmission(db, channel("approval_mode"), health(1_000));
  assert.deepEqual(answer, { publish: false, reasons: ["input_unreadable:adapterHealthy"] });
  assert.equal(seen.length, 2);
  assert.ok(seen[1]?.includes("clock_timestamp"));
});

test("the post's own mode picks the question at dispatch", async () => {
  // An approved post on an autonomous account is judged as an approved post;
  // an autonomous post on an approval account is asked the autonomy question,
  // which refuses a channel that is not autonomous.
  const approved = await resolvePublishAdmission(
    database().database,
    channel("autonomous_mode"),
    health(1_000),
    "approval",
  );
  assert.equal(
    approved.reasons.some((reason) => reason.includes("commentsMonitorHealthy")),
    false,
  );
  const autonomous = await resolvePublishAdmission(
    database().database,
    channel("approval_mode"),
    health(1_000),
    "autonomous",
  );
  assert.ok(autonomous.reasons.includes("input_invalid:channelMode" as never));
  assert.ok(autonomous.reasons.includes("input_unreadable:commentsMonitorHealthy" as never));
});

test("the answer carries the clock it was judged at and the provenance to compare", async () => {
  const answer = await resolvePublishAdmission(
    database().database,
    channel("autonomous_mode"),
    health(1_000),
    "autonomous",
  );
  assert.equal(answer.checkedAt?.getTime(), NOW.getTime());
  assert.equal(typeof answer.admissionCodeDigest, "string");
  assert.equal(answer.configGeneration, 2);
});
