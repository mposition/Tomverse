import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePromotionCountries,
  promotionCountryFailure,
  promotionValidationError,
} from "../lib/billingPromotionCore.ts";
import {
  PROMOTION_BURST_THRESHOLD,
  promotionBurstAlertDue,
} from "../lib/promotionBurstAlertCore.ts";

test("a promotion without allowed countries is open to every visitor", () => {
  assert.equal(promotionCountryFailure({ allowedCountries: [], country: "CN" }), null);
  assert.equal(promotionCountryFailure({ allowedCountries: [], country: null }), null);
  assert.equal(
    promotionCountryFailure({ allowedCountries: undefined, country: "US" }),
    null
  );
});

test("a country-limited promotion admits only visitors from those countries", () => {
  assert.equal(promotionCountryFailure({ allowedCountries: ["AU"], country: "AU" }), null);
  assert.equal(promotionCountryFailure({ allowedCountries: ["AU"], country: "au" }), null);
  assert.equal(
    promotionCountryFailure({ allowedCountries: ["AU", "NZ"], country: "NZ" }),
    null
  );
  // The OZBFREE farm: TW/HK/SG/JP visitors.
  for (const country of ["TW", "HK", "SG", "JP", "US"]) {
    assert.equal(
      promotionCountryFailure({ allowedCountries: ["AU"], country }),
      "country_not_eligible"
    );
  }
});

test("an unknown visitor country is refused for a country-limited promotion", () => {
  assert.equal(
    promotionCountryFailure({ allowedCountries: ["AU"], country: null }),
    "country_not_eligible"
  );
  assert.equal(
    promotionCountryFailure({ allowedCountries: ["AU"], country: "" }),
    "country_not_eligible"
  );
});

test("the country refusal has its own code so the client can tell it apart", () => {
  const error = promotionValidationError("country_not_eligible");
  assert.equal(error.code, "PROMOTION_COUNTRY_NOT_ELIGIBLE");
  assert.equal(error.status, 403);
});

test("stored allowed countries parse to upper-case codes", () => {
  assert.deepEqual(parsePromotionCountries("[]"), []);
  assert.deepEqual(parsePromotionCountries(null), []);
  assert.deepEqual(parsePromotionCountries('["au"," nz "]'), ["AU", "NZ"]);
});

test("damaged allowed countries never open a promotion to everyone", () => {
  for (const damaged of ["not json", '{"AU":true}', '["Australia"]', '["AU", 7]']) {
    const parsed = parsePromotionCountries(damaged);
    assert.notDeepEqual(parsed, []);
    assert.equal(
      promotionCountryFailure({ allowedCountries: parsed, country: "AU" }),
      "country_not_eligible",
      damaged
    );
  }
});

test("a burst alert fires as the hourly count reaches each multiple of the threshold", () => {
  assert.equal(PROMOTION_BURST_THRESHOLD, 10);
  const fired = [];
  for (let count = 1; count <= 41; count += 1) {
    if (promotionBurstAlertDue(count)) fired.push(count);
  }
  assert.deepEqual(fired, [10, 20, 30, 40]);
});

test("a burst alert never fires on a nonsense threshold", () => {
  assert.equal(promotionBurstAlertDue(10, 0), false);
  assert.equal(promotionBurstAlertDue(10, -5), false);
  assert.equal(promotionBurstAlertDue(10, Number.NaN), false);
});
