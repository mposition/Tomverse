import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBillingPeriodLabel,
  formatCountedUnit,
  formatPriceWithPeriod,
  pluralizeUnit,
} from "../lib/pricingFormat.ts";

// FINAL-F006: /pricing rendered "1 credits", "A$10.00 / per month" and
// "Regular: A$20.00 / per month" in English. These lock the exact strings the
// audit asked for, plus the locales the same helpers now serve.

const CREDIT = { one: "credit", other: "credits" };

test("English credit counts use the singular only for exactly one", () => {
  assert.equal(formatCountedUnit(0, CREDIT, "en"), "0 credits");
  assert.equal(formatCountedUnit(1, CREDIT, "en"), "1 credit");
  assert.equal(formatCountedUnit(2, CREDIT, "en"), "2 credits");
  assert.equal(formatCountedUnit(4, CREDIT, "en"), "4 credits");
  assert.equal(formatCountedUnit(8, CREDIT, "en"), "8 credits");
});

test("the number formatter passed in is used for grouping", () => {
  const grouped = new Intl.NumberFormat("en-AU");
  assert.equal(
    formatCountedUnit(3000, CREDIT, "en", (value) => grouped.format(value)),
    "3,000 credits"
  );
});

test("languages without a singular/plural split are left unchanged", () => {
  const ko = { one: "크레딧", other: "크레딧" };
  const zh = { one: "积分", other: "积分" };
  for (const count of [0, 1, 2, 11]) {
    assert.equal(formatCountedUnit(count, ko, "ko"), `${count} 크레딧`);
    assert.equal(formatCountedUnit(count, zh, "zh"), `${count} 积分`);
  }
});

test("CLDR plural categories drive the other supported locales", () => {
  // French keeps the singular for 0 and 1; Spanish/Portuguese/German only for 1.
  assert.equal(pluralizeUnit(0, { one: "crédit", other: "crédits" }, "fr"), "crédit");
  assert.equal(pluralizeUnit(1, { one: "crédit", other: "crédits" }, "fr"), "crédit");
  assert.equal(pluralizeUnit(2, { one: "crédit", other: "crédits" }, "fr"), "crédits");

  assert.equal(pluralizeUnit(0, { one: "crédito", other: "créditos" }, "es"), "créditos");
  assert.equal(pluralizeUnit(1, { one: "crédito", other: "créditos" }, "es"), "crédito");
  assert.equal(pluralizeUnit(2, { one: "crédito", other: "créditos" }, "es"), "créditos");

  assert.equal(pluralizeUnit(1, { one: "crédito", other: "créditos" }, "pt"), "crédito");
  assert.equal(pluralizeUnit(3, { one: "crédito", other: "créditos" }, "pt"), "créditos");

  assert.equal(pluralizeUnit(1, { one: "Credit", other: "Credits" }, "de"), "Credit");
  assert.equal(pluralizeUnit(5, { one: "Credit", other: "Credits" }, "de"), "Credits");
});

test("English billing periods never gain a slash", () => {
  assert.equal(formatBillingPeriodLabel("per month", "en"), "per month");
  assert.equal(formatPriceWithPeriod("A$10.00", "per month", "en"), "A$10.00 per month");
  assert.equal(formatPriceWithPeriod("A$20.00", "per month", "en"), "A$20.00 per month");
});

test("a period string that already carries a slash is not doubled", () => {
  assert.equal(formatBillingPeriodLabel("/ per month", "en"), "per month");
  assert.equal(formatBillingPeriodLabel("/ 월", "ko"), "/ 월");
  assert.equal(formatPriceWithPeriod("$15", "/ per month", "en"), "$15 per month");
});

test("locales whose period is a bare noun keep the conventional slash", () => {
  assert.equal(formatBillingPeriodLabel("월", "ko"), "/ 월");
  assert.equal(formatBillingPeriodLabel("每月", "zh"), "/ 每月");
  assert.equal(formatPriceWithPeriod("$15", "월", "ko"), "$15 / 월");
});

test("prepositional period phrases in other locales join with a space", () => {
  assert.equal(formatBillingPeriodLabel("par mois", "fr"), "par mois");
  assert.equal(formatBillingPeriodLabel("pro Monat", "de"), "pro Monat");
  assert.equal(formatBillingPeriodLabel("al mes", "es"), "al mes");
  assert.equal(formatBillingPeriodLabel("por mês", "pt"), "por mês");
  assert.equal(formatPriceWithPeriod("15 €", "par mois", "fr"), "15 € par mois");
});
