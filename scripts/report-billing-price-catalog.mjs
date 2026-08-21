// Does the compiled default price catalogue agree with what production stores?
//
//   npm run report:billing-price-catalog
//   npm run report:billing-price-catalog -- --json
//
// Reads the `billing.fixed-prices.v1` AppSetting row and compares it against
// `DEFAULT_BILLING_PRICE_CATALOG`. Writes nothing and exits 0 whatever it
// finds: whether a difference is a defect depends on which number finance
// approved, and reverting an override that has no approval record is itself a
// price change.
//
// This reads the row directly rather than through `getBillingPriceCatalog()`,
// for two reasons. `getBillingPriceCatalogWithMeta()` *creates* the row from
// the defaults when it is missing, which a report must never do. And both
// catalogue readers collapse "missing" and "stored but unusable" into the same
// answer as "stored and valid" -- which is exactly the distinction that decides
// whether the default is a fallback or the live price.
//
// Without a DATABASE_URL there is nothing to compare against, so it prints the
// compiled default and says so. That run cannot find anything.

import { billingCurrencyFractionDigits, billingMinorToMajor } from "../lib/billingMarkets.ts";
import {
  BILLING_PRICE_CATALOG_KEY,
  DEFAULT_BILLING_PRICE_CATALOG,
  billingPriceCatalogSchema,
} from "../lib/billingPriceCatalog.ts";
import {
  catalogFindings,
  classifyPriceAudits,
  compareBillingPriceCatalog,
  formatCatalogRow,
} from "./report-billing-price-catalog-core.mjs";

/** How far back to look for the write. Enough to cover a retention window. */
const AUDIT_LOOKBACK = 50;

const json = process.argv.includes("--json");
const databaseUrl = process.env.DATABASE_URL?.trim();

const format = (minor, currency) => {
  const digits = billingCurrencyFractionDigits(currency);
  return `${currency} ${billingMinorToMajor(minor, currency).toFixed(digits)}`;
};

let source = "absent";
let stored = null;
let storedUpdatedAt = null;
let audits = null;
let note = "No DATABASE_URL: nothing to compare the compiled default against.";
let readError = null;

if (databaseUrl) {
  try {
    const { prisma } = await import("../lib/prisma.ts");
    const row = await prisma.appSetting.findUnique({
      where: { key: BILLING_PRICE_CATALOG_KEY },
      select: { value: true, updatedAt: true },
    });
    // Who wrote it, from the same read. `billing.updated` covers plans,
    // promotions and prices together, so the metadata flag is what makes an
    // entry a price write rather than a promotion edit.
    const auditRows = await prisma.adminAuditLog.findMany({
      where: { action: "billing.updated" },
      orderBy: { createdAt: "desc" },
      take: AUDIT_LOOKBACK,
      select: {
        createdAt: true,
        actorUserId: true,
        actorEmail: true,
        metadata: true,
      },
    });
    await prisma.$disconnect().catch(() => undefined);
    audits = classifyPriceAudits({
      entries: auditRows.map((entry) => ({
        createdAt: entry.createdAt,
        actorUserId: entry.actorUserId,
        actorEmail: entry.actorEmail,
        metadata: entry.metadata,
      })),
      storedUpdatedAt: row?.updatedAt.toISOString() || null,
    });
    if (!row) {
      note = `No AppSetting row for ${BILLING_PRICE_CATALOG_KEY}.`;
    } else {
      storedUpdatedAt = row.updatedAt.toISOString();
      let parsed = null;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        parsed = null;
      }
      const validated =
        parsed === null ? null : billingPriceCatalogSchema.safeParse(parsed);
      if (validated?.success) {
        source = "stored";
        stored = validated.data;
        note = `Read the stored catalogue, last written ${storedUpdatedAt}.`;
      } else {
        source = "unusable";
        // Compared anyway when it parsed as JSON: a row that merely fails
        // validation still says what somebody intended, and that is the more
        // useful thing to put in front of an operator than "invalid".
        stored = parsed && typeof parsed === "object" ? parsed : null;
        note =
          parsed === null
            ? `The stored value is not JSON (row last written ${storedUpdatedAt}).`
            : `The stored value does not match the schema (row last written ${storedUpdatedAt}).`;
      }
    }
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
    note = `Could not read AppSetting: ${readError}`;
  }
}

const comparison = compareBillingPriceCatalog({
  source: readError ? "absent" : source,
  stored,
  defaults: DEFAULT_BILLING_PRICE_CATALOG,
});
const findings = readError
  ? [`The database could not be read, so nothing below is a statement about production: ${readError}`]
  : catalogFindings(comparison, audits);

if (json) {
  console.log(
    JSON.stringify(
      {
        key: BILLING_PRICE_CATALOG_KEY,
        source: comparison.source,
        effectivePriceSource: comparison.effectivePriceSource,
        storedUpdatedAt,
        readError,
        priceWrites: audits,
        rows: comparison.rows,
        unknownKeys: comparison.unknownKeys,
        findings,
      },
      null,
      2
    )
  );
} else {
  console.log("Billing price catalogue: stored vs compiled default\n");
  console.log(`  key:       ${BILLING_PRICE_CATALOG_KEY}`);
  console.log(`  source:    ${comparison.source}`);
  console.log(`  charged:   ${comparison.effectivePriceSource}`);
  console.log(`  ${note}\n`);

  for (const row of comparison.rows) {
    console.log(`  ${formatCatalogRow(row, format)}`);
  }

  if (audits && audits.length > 0) {
    console.log("\n  Price writes on record (newest first):");
    for (const entry of audits.slice(0, 5)) {
      console.log(
        `    ${entry.at}  ${(entry.actorEmail || "unknown").padEnd(28)} ${entry.wroteCurrentRow ? "<- wrote the current row" : ""}`
      );
    }
    if (audits.length > 5) console.log(`    ... and ${audits.length - 5} older.`);
  }

  console.log("");
  for (const finding of findings) console.log(`  - ${finding}`);
  console.log(
    "\n  This report writes nothing and judges nothing. A difference is only a" +
      "\n  defect once somebody says which number was approved."
  );
}
