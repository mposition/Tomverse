import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogFindings,
  classifyPriceAudits,
  compareBillingPriceCatalog,
  maskEmail,
  priceDeltaRatio,
  unknownKeyPaths,
} from "../scripts/report-billing-price-catalog-core.mjs";
import { DEFAULT_BILLING_PRICE_CATALOG } from "../lib/billingPriceCatalog.ts";

/**
 * The comparison behind `npm run report:billing-price-catalog`.
 *
 * The report's job is not to decide anything -- which number was approved is
 * not a question this repository can answer -- but to be exact about what is
 * stored, what the code would fall back to, and which of the two production is
 * actually charging. Getting that last part wrong in either direction is worse
 * than not running the report: "default is only a fallback" would understate
 * the risk, and "the stored value is live" would overstate what a corrupt row
 * is doing.
 */

const defaults = () => JSON.parse(JSON.stringify(DEFAULT_BILLING_PRICE_CATALOG));

const compare = (source, stored) =>
  compareBillingPriceCatalog({ source, stored, defaults: defaults() });

test("an identical stored catalogue reports no differences", () => {
  const result = compare("stored", defaults());
  assert.deepEqual(result.differs, []);
  assert.deepEqual(result.missingInStored, []);
  assert.deepEqual(result.missingInDefault, []);
  assert.equal(result.effectivePriceSource, "app_setting");
  assert.match(catalogFindings(result)[0], /agree on every price/);
});

test("a differing price is reported with both numbers and its own path", () => {
  const base = defaults();
  const stored = defaults();
  // Derived from the defaults rather than written out, so aligning the default
  // catalogue to a new approved price cannot silently turn this into a test of
  // two identical numbers.
  stored.plans.pro.AUD = {
    monthly: base.plans.pro.AUD.monthly + 300,
    annual: base.plans.pro.AUD.annual + 2_800,
  };
  const result = compare("stored", stored);

  assert.deepEqual(
    result.differs.map((row) => [row.path, row.storedMinor, row.defaultMinor]),
    [
      [
        "plans.pro.AUD.monthly",
        base.plans.pro.AUD.monthly + 300,
        base.plans.pro.AUD.monthly,
      ],
      [
        "plans.pro.AUD.annual",
        base.plans.pro.AUD.annual + 2_800,
        base.plans.pro.AUD.annual,
      ],
    ]
  );
  // Only those two. A report that flagged neighbouring currencies would make
  // the real difference impossible to find.
  assert.equal(result.agrees, result.rows.length - 2);
});

test("a missing row means the default is the live price, not a fallback", () => {
  const result = compare("absent", null);
  assert.equal(result.effectivePriceSource, "compiled_default");
  assert.match(
    catalogFindings(result).join(" "),
    /compiled default is the live price/
  );
  // Nothing is a "difference" when there is nothing to differ from.
  assert.deepEqual(result.differs, []);
  assert.ok(result.rows.every((row) => row.status === "no_stored_value"));
});

