// The Zernio webhook as the staging shadow receiver reads it (S2 plan, S2e).

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  MARKETING_WEBHOOK_DERIVED_STATUS,
  MARKETING_WEBHOOK_EVENT_TYPES,
  marketingWebhookEventIdDigest,
  marketingWebhookFaultArmMatches,
  marketingWebhookIsStaging,
  marketingWebhookStatusQueryMatch,
  parseMarketingWebhookFaultArm,
  parseZernioWebhookEnvelope,
  serializeMarketingWebhookFaultArm,
  verifyZernioWebhookSignature,
} from "@/lib/marketingWebhookCore";

const SECRET = "whsec_" + "s".repeat(40);
const EVENT_ID = "1f0e8a52-4c1b-4f6a-9d2e-5c7e1a4b6d90";

const body = (overrides: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      id: EVENT_ID,
      event: "post.published",
      timestamp: "2026-10-02T09:00:00.000Z",
      post: {
        id: "zpost_1",
        status: "published",
        content: "ignored",
        platforms: [{ platform: "linkedin", status: "published", accountId: "acct_9" }],
        metadata: { requestKey: "k" },
      },
      ...overrides,
    }),
  );

const sign = (raw: Uint8Array, secret = SECRET) =>
  createHmac("sha256", secret).update(raw).digest("hex");

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

test("a signature over the exact raw body verifies", () => {
  const raw = body();
  assert.equal(verifyZernioWebhookSignature(raw, sign(raw), SECRET), true);
});

test("anything else does not", () => {
  const raw = body();
  const good = sign(raw);
  for (const [label, header, secret, bytes] of [
    ["another secret", sign(raw, "other"), SECRET, raw],
    ["a body changed by one byte", good, SECRET, Buffer.concat([raw, Buffer.from(" ")])],
    ["uppercase hex", good.toUpperCase(), SECRET, raw],
    ["truncated", good.slice(0, 63), SECRET, raw],
    ["missing header", null, SECRET, raw],
    ["empty secret", good, "", raw],
    ["missing secret", good, undefined, raw],
  ] as const) {
    assert.equal(
      verifyZernioWebhookSignature(bytes, header as string | null, secret as string | undefined),
      false,
      label,
    );
  }
});

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

test("a signed body is read for exactly the fields the receiver uses", () => {
  const parsed = parseZernioWebhookEnvelope(body(), EVENT_ID);
  assert.deepEqual(parsed, {
    ok: true,
    envelope: {
      eventId: EVENT_ID,
      eventType: "post.published",
      zernioPostId: "zpost_1",
      accountIds: ["acct_9"],
    },
  });
});

test("an account id sent as an object is read the way the S0 probe reads it", () => {
  const parsed = parseZernioWebhookEnvelope(
    body({
      post: {
        id: "zpost_1",
        status: "published",
        platforms: [{ platform: "linkedin", accountId: { _id: "acct_7" } }],
      },
    }),
    EVENT_ID,
  );
  assert.equal(parsed.ok && parsed.envelope.accountIds[0], "acct_7");
});

test("the header's event id must be the body's", () => {
  assert.deepEqual(parseZernioWebhookEnvelope(body(), "another-id"), {
    ok: false,
    refusal: "event_id_header_mismatch",
  });
  assert.deepEqual(parseZernioWebhookEnvelope(body(), null), {
    ok: false,
    refusal: "event_id_header_mismatch",
  });
});

test("an event outside the recorded list is acknowledged, not refused", () => {
  assert.deepEqual(parseZernioWebhookEnvelope(body({ event: "comment.received" }), EVENT_ID), {
    ok: false,
    refusal: "event_not_recorded",
  });
});

test("a malformed body is refused for what it is", () => {
  assert.deepEqual(parseZernioWebhookEnvelope(Buffer.from("{"), EVENT_ID), {
    ok: false,
    refusal: "body_not_json",
  });
  for (const overrides of [
    { id: "not-a-uuid" },
    { timestamp: "yesterday" },
    { post: { id: "zpost_1", status: "published", platforms: [] } },
    { post: null },
  ]) {
    assert.deepEqual(
      parseZernioWebhookEnvelope(body(overrides), EVENT_ID),
      { ok: false, refusal: "envelope_invalid" },
      JSON.stringify(overrides),
    );
  }
});

