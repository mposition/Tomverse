import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MARKETING_PURPOSES,
  marketingReachFindings,
  marketingReachRows,
} from "../scripts/report-marketing-reach-core.mjs";

// The classification behind the Q2 decision record.
// Contract: docs/policy/email-notifications.md §5.1 C1, §5.6 C8, §11.2.
// Decision: docs/ops/q2-marketing-reach-decision.md.

const rowsFor = (overrides = {}) =>
  marketingReachRows({
    accounts: 100,
    preferences: [],
    provableByPurpose: {},
    suppressedEnabledByPurpose: {},
    ...overrides,
  });

test("the three consent-gated purposes are the marketing ones", () => {
  // security and billing are locked on, service_status is contract
  // performance. None of them is a consent question, so none belongs here.
  assert.deepEqual(MARKETING_PURPOSES, [
    "product_updates",
    "newsletter",
    "promotions",
  ]);
});

test("an account with no row counts as no row, not as disabled", () => {
  // ensureDefaultPreferences runs on a settings read, so an account that never
  // opened the preference centre has nothing. Folding that into `disabled`
  // would say people declined when they were never asked.
  const [row] = rowsFor({
    preferences: [
      { purpose: "product_updates", enabled: false, source: "system_default", count: 40 },
    ],
  });
  assert.equal(row.noRow, 60);
  assert.equal(row.disabled, 40);
  assert.equal(row.enabled, 0);
});

test("suppression wins over a switched-on preference", () => {
  const [row] = rowsFor({
    preferences: [
      { purpose: "product_updates", enabled: true, source: "preference_center", count: 10 },
    ],
    suppressedEnabledByPurpose: { product_updates: 4 },
  });
  assert.equal(row.enabled, 10);
  assert.equal(row.sendable, 6);
});

test("sendable never exceeds enabled, even if the counts disagree", () => {
  // Two queries at two instants can disagree. A negative reach would be read
  // as a defect in the data rather than as the race it is.
  const [row] = rowsFor({
    preferences: [
      { purpose: "product_updates", enabled: true, source: "signup", count: 3 },
    ],
    suppressedEnabledByPurpose: { product_updates: 9 },
  });
  assert.equal(row.sendable, 0);
});

test("a switched-on preference with no consent record is unprovable, not reach", () => {
  const [row] = rowsFor({
    preferences: [
      { purpose: "product_updates", enabled: true, source: "preference_center", count: 12 },
    ],
    provableByPurpose: { product_updates: 5 },
  });
  assert.equal(row.provable, 5);
  assert.equal(row.unprovable, 7);
  const finding = marketingReachFindings([row]).find(
    (item) => item.code === "CONSENT_NOT_PROVABLE"
  );
  assert.ok(finding);
  assert.equal(finding.purpose, "product_updates");
});

test("more consent records than switched-on preferences is not negative reach", () => {
  // Somebody who granted and then turned the switch off in the preference
  // centre leaves a grant behind. The record is still true; the preference is
  // what decides the send.
  const [row] = rowsFor({
    preferences: [
      { purpose: "product_updates", enabled: true, source: "preference_center", count: 2 },
    ],
    provableByPurpose: { product_updates: 9 },
  });
  assert.equal(row.unprovable, 0);
});

test("an empty list says the conservative model is not reducing anything", () => {
  const rows = rowsFor();
  const finding = marketingReachFindings(rows).find(
    (item) => item.code === "NO_MARKETING_CONSENT_YET"
  );
  assert.ok(finding);
  assert.match(finding.message, /there is no list/);
});

test("switched on with only a system_default source is flagged, not counted as a decision", () => {
  // The default for a consent-based purpose is off, so this combination should
  // not exist. If it does, something wrote it, and that is worth knowing
  // before the number is used as reach.
  const rows = rowsFor({
    preferences: [
      { purpose: "newsletter", enabled: true, source: "system_default", count: 7 },
    ],
  });
  const codes = marketingReachFindings(rows).map((item) => item.code);
  assert.ok(codes.includes("ENABLED_WITHOUT_A_DELIBERATE_SOURCE"));
  assert.equal(codes.includes("NO_MARKETING_CONSENT_YET"), false);
});

test("a deliberate source is not flagged", () => {
  const rows = rowsFor({
    preferences: [
      { purpose: "newsletter", enabled: true, source: "signup", count: 7 },
    ],
    provableByPurpose: { newsletter: 7 },
  });
  assert.deepEqual(marketingReachFindings(rows), []);
});

test("sources are summed per source, not overwritten", () => {
  const [row] = rowsFor({
    preferences: [
      { purpose: "product_updates", enabled: true, source: "signup", count: 3 },
      { purpose: "product_updates", enabled: true, source: "preference_center", count: 4 },
    ],
  });
  assert.deepEqual(row.enabledBySource, { signup: 3, preference_center: 4 });
  assert.equal(row.enabled, 7);
});

test("every marketing purpose gets a row even with no data for it", () => {
  // A purpose that vanishes from the table reads as "not applicable" rather
  // than as zero, and those are different answers to Q2.
  const rows = rowsFor();
  assert.deepEqual(rows.map((row) => row.purpose), MARKETING_PURPOSES);
});