test("an unusable row is reported as already serving the default", () => {
  const stored = defaults();
  delete stored.plans.pro.AUD.annual;
  const result = compare("unusable", stored);

  assert.equal(result.effectivePriceSource, "compiled_default");
  assert.deepEqual(
    result.missingInStored.map((row) => row.path),
    ["plans.pro.AUD.annual"]
  );
  const findings = catalogFindings(result).join(" ");
  // The console lie is the part an operator cannot work out for themselves.
  assert.match(findings, /still shows the row's updatedAt/);
});

test("a stored price the default does not carry is its own category", () => {
  const stored = defaults();
  stored.creditPacks.legacy_100 = {
    USD: 199,
    AUD: 299,
    CNY: 1_400,
    EUR: 199,
    KRW: 2_900,
  };
  const result = compare("stored", stored);

  assert.deepEqual(result.differs, []);
  assert.equal(result.missingInDefault.length, 5);
  assert.ok(
    result.missingInDefault.every((row) =>
      row.path.startsWith("creditPacks.legacy_100.")
    )
  );
});

test("unknown keys are reported as paths, never as values", () => {
  const stored = defaults();
  stored.experimentalNote = "set during the Q3 trial";
  stored.plans.pro.internalOwner = "someone@example.com";
  const result = compare("stored", stored);

  assert.deepEqual(result.unknownKeys, [
    "experimentalNote",
    "plans.pro.internalOwner",
  ]);
  const findings = catalogFindings(result).join(" ");
  assert.match(findings, /experimentalNote/);
  // An operator pastes this into an issue. Whatever an admin once wrote into
  // the row must not travel with it.
  assert.doesNotMatch(findings, /Q3 trial/);
  assert.doesNotMatch(findings, /someone@example\.com/);
});

test("unknownKeyPaths does not descend into values that are not objects", () => {
  assert.deepEqual(unknownKeyPaths({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(unknownKeyPaths({ a: 1, b: 2 }, { a: 1 }), ["b"]);
  assert.deepEqual(unknownKeyPaths(null, { a: 1 }), []);
  assert.deepEqual(unknownKeyPaths({ a: [1, 2] }, { a: [1] }), []);
});

test("every plan price the schema requires appears in the report", () => {
  // 2 plans x 4 localized currencies x 2 intervals. A currency that quietly
  // dropped out of the loop would be a price nobody compared.
  const planRows = compare("stored", defaults()).rows.filter(
    (row) => row.kind === "plan"
  );
  assert.equal(planRows.length, 16);
  for (const currency of ["AUD", "CNY", "EUR", "KRW"]) {
    assert.equal(
      planRows.filter((row) => row.currency === currency).length,
      4,
      `${currency} must be compared for both plans and both intervals`
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Who wrote the row                                                           */
/* -------------------------------------------------------------------------- */

const AUDIT_AT = "2026-08-14T12:52:41.100Z";
const ROW_AT = "2026-08-14T12:52:41.182Z";

const auditEntry = (overrides = {}) => ({
  createdAt: AUDIT_AT,
  actorUserId: "cmdz1actor",
  actorEmail: "ops@tomverse.app",
  metadata: { localizedPricesUpdated: true },
  ...overrides,
});

test("the audit entry written with the row is the one identified", () => {
  const audits = classifyPriceAudits({
    entries: [
      auditEntry(),
      auditEntry({ createdAt: "2026-07-01T00:00:00.000Z" }),
    ],
    storedUpdatedAt: ROW_AT,
  });

  assert.deepEqual(
    audits.map((entry) => entry.wroteCurrentRow),
    [true, false]
  );
  assert.match(
    catalogFindings(compare("stored", defaults()), audits).join(" "),
    /written by o\*\*\*@tomverse\.app \(actor cmdz1actor\) at 2026-08-14/
  );
});

test("a billing.updated entry that touched no price is not a price write", () => {
  // The action covers plans, promotions and prices together. A promotion edit
  // named as the writer of a price row would be a false attribution, and the
  // whole point of this lookup is to answer "who set this price".
  const audits = classifyPriceAudits({
    entries: [auditEntry({ metadata: { localizedPricesUpdated: false } })],
    storedUpdatedAt: ROW_AT,
  });
  assert.deepEqual(audits, []);
  assert.match(
    catalogFindings(compare("stored", defaults()), audits).join(" "),
    /No `billing.updated` audit entry records a price write/
  );
});

test("a row with no matching audit entry is reported as unexplained", () => {
  // A price that changed without an audit entry did not come through the Admin
  // API. Saying "written by <whoever last used the panel>" would be worse than
  // saying nothing.
  const audits = classifyPriceAudits({
    entries: [auditEntry({ createdAt: "2026-07-01T00:00:00.000Z" })],
    storedUpdatedAt: ROW_AT,
  });
  assert.ok(audits.every((entry) => !entry.wroteCurrentRow));
  assert.match(
    catalogFindings(compare("stored", defaults()), audits).join(" "),
    /does not write an audit entry -- a migration, a seed, or a direct database edit/
  );
});

test("actor emails are masked and actor ids are not", () => {
  assert.equal(maskEmail("ops@tomverse.app"), "o***@tomverse.app");
  assert.equal(maskEmail("a@b.co"), "a***@b.co");
  assert.equal(maskEmail("not-an-email"), null);
  assert.equal(maskEmail(null), null);

  const audits = classifyPriceAudits({
    entries: [auditEntry()],
    storedUpdatedAt: ROW_AT,
  });
  assert.equal(audits[0].actorEmail, "o***@tomverse.app");
  // The id is opaque, so it travels intact and stays lookup-able.
  assert.equal(audits[0].actorUserId, "cmdz1actor");
});

test("audits are not consulted when there is nothing to consult", () => {
  // `null` means "not read", which must not be reported as "no write on
  // record" -- a run without a database would otherwise claim a fact about
  // production.
  const findings = catalogFindings(compare("absent", null), null);
  assert.doesNotMatch(findings.join(" "), /audit/i);
});

/* -------------------------------------------------------------------------- */
/* Delta                                                                       */
/* -------------------------------------------------------------------------- */

test("the delta is signed and relative to the default", () => {
  const base = defaults();
  const stored = defaults();
  stored.plans.pro.AUD.monthly = Math.round(base.plans.pro.AUD.monthly * 0.9);
  stored.plans.max.KRW.monthly = Math.round(base.plans.max.KRW.monthly * 1.05);
  const rows = compare("stored", stored).rows;
  const at = (path) => rows.find((row) => row.path === path);

  assert.ok(priceDeltaRatio(at("plans.pro.AUD.monthly")) < 0, "a cut is negative");
  assert.ok(Math.abs(priceDeltaRatio(at("plans.pro.AUD.monthly")) + 0.1) < 0.005);
  assert.ok(priceDeltaRatio(at("plans.max.KRW.monthly")) > 0, "a rise is positive");
  assert.ok(Math.abs(priceDeltaRatio(at("plans.max.KRW.monthly")) - 0.05) < 0.005);
  // An agreeing row has no delta rather than a zero one: zero would sort and
  // read as a measurement where none was taken.
  assert.equal(priceDeltaRatio(at("plans.pro.EUR.monthly")), null);
});
