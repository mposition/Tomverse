import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAnalyticsCountry,
  parseDefaultEnabledAnalyticsCountries,
  resolveAnalyticsConsentPolicy,
} from "../lib/analyticsConsentPolicy.ts";

test("Australia uses notice and opt-out analytics by default", () => {
  assert.deepEqual(resolveAnalyticsConsentPolicy("au"), {
    country: "AU",
    mode: "notice_opt_out",
  });
});

test("EU, EEA, UK, and Switzerland remain explicit opt-in", () => {
  for (const country of ["DE", "FR", "IE", "NO", "GB", "CH"]) {
    assert.equal(
      resolveAnalyticsConsentPolicy(country, "AU,DE,FR,IE,NO,GB,CH").mode,
      "opt_in"
    );
  }
});

test("unknown and malformed countries fail closed to explicit opt-in", () => {
  assert.deepEqual(resolveAnalyticsConsentPolicy(undefined), {
    country: "ZZ",
    mode: "opt_in",
  });
  assert.equal(resolveAnalyticsConsentPolicy("Australia").mode, "opt_in");
  assert.equal(normalizeAnalyticsCountry(" Australia "), "ZZ");
});

test("other countries are enabled only after an explicit operator allowlist", () => {
  assert.equal(resolveAnalyticsConsentPolicy("NZ").mode, "opt_in");
  assert.equal(resolveAnalyticsConsentPolicy("NZ", "AU,NZ").mode, "notice_opt_out");
  assert.deepEqual(
    [...parseDefaultEnabledAnalyticsCountries(" au, nz, invalid ")].sort(),
    ["AU", "NZ"]
  );
});

test("an explicitly empty allowlist disables default-on analytics", () => {
  assert.equal(resolveAnalyticsConsentPolicy("AU", "").mode, "opt_in");
});

