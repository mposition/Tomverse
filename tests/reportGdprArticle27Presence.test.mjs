import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTICLE_27_PRESENCE_VERDICTS,
  EEA_COUNTRY_CODES,
  classifyArticle27Presence,
  toIsoString,
} from "../scripts/report-gdpr-article-27-presence-core.mjs";

test("EEA inventory includes the EU plus Iceland, Liechtenstein, and Norway", () => {
  assert.equal(EEA_COUNTRY_CODES.length, 30);
  assert.ok(EEA_COUNTRY_CODES.includes("DE"));
  assert.ok(EEA_COUNTRY_CODES.includes("IS"));
  assert.ok(EEA_COUNTRY_CODES.includes("LI"));
  assert.ok(EEA_COUNTRY_CODES.includes("NO"));
  assert.ok(!EEA_COUNTRY_CODES.includes("GB"));
  assert.ok(!EEA_COUNTRY_CODES.includes("CH"));
});

test("a positive account, analytics, or EUR payment signal is observed", () => {
  for (const counts of [
    { eeaAccountSignals: 1, eeaAnalyticsEvents: 0, paidEurTransactions: 0 },
    { eeaAccountSignals: 0, eeaAnalyticsEvents: 1, paidEurTransactions: 0 },
    { eeaAccountSignals: 0, eeaAnalyticsEvents: 0, paidEurTransactions: 1 },
  ]) {
    assert.equal(
      classifyArticle27Presence({ databaseRead: true, ...counts }),
      ARTICLE_27_PRESENCE_VERDICTS.SIGNAL_OBSERVED
    );
  }
});

test("zero stored signals are explicitly not proof of absence", () => {
  assert.equal(
    classifyArticle27Presence({
      databaseRead: true,
      eeaAccountSignals: 0,
      eeaAnalyticsEvents: 0,
      paidEurTransactions: 0,
    }),
    ARTICLE_27_PRESENCE_VERDICTS.NO_SIGNAL_OBSERVED
  );
});

test("a skipped database read remains unknown", () => {
  assert.equal(
    classifyArticle27Presence({ databaseRead: false }),
    ARTICLE_27_PRESENCE_VERDICTS.UNKNOWN
  );
});

test("date serialization never invents a date", () => {
  assert.equal(toIsoString(new Date("2026-09-14T00:00:00.000Z")), "2026-09-14T00:00:00.000Z");
  assert.equal(toIsoString(null), null);
});
