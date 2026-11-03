import assert from "node:assert/strict";
import { test } from "node:test";

import { MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES } from "../lib/marketingAutomationAccess.ts";
import {
  ZERNIO_WEBHOOK_EVENTS,
  checkReceiverUrl,
  declaredEnvironment,
  planChannelMirror,
  planWebhookCreate,
  redactWebhook,
  summariseDeliveries,
} from "../scripts/marketing/webhook-activation-core.mjs";

const PROD_URL = "https://tomverse.app/api/webhooks/zernio";
const STAGING_URL = "https://staging.tomverse.app/api/webhooks/zernio";
const A1 = "6aab51ca8d284ffb210bff32";
const A2 = "6aab51e68d284ffb210bff9c";
const PROFILE = "6aaa99230adf77ee4b14dabd";
const accounts = [A1, A2].map((id) => ({ id, platform: "instagram", profileId: PROFILE }));
const prodEnv = { RAILWAY_ENVIRONMENT_NAME: "production", ZERNIO_WEBHOOK_SECRET: "s".repeat(64) };

const plan = (overrides = {}) =>
  planWebhookCreate({ url: PROD_URL, name: "", accountIds: [A1], accounts, existing: [], env: prodEnv, ...overrides });

test("the event list equals the events the receiver accepts", () => {
  assert.deepEqual([...ZERNIO_WEBHOOK_EVENTS].sort(), [...MARKETING_WEBHOOK_ACCEPTED_EVENT_TYPES].sort());
});

test("only the two known receivers are accepted, and each names its environment", () => {
  assert.deepEqual(checkReceiverUrl(PROD_URL), { ok: true, environment: "production", url: PROD_URL });
  assert.equal(checkReceiverUrl(STAGING_URL).environment, "staging");
  for (const bad of [
    "http://tomverse.app/api/webhooks/zernio",
    "https://tomverse.app/api/webhooks/other",
    "https://evil.example/api/webhooks/zernio",
    "https://tomverse.app:8443/api/webhooks/zernio",
    "https://tomverse.app/api/webhooks/zernio?x=1",
    "not a url",
  ]) {
    assert.equal(checkReceiverUrl(bad).ok, false, bad);
  }
});

test("a registration needs a clean plan: scoped, known accounts, the right environment's secret", () => {
  const ok = plan();
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.body.accountIds, [A1]);
  assert.deepEqual(ok.body.profileIds, [PROFILE]);
  assert.equal(ok.body.name, "tomverse-production");
  assert.equal("secret" in ok.body, false);

  assert.ok(plan({ accountIds: [] }).problems.includes("account_ids_required"));
  assert.ok(plan({ accountIds: ["6aab51ca8d284ffb210bffff"] }).problems.some((p) => p.startsWith("account_unknown_to_zernio")));
  assert.ok(plan({ accountIds: ["nope"] }).problems.some((p) => p.startsWith("account_id_malformed")));
  assert.ok(plan({ env: { ...prodEnv, ZERNIO_WEBHOOK_SECRET: "" } }).problems.includes("webhook_secret_missing_or_short"));
  assert.ok(plan({ existing: [{ url: PROD_URL }] }).problems.includes("webhook_for_this_url_already_exists"));
});

test("the staging secret is never registered for the production receiver, nor the reverse", () => {
  const stagingProcess = { RAILWAY_ENVIRONMENT_NAME: "staging", ZERNIO_WEBHOOK_SECRET: "s".repeat(64) };
  assert.ok(plan({ env: stagingProcess }).problems.some((p) => p.startsWith("environment_mismatch")));
  assert.ok(plan({ url: STAGING_URL }).problems.some((p) => p.startsWith("environment_mismatch")));
  assert.deepEqual(plan({ url: STAGING_URL, env: stagingProcess }).problems, []);
  assert.equal(declaredEnvironment({}), "unlabelled");
  assert.ok(plan({ env: { ZERNIO_WEBHOOK_SECRET: "s".repeat(64) } }).problems.some((p) => p.startsWith("environment_mismatch")));
});

test("a printed webhook carries no secret and no header value", () => {
  const printed = JSON.stringify(
    redactWebhook({ _id: "w1", url: PROD_URL, secret: "top-secret", customHeaders: { a: "b" }, accountIds: [A2, A1], events: ["b", "a"] }),
  );
  assert.ok(!printed.includes("top-secret"));
  assert.ok(!printed.includes('"b"') || printed.includes('"events":["a","b"]'));
  assert.ok(printed.includes('"hasSecret":true'));
});

test("deliveries are summarised from the answer body only", () => {
  const rows = summariseDeliveries(
    [
      { url: PROD_URL, createdAt: "t", event: "post.platform.published", eventId: "e", statusCode: 200, responseBody: '{"status":"not_applied","pipeline":"faf980ddfa73"}', payload: "secret" },
      { url: STAGING_URL, responseBody: "{}" },
    ],
    PROD_URL,
  );
  assert.deepEqual(rows, [{ at: "t", event: "post.platform.published", eventId: "e", http: 200, answer: "not_applied", pipeline: "faf980dd" }]);
});

test("a mirror row is refused outside staging, for a clash, and for a malformed value", () => {
  const input = {
    channelId: "cmvxc448h004u02rkua41nu9z",
    channel: "instagram",
    accountRef: A1,
    slug: "instagram-91",
    existingChannels: [{ id: "cmuqsyooq001k02taoytnt0wj", accountSlug: "instagram-1", provider: "zernio", externalAccountRef: A2 }],
    stagingLabelled: true,
  };
  const ok = planChannelMirror(input);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.row.id, input.channelId);
  assert.deepEqual(ok.row.allowedLocales, ["en"]);

  assert.ok(planChannelMirror({ ...input, stagingLabelled: false }).problems.includes("not_staging"));
  assert.ok(planChannelMirror({ ...input, slug: "instagram-1" }).problems.includes("slug_already_present"));
  assert.ok(planChannelMirror({ ...input, slug: "facebook-91" }).problems.includes("slug_malformed"));
  assert.ok(planChannelMirror({ ...input, accountRef: A2 }).problems.includes("account_already_bound_in_staging"));
  assert.ok(planChannelMirror({ ...input, channelId: "x" }).problems.includes("channel_id_malformed"));
  assert.ok(
    planChannelMirror({ ...input, existingChannels: [{ id: input.channelId, accountSlug: "z-1", provider: "zernio", externalAccountRef: null }] }).problems.includes(
      "channel_id_already_present",
    ),
  );
});