test("the event digest is over the provider and the id, and moving a separator cannot collide", () => {
  assert.match(marketingWebhookEventIdDigest("zernio", EVENT_ID), /^[0-9a-f]{64}$/);
  assert.equal(
    marketingWebhookEventIdDigest("zernio", EVENT_ID),
    marketingWebhookEventIdDigest("zernio", EVENT_ID),
  );
  assert.notEqual(
    marketingWebhookEventIdDigest("ab", "c"),
    marketingWebhookEventIdDigest("a", "bc"),
  );
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

test("every recorded event has a derived status, and only the platform's deletion is removal", () => {
  for (const event of MARKETING_WEBHOOK_EVENT_TYPES) {
    assert.ok(MARKETING_WEBHOOK_DERIVED_STATUS[event], event);
  }
  const removal = MARKETING_WEBHOOK_EVENT_TYPES.filter(
    (event) => MARKETING_WEBHOOK_DERIVED_STATUS[event] === "removed_by_platform",
  );
  assert.deepEqual(removal, ["post.platform.deleted"]);
  // A cancellation is a retraction made through Zernio: ours, not the platform's.
  assert.equal(MARKETING_WEBHOOK_DERIVED_STATUS["post.cancelled"], "deleted");
  // A partial publish is not a success.
  assert.equal(MARKETING_WEBHOOK_DERIVED_STATUS["post.partial"], "outcome_unknown");
});

test("a status query agrees only when it can say", () => {
  assert.equal(marketingWebhookStatusQueryMatch("published", "live"), true);
  assert.equal(marketingWebhookStatusQueryMatch("published", "removed"), false);
  assert.equal(marketingWebhookStatusQueryMatch("failed", "removed"), true);
  assert.equal(marketingWebhookStatusQueryMatch("failed", "live"), false);
  for (const derived of ["published", "failed", "removed_by_platform"] as const) {
    assert.equal(marketingWebhookStatusQueryMatch(derived, "unknown"), false, derived);
  }
});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

test("staging is both signals saying staging, and nothing else", () => {
  assert.equal(
    marketingWebhookIsStaging({ TOMVERSE_DEPLOY_ENV: "staging", APP_ENV: "staging" } as never),
    true,
  );
  for (const env of [
    { TOMVERSE_DEPLOY_ENV: "staging", APP_ENV: "production" },
    { TOMVERSE_DEPLOY_ENV: "production", APP_ENV: "staging" },
    { APP_ENV: "staging" },
    { TOMVERSE_DEPLOY_ENV: "staging", NODE_ENV: "production" },
    {},
  ]) {
    assert.equal(marketingWebhookIsStaging(env as never), false, JSON.stringify(env));
  }
});

// ---------------------------------------------------------------------------
// Fault arm
// ---------------------------------------------------------------------------

const DIGEST = "a".repeat(64);
const arm = {
  eventIdDigest: DIGEST,
  state: "armed" as const,
  generation: 2,
  armedAt: "2026-10-02T09:00:00.000Z",
  expiresAt: "2026-10-02T10:00:00.000Z",
};

test("an arm is the plan's shape exactly", () => {
  assert.deepEqual(parseMarketingWebhookFaultArm(serializeMarketingWebhookFaultArm(arm)), arm);
  for (const broken of [
    { ...arm, extra: true },
    { ...arm, generation: 0 },
    { ...arm, eventIdDigest: "A".repeat(64) },
    { ...arm, state: "disarmed" },
    { ...arm, expiresAt: arm.armedAt },
  ]) {
    assert.equal(parseMarketingWebhookFaultArm(JSON.stringify(broken)), null, JSON.stringify(broken));
  }
  assert.equal(parseMarketingWebhookFaultArm("not json"), null);
  assert.equal(parseMarketingWebhookFaultArm(null), null);
});

test("only an armed, unexpired arm for exactly this event matches", () => {
  const now = new Date("2026-10-02T09:30:00.000Z");
  assert.equal(marketingWebhookFaultArmMatches(arm, DIGEST, now), true);
  assert.equal(marketingWebhookFaultArmMatches({ ...arm, state: "consumed" }, DIGEST, now), false);
  assert.equal(marketingWebhookFaultArmMatches(arm, "b".repeat(64), now), false);
  assert.equal(
    marketingWebhookFaultArmMatches(arm, DIGEST, new Date("2026-10-02T10:00:00.000Z")),
    false,
  );
  assert.equal(marketingWebhookFaultArmMatches(null, DIGEST, now), false);
});
