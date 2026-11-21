import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePromotionCountries,
  promotionCountryFailure,
  promotionValidationError,
} from "../lib/billingPromotionCore.ts";
import {
  PROMOTION_BURST_THRESHOLD,
  promotionBurstAlertKey,
  promotionBurstBand,
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

test("a burst is banded by tens from the threshold up", () => {
  assert.equal(PROMOTION_BURST_THRESHOLD, 10);
  assert.equal(promotionBurstBand(9), null);
  assert.equal(promotionBurstBand(10), 1);
  assert.equal(promotionBurstBand(19), 1);
  assert.equal(promotionBurstBand(20), 2);
  assert.equal(promotionBurstBand(41), 4);
});

test("a count that jumps past an exact multiple still lands in the band", () => {
  // Two redemptions committing together: 9 -> 11 never shows 10.
  assert.equal(promotionBurstBand(11), 1);
});

test("one band in one time slot has one key, so it is reported once", () => {
  const now = new Date("2026-11-20T09:10:00.000Z");
  const later = new Date("2026-11-20T09:50:00.000Z");
  const nextSlot = new Date("2026-11-20T10:05:00.000Z");
  assert.equal(
    promotionBurstAlertKey("promo_1", 1, now),
    promotionBurstAlertKey("promo_1", 1, later)
  );
  assert.notEqual(
    promotionBurstAlertKey("promo_1", 1, now),
    promotionBurstAlertKey("promo_1", 2, now)
  );
  assert.notEqual(
    promotionBurstAlertKey("promo_1", 1, now),
    promotionBurstAlertKey("promo_1", 1, nextSlot)
  );
});

test("a burst band never forms on a nonsense threshold", () => {
  assert.equal(promotionBurstBand(10, 0), null);
  assert.equal(promotionBurstBand(10, -5), null);
  assert.equal(promotionBurstBand(10, Number.NaN), null);
});
