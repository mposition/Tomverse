import assert from "node:assert/strict";
import test from "node:test";

import {
  BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_MAX_AGE_MS,
  decideBillingFinanceOpsSwitchChange,
  parseBillingFinanceOpsMonitorConfirmation,
} from "../lib/billingFinanceOpsControl.ts";
import { billingFinanceOpsConsoleRow } from "../lib/billingFinanceOpsConsoleRead.ts";

// docs/policy/billing-finance-ops.md §1.2–1.4.

const NOW = Date.parse("2026-10-05T00:00:00.000Z");
const off = { state: "disabled", control: { enabled: false, revision: 3, enabledAt: null } };
const on = { state: "enabled", control: { enabled: true, revision: 4, enabledAt: "2026-10-01T00:00:00.000Z" } };
const unreadable = { state: "unreadable" };

test("turning on needs a readable off row and a monitor check from the last seven days", () => {
  const fresh = NOW - 60_000;
  assert.deepEqual(decideBillingFinanceOpsSwitchChange({ current: off, enabled: true, monitorConfirmedAtMs: fresh, nowMs: NOW }), {
    ok: true,
    next: { enabled: true, revision: 4, enabledAt: "2026-10-05T00:00:00.000Z" },
  });
  for (const monitorConfirmedAtMs of [null, NOW - BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_MAX_AGE_MS - 1, NOW + 1]) {
    assert.deepEqual(
      decideBillingFinanceOpsSwitchChange({ current: off, enabled: true, monitorConfirmedAtMs, nowMs: NOW }),
      { ok: false, code: "monitor_confirmation_required" },
      String(monitorConfirmedAtMs),
    );
  }
  assert.equal(
    decideBillingFinanceOpsSwitchChange({
      current: off,
      enabled: true,
      monitorConfirmedAtMs: NOW - BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_MAX_AGE_MS,
      nowMs: NOW,
    }).ok,
    true,
  );
  assert.deepEqual(decideBillingFinanceOpsSwitchChange({ current: unreadable, enabled: true, monitorConfirmedAtMs: fresh, nowMs: NOW }), {
    ok: false,
    code: "control_unreadable",
  });
  assert.deepEqual(decideBillingFinanceOpsSwitchChange({ current: on, enabled: true, monitorConfirmedAtMs: fresh, nowMs: NOW }), {
    ok: false,
    code: "no_change",
  });
});

test("turning off asks for nothing, and replaces an unreadable row with a clean one", () => {
  assert.deepEqual(decideBillingFinanceOpsSwitchChange({ current: on, enabled: false, monitorConfirmedAtMs: null, nowMs: NOW }), {
    ok: true,
    next: { enabled: false, revision: 5, enabledAt: null },
  });
  assert.deepEqual(decideBillingFinanceOpsSwitchChange({ current: unreadable, enabled: false, monitorConfirmedAtMs: null, nowMs: NOW }), {
    ok: true,
    next: { enabled: false, revision: 1, enabledAt: null },
  });
  assert.deepEqual(decideBillingFinanceOpsSwitchChange({ current: off, enabled: false, monitorConfirmedAtMs: null, nowMs: NOW }), {
    ok: false,
    code: "no_change",
  });
});

test("the monitor confirmation is an instant or nothing", () => {
  assert.equal(parseBillingFinanceOpsMonitorConfirmation(JSON.stringify({ confirmedAt: "2026-10-05T00:00:00.000Z" })), NOW);
  const bad = [null, "{", JSON.stringify({ confirmedAt: "yesterday" }), JSON.stringify({ confirmedAt: "2026-10-05T00:00:00.000Z", x: 1 })];
  for (const value of bad) {
    assert.equal(parseBillingFinanceOpsMonitorConfirmation(value), null, String(value));
  }
});

test("the tab shows a stored body only when it parses with the closed schema", () => {
  const base = { id: "a", createdAt: new Date(NOW), sizeBytes: 100 };
  const payload = { environment: "staging", computedAtDate: "2026-10-05", verdict: "quiet", items: [], rejectedFields: [] };
  assert.deepEqual(billingFinanceOpsConsoleRow({ ...base, payload }), {
    id: "a",
    createdAt: "2026-10-05T00:00:00.000Z",
    sizeBytes: 100,
    body: "present",
    digest: payload,
  });
  assert.equal(billingFinanceOpsConsoleRow({ ...base, payload: null }).body, "expired");
  const unreadableRow = billingFinanceOpsConsoleRow({ ...base, payload: { ...payload, note: "<script>" } });
  assert.equal(unreadableRow.body, "unreadable");
  assert.equal(unreadableRow.digest, null);
});
