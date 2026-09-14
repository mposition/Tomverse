// Read-only, privacy-preserving evidence report for the GDPR Article 27 review.
//
// It deliberately emits only EEA-wide aggregate counts and date ranges. It
// never emits an email address, user ID, IP address, hash, or per-country small
// cell. A zero result does not prove absence because country fields are
// nullable, analytics is consent-gated, and retained data may not cover the
// service's full history.
//
// Usage:
//   npm run report:gdpr-article-27-presence
//   npm run report:gdpr-article-27-presence -- --json

import { prisma } from "../lib/prisma.ts";
import {
  ARTICLE_27_PRESENCE_VERDICTS,
  EEA_COUNTRY_CODES,
  classifyArticle27Presence,
  toIsoString,
} from "./report-gdpr-article-27-presence-core.mjs";

const asJson = process.argv.includes("--json");

const emptyReport = {
  generatedAt: new Date().toISOString(),
  databaseRead: false,
  privacy: "EEA-wide aggregate counts only; no direct identifiers or per-country cells.",
  counts: {
    eeaAccountSignals: null,
    selfDeclaredEeaAccounts: null,
    billingEeaAccounts: null,
    eeaAnalyticsEvents: null,
    paidEurTransactions: null,
  },
  dateRanges: {
    eeaAnalyticsEvents: { first: null, last: null },
    paidEurTransactions: { first: null, last: null },
  },
  verdict: ARTICLE_27_PRESENCE_VERDICTS.UNKNOWN,
  limitation:
    "No production database was read. Run in the Railway service shell where DATABASE_URL is already present.",
};

const printReport = (report) => {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("GDPR Article 27 — EEA processing presence report");
  console.log(`generatedAt: ${report.generatedAt}`);
  console.log(`databaseRead: ${report.databaseRead}`);
  console.log(`privacy: ${report.privacy}`);
  console.log(`verdict: ${report.verdict}`);
  console.log("");

  if (!report.databaseRead) {
    console.log(report.limitation);
    return;
  }

  console.log(`EEA account signals (deduplicated): ${report.counts.eeaAccountSignals}`);
  console.log(`  self-declared EEA country: ${report.counts.selfDeclaredEeaAccounts}`);
  console.log(`  EEA billing country: ${report.counts.billingEeaAccounts}`);
  console.log(`EEA consented analytics events: ${report.counts.eeaAnalyticsEvents}`);
  console.log(
    `  date range: ${report.dateRanges.eeaAnalyticsEvents.first ?? "none"} — ${report.dateRanges.eeaAnalyticsEvents.last ?? "none"}`
  );
  console.log(`Paid EUR transactions: ${report.counts.paidEurTransactions}`);
  console.log(
    `  date range: ${report.dateRanges.paidEurTransactions.first ?? "none"} — ${report.dateRanges.paidEurTransactions.last ?? "none"}`
  );
  console.log("");
  console.log(report.limitation);
};

if (!process.env.DATABASE_URL) {
  printReport(emptyReport);
  process.exit(0);
}

try {
  const [
    eeaAccountSignals,
    selfDeclaredEeaAccounts,
    billingEeaAccounts,
    eeaAnalyticsEvents,
    eeaAnalyticsRange,
    paidEurTransactions,
    paidEurRange,
  ] = await Promise.all([
    prisma.userSettings.count({
      where: {
        OR: [
          { country: { in: EEA_COUNTRY_CODES } },
          { billingCountry: { in: EEA_COUNTRY_CODES } },
        ],
      },
    }),
    prisma.userSettings.count({
      where: { country: { in: EEA_COUNTRY_CODES } },
    }),
    prisma.userSettings.count({
      where: { billingCountry: { in: EEA_COUNTRY_CODES } },
    }),
    prisma.productAnalyticsEvent.count({
      where: { country: { in: EEA_COUNTRY_CODES } },
    }),
    prisma.productAnalyticsEvent.aggregate({
      where: { country: { in: EEA_COUNTRY_CODES } },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
    }),
    prisma.billingTransaction.count({
      where: { currency: "EUR", status: "paid" },
    }),
    prisma.billingTransaction.aggregate({
      where: { currency: "EUR", status: "paid" },
      _min: { paidAt: true },
      _max: { paidAt: true },
    }),
  ]);

  const report = {
    generatedAt: new Date().toISOString(),
    databaseRead: true,
    privacy: emptyReport.privacy,
    counts: {
      eeaAccountSignals,
      selfDeclaredEeaAccounts,
      billingEeaAccounts,
      eeaAnalyticsEvents,
      paidEurTransactions,
    },
    dateRanges: {
      eeaAnalyticsEvents: {
        first: toIsoString(eeaAnalyticsRange._min.occurredAt),
        last: toIsoString(eeaAnalyticsRange._max.occurredAt),
      },
      paidEurTransactions: {
        first: toIsoString(paidEurRange._min.paidAt),
        last: toIsoString(paidEurRange._max.paidAt),
      },
    },
    limitation:
      "Positive counts confirm a stored EEA signal. Zero counts do not prove absence because country fields are nullable, analytics is opt-in, and retention is finite. EUR payments are supporting evidence, not a country-by-country census.",
  };

  report.verdict = classifyArticle27Presence({
    databaseRead: true,
    ...report.counts,
  });

  printReport(report);
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(
    `Could not produce the aggregate Article 27 report: ${message.replaceAll(process.env.DATABASE_URL, "[DATABASE_URL]")}`
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
