import assert from "node:assert/strict";
import test from "node:test";

import { billingFinanceOpsSilenceVerdict } from "../lib/billingFinanceOpsSilence.ts";

// docs/policy/billing-finance-ops.md §1.3 signal 2.

const on = (enabledAt) => ({ state: "enabled", control: { enabled: true, revision: 1, enabledAt } });
const at = (iso) => Date.parse(iso);
const base = {
  environment: "production",
  todayDate: "2026-10-04",
  nowMs: at("2026-10-04T03:00:00.000Z"),
  control: on("2026-10-01T00:00:00.000Z"),
  digestRecordedToday: false,
};

test("enabled before today's slot, past slot plus an hour, and no row is silent; a row is recorded", () => {
  assert.equal(billingFinanceOpsSilenceVerdict(base), "silent");
  assert.equal(billingFinanceOpsSilenceVerdict({ ...base, digestRecordedToday: true }), "recorded");
});

test("an unreadable switch is its own verdict, never off", () => {
  assert.equal(billingFinanceOpsSilenceVerdict({ ...base, control: { state: "unreadable" } }), "control_unreadable");
  assert.equal(
    billingFinanceOpsSilenceVerdict({ ...base, control: { state: "disabled", control: { enabled: false, revision: 0, enabledAt: null } } }),
    "off",
  );
});

test("not due before 02:00 UTC, or on the day the switch was turned on after the slot", () => {
  assert.equal(billingFinanceOpsSilenceVerdict({ ...base, nowMs: at("2026-10-04T01:59:59.999Z") }), "not_due");
  assert.equal(billingFinanceOpsSilenceVerdict({ ...base, nowMs: at("2026-10-04T02:00:00.000Z") }), "silent");
  assert.equal(billingFinanceOpsSilenceVerdict({ ...base, control: on("2026-10-04T01:00:00.000Z") }), "not_due");
  assert.equal(billingFinanceOpsSilenceVerdict({ ...base, control: on("2026-10-04T00:59:59.000Z") }), "silent");
});

test("a deployment that is neither production nor staging is not applicable", () => {
  assert.equal(billingFinanceOpsSilenceVerdict({ ...base, environment: "development" }), "not_applicable");
});
