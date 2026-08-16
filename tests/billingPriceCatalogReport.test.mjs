import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogFindings,
  compareBillingPriceCatalog,
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
  const stored = defaults();
  stored.plans.pro.AUD = { monthly: 2_000, annual: 19_200 };
  const result = compare("stored", stored);

  assert.deepEqual(
    result.differs.map((row) => [row.path, row.storedMinor, row.defaultMinor]),
    [
      ["plans.pro.AUD.monthly", 2_000, 2_300],
      ["plans.pro.AUD.annual", 19_200, 22_000],
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
