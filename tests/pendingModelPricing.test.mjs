import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
  daysUntil,
  findPendingPriceRegisterProblems,
  findUnpricedModels,
  PENDING_PRICE_VERIFICATION_WINDOW_DAYS,
  PENDING_VERIFIED_PRICE_MODEL_IDS,
  PENDING_VERIFIED_PRICE_REGISTER,
} from "../lib/modelPricing.ts";

const entry = (modelId) =>
  PENDING_VERIFIED_PRICE_REGISTER.find((item) => item.modelId === modelId);

const withEntry = (modelId, overrides) =>
  PENDING_VERIFIED_PRICE_REGISTER.map((item) =>
    item.modelId === modelId ? { ...item, ...overrides } : item
  );

// Any date inside every shipped entry's window, so a test that is not about
// expiry does not start failing when the calendar passes a deadline.
const beforeAnyExpiry = new Date("2026-08-02T00:00:00.000Z");

test("the register covers exactly the acknowledged model IDs", () => {
  assert.deepEqual(
    PENDING_VERIFIED_PRICE_MODEL_IDS,
    PENDING_VERIFIED_PRICE_REGISTER.map((item) => item.modelId)
  );
  assert.equal(
    new Set(PENDING_VERIFIED_PRICE_MODEL_IDS).size,
    PENDING_VERIFIED_PRICE_MODEL_IDS.length
  );
});

test("every register entry carries dates and a settlement source", () => {
  for (const item of PENDING_VERIFIED_PRICE_REGISTER) {
    assert.match(item.registeredAt, /^\d{4}-\d{2}-\d{2}$/, item.modelId);
    assert.match(item.expiresAt, /^\d{4}-\d{2}-\d{2}$/, item.modelId);
    assert.ok(
      new Date(item.expiresAt) > new Date(item.registeredAt),
      `${item.modelId} expires before it was registered`
    );
    // The window is a policy constant; entries may not quietly grant
    // themselves a longer one.
    const window =
      (new Date(item.expiresAt) - new Date(item.registeredAt)) / 86_400_000;
    assert.ok(
      window <= PENDING_PRICE_VERIFICATION_WINDOW_DAYS,
      `${item.modelId} has a ${window}-day window, over the ${PENDING_PRICE_VERIFICATION_WINDOW_DAYS}-day maximum`
    );
    assert.ok(
      ["reservation_pricing", "provider_reported_usage"].includes(
        item.settlementSource
      ),
      `${item.modelId} has an unknown settlement source`
    );
  }
});

test("every registered model is still actually unpriced", () => {
  const unpriced = findUnpricedModels(AVAILABLE_MODELS);
  for (const modelId of PENDING_VERIFIED_PRICE_MODEL_IDS) {
    assert.ok(
      unpriced.some((model) => model.modelId === modelId),
      `${modelId} is priced now and should leave the register`
    );
  }
});

test("the shipped register has no errors, only the unassigned-owner warnings", () => {
  const problems = findPendingPriceRegisterProblems({
    models: AVAILABLE_MODELS,
    now: beforeAnyExpiry,
  });
  assert.deepEqual(
    problems.filter((problem) => problem.severity === "error"),
    []
  );
  // Owner, ticket and production approval are still to be filled in by a
  // human; the check has to keep saying so rather than going quiet.
  const reasons = new Set(problems.map((problem) => problem.reason));
  assert.deepEqual(
    [...reasons].sort(),
    ["missing_ticket", "unapproved_production", "unassigned_owner"]
  );
});

test("an expired entry is an error, not a warning", () => {
  const expiry = new Date(`${entry("grok-4").expiresAt}T00:00:00.000Z`);
  const problems = findPendingPriceRegisterProblems({
    models: AVAILABLE_MODELS,
    now: new Date(expiry.getTime() + 86_400_000),
  });
  const expired = problems.filter((problem) => problem.reason === "expired");
  assert.ok(expired.length > 0);
  for (const problem of expired) assert.equal(problem.severity, "error");
  assert.match(expired[0].message, /1 day\(s\) overdue/);
});

test("an entry stays a warning right up to its deadline", () => {
  const expiry = new Date(`${entry("grok-4").expiresAt}T00:00:00.000Z`);
  const problems = findPendingPriceRegisterProblems({
    models: AVAILABLE_MODELS,
    now: new Date(expiry.getTime() - 1),
    register: withEntry("grok-4", {}),
  });
  assert.deepEqual(
    problems.filter((problem) => problem.reason === "expired"),
    []
  );
});

test("a registered model that has since been priced is an error", () => {
  const problems = findPendingPriceRegisterProblems({
    models: AVAILABLE_MODELS,
    now: beforeAnyExpiry,
    register: [
      {
        modelId: "claude-opus-4-8",
        owner: "someone",
        verificationTicket: "T-1",
        registeredAt: "2026-08-01",
        expiresAt: "2026-10-30",
        productionApproval: null,
        settlementSource: "reservation_pricing",
      },
    ],
  });
  const priced = problems.filter((problem) => problem.reason === "priced");
  assert.equal(priced.length, 1);
  assert.equal(priced[0].severity, "error");
});

test("duplicate and malformed entries are errors", () => {
  const base = entry("grok-4");
  const problems = findPendingPriceRegisterProblems({
    models: AVAILABLE_MODELS,
    now: beforeAnyExpiry,
    register: [base, base, { ...entry("grok-4-5"), expiresAt: "not-a-date" }],
  });
  const reasons = problems
    .filter((problem) => problem.severity === "error")
    .map((problem) => problem.reason);
  assert.ok(reasons.includes("duplicate"));
  assert.ok(reasons.includes("invalid_dates"));
});

test("a fully assigned entry produces no warnings", () => {
  const problems = findPendingPriceRegisterProblems({
    models: AVAILABLE_MODELS,
    now: beforeAnyExpiry,
    register: withEntry("grok-4", {
      owner: "billing-oncall",
      verificationTicket: "TOM-1234",
      productionApproval: {
        approvedBy: "billing-oncall",
        approvedAt: "2026-08-01",
        rationale: "Conservative fallback accepted while the price is verified.",
      },
    }).filter((item) => item.modelId === "grok-4"),
  });
  assert.deepEqual(problems, []);
});

test("the policy document records the pending-price contract", () => {
  // AGENTS.md sends readers here before they touch a cost limit, so the
  // deadline and the escalation have to be findable in it rather than only in
  // the code that enforces them.
  const policy = readFileSync("docs/policy/credit-and-cost-limits.md", "utf8");
  assert.match(policy, /PENDING_VERIFIED_PRICE_REGISTER/);
  assert.match(policy, /PENDING_PRICE_VERIFICATION_WINDOW_DAYS/);
  assert.match(policy, /productionApproval/);
  assert.match(policy, /conservative_fallback/);
  assert.match(policy, /reservedToSettledRatio/);
  assert.match(policy, /fallbackAttributableRejections/);
  assert.match(policy, /\/api\/admin\/fallback-pricing/);
  assert.match(policy, /sonar-deep-research/);
});

test("daysUntil counts down and goes negative after the deadline", () => {
  assert.equal(
    daysUntil("2026-10-30", new Date("2026-10-29T00:00:00.000Z")),
    1
  );
  assert.equal(
    daysUntil("2026-10-30", new Date("2026-10-31T00:00:00.000Z")),
    -1
  );
  assert.equal(daysUntil("nope", new Date()), null);
});
