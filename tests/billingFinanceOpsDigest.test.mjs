import assert from "node:assert/strict";
import test from "node:test";

import { agentDigestCanonicalBytes } from "../lib/agentDigestCanonicalJson.ts";
import { AGENT_DIGEST_MAX_PAYLOAD_BYTES } from "../lib/agentDigestContract.ts";
import {
  BILLING_FINANCE_OPS_MAX_ITEMS,
  billingFinanceOpsDigestSchema,
  billingFinanceOpsIdempotencyKey,
  buildBillingFinanceOpsPayload,
} from "../lib/billingFinanceOpsDigest.ts";
import { parseBillingFinanceOpsControl } from "../lib/billingFinanceOpsControl.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";

// docs/policy/billing-finance-ops.md §1.1 item 3 and §1.2.

const templateModel = AVAILABLE_MODELS.find((model) => model.usageClass === "premium") ?? AVAILABLE_MODELS[0];
const unpricedModel = (id) => ({
  ...templateModel,
  id,
  name: id,
  apiModel: id,
  enabled: true,
  usageClass: "premium",
  inputUsdPerMillionTokens: undefined,
  outputUsdPerMillionTokens: undefined,
  cachedInputPriceMultiplier: undefined,
});
const NOW = new Date("2026-10-04T01:00:00.000Z");
const entry = (modelId, overrides = {}) => ({
  modelId,
  owner: "@qa-owner",
  verificationTicket: "https://example.invalid/ticket/secret-looking-free-text",
  registeredAt: "2026-08-01",
  expiresAt: "2026-10-11",
  productionApproval: null,
  settlementSource: "reservation_pricing",
  ...overrides,
});
const build = (register, models = [...AVAILABLE_MODELS, ...register.map((e) => unpricedModel(String(e.modelId)))]) =>
  buildBillingFinanceOpsPayload({ environment: "staging", computedAtDate: "2026-10-04", register, models, now: NOW });

test("an empty register is a quiet payload", () => {
  assert.deepEqual(build([]), {
    ok: true,
    payload: { environment: "staging", computedAtDate: "2026-10-04", verdict: "quiet", items: [], rejectedFields: [] },
  });
});

test("items carry the report's day count and mark, and never the owner or the ticket", () => {
  const result = build([entry("qa-a")]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.items, [
    { modelId: "qa-a", registeredAt: "2026-08-01", expiresAt: "2026-10-11", remainingDays: 7, mark: "7" },
  ]);
  assert.equal(result.payload.verdict, "notice");
  const text = JSON.stringify(result.payload);
  assert.equal(text.includes("ticket/"), false);
  assert.equal(text.includes("@qa-owner"), false);
});

test("a rejected value appears as its index and field name only", () => {
  const result = build([entry("qa-a"), entry("Bad Id", { verificationTicket: "\uD800" })], [
    ...AVAILABLE_MODELS,
    unpricedModel("qa-a"),
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.rejectedFields, [
    { index: 1, field: "modelId" },
    { index: 1, field: "ticket" },
  ]);
  assert.equal(result.payload.verdict, "register_invalid");
  assert.equal(JSON.stringify(result.payload).includes("Bad"), false);
});

test("a register past the item ceiling is refused, not truncated", () => {
  const register = Array.from({ length: BILLING_FINANCE_OPS_MAX_ITEMS + 1 }, (_, i) => entry(`qa-${i}`));
  assert.deepEqual(build(register), { ok: false, reason: "register_too_large" });
  assert.equal(build(register.slice(0, BILLING_FINANCE_OPS_MAX_ITEMS)).ok, true);
});

test("a day count outside the schema's range refuses the run", () => {
  assert.deepEqual(build([entry("qa-far", { expiresAt: "9999-12-31" })]), { ok: false, reason: "payload_out_of_range" });
});

test("the schema is closed", () => {
  const ok = { environment: "production", computedAtDate: "2026-10-04", verdict: "quiet", items: [], rejectedFields: [] };
  assert.equal(billingFinanceOpsDigestSchema.safeParse(ok).success, true);
  assert.equal(billingFinanceOpsDigestSchema.safeParse({ ...ok, note: "x" }).success, false);
  assert.equal(billingFinanceOpsDigestSchema.safeParse({ ...ok, environment: "development" }).success, false);
  assert.equal(
    billingFinanceOpsDigestSchema.safeParse({
      ...ok,
      items: [{ modelId: "a", registeredAt: "2026-01-01", expiresAt: "2026-02-01", remainingDays: 1, mark: "1", ticket: "x" }],
    }).success,
    false,
  );
});

test("the worst-case payload fits the shared 16 KiB limit with the computed 12,597 bytes", () => {
  const longId = (i) => `${String(i).padStart(2, "0")}${"m".repeat(98)}`;
  const register = Array.from({ length: BILLING_FINANCE_OPS_MAX_ITEMS }, (_, i) =>
    entry(longId(i), { expiresAt: "2026-12-31", registeredAt: "2026-01-01" }),
  );
  const result = build(register);
  assert.equal(result.ok, true);
  // Force the widest mark and day count the schema allows to measure the bound.
  const widest = {
    ...result.payload,
    environment: "production",
    verdict: "register_invalid",
    items: result.payload.items.map((item) => ({ ...item, remainingDays: -36500, mark: "expired" })),
  };
  const { sizeBytes } = agentDigestCanonicalBytes(widest);
  assert.equal(sizeBytes, 12_597);
  assert.ok(sizeBytes <= AGENT_DIGEST_MAX_PAYLOAD_BYTES);
});

test("the idempotency key is one per environment per UTC day", () => {
  assert.equal(billingFinanceOpsIdempotencyKey("production", "2026-10-04"), "billing-finance-ops:price-deadline:production:2026-10-04");
});

test("the switch has three states and an unreadable row is never off", () => {
  assert.equal(parseBillingFinanceOpsControl(null).state, "unreadable");
  assert.equal(parseBillingFinanceOpsControl("not json").state, "unreadable");
  assert.equal(parseBillingFinanceOpsControl('{"enabled":"yes","revision":0,"enabledAt":null}').state, "unreadable");
  assert.equal(parseBillingFinanceOpsControl('{"enabled":false,"revision":0,"enabledAt":null,"x":1}').state, "unreadable");
  // On without an instant, or off with one, is malformed.
  assert.equal(parseBillingFinanceOpsControl('{"enabled":true,"revision":1,"enabledAt":null}').state, "unreadable");
  assert.equal(
    parseBillingFinanceOpsControl('{"enabled":false,"revision":1,"enabledAt":"2026-10-04T00:00:00.000Z"}').state,
    "unreadable",
  );
  // The migration's own seed, with json_build_object's spacing.
  assert.equal(parseBillingFinanceOpsControl('{"enabled" : false, "revision" : 0, "enabledAt" : null}').state, "disabled");
  assert.equal(
    parseBillingFinanceOpsControl('{"enabled":true,"revision":2,"enabledAt":"2026-10-04T00:00:00.000Z"}').state,
    "enabled",
  );
});
