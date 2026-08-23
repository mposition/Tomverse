// What output-token limits is each model actually served with, and does the
// pricing profile say the same thing?
//
//   npm run report:model-token-limits
//   npm run report:model-token-limits -- --json
//
// Reads ModelRegistryEntry and compares each row's `maxOutputTokens` and
// `reservationOutputTokens` against what STATIC_RUNTIME_MODELS would seed
// today. Writes nothing, changes nothing, and exits 0 whatever it finds -- see
// the header of report-model-token-limits-core.mjs for why a difference is a
// question rather than a defect, and why the reservation figure in particular
// is never something this report proposes changing on its own.
//
// Without a DATABASE_URL there is nothing to compare against. That run says so
// and reports the catalogue's own numbers; it cannot find anything, and it
// does not pretend to have failed either.

import {
  OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS,
  STATIC_CATALOG_RECONCILIATION_MODEL_IDS,
  STATIC_RUNTIME_MODELS,
} from "../lib/modelRegistryShared.ts";
import {
  compareTokenLimits,
  formatTokenLimitRow,
  tokenLimitFindings,
} from "./report-model-token-limits-core.mjs";

const json = process.argv.includes("--json");
const databaseUrl = process.env.DATABASE_URL?.trim();

// STATIC_RUNTIME_MODELS rather than AVAILABLE_MODELS: the token columns are
// materialised by `staticModelWithRuntimeDefaults()` through
// `getModelBillingProfile()`, so these are the numbers a fresh seed writes --
// including the class fallback for a model with no profile of its own, which
// is the value that stranded claude-sonnet-5 at 4,096.
const catalogueModels = STATIC_RUNTIME_MODELS.map((model) => ({
  id: model.id,
  provider: model.provider,
  enabled: model.enabled,
  maxOutputTokens: model.maxOutputTokens ?? null,
  reservationOutputTokens: model.reservationOutputTokens ?? null,
}));

let source = "compiled_catalogue";
let storedRows = [];
let note =
  "No DATABASE_URL: nothing to compare the catalogue against, so this run can find nothing.";

if (databaseUrl) {
  try {
    const { prisma } = await import("../lib/prisma.ts");
    const rows = await prisma.modelRegistryEntry.findMany({
      select: {
        id: true,
        provider: true,
        enabled: true,
        maxOutputTokens: true,
        reservationOutputTokens: true,
        updatedById: true,
        updatedByEmail: true,
        updatedAt: true,
      },
      orderBy: [{ provider: "asc" }, { sortOrder: "asc" }],
    });
    await prisma.$disconnect().catch(() => undefined);
    if (rows.length > 0) {
      storedRows = rows;
      source = "model_registry";
      note = `Read ${rows.length} ModelRegistryEntry row(s).`;
    } else {
      note =
        "The registry is empty, so every model reports as missing_in_db rather than as agreeing.";
      source = "model_registry";
    }
  } catch (error) {
    const message = String(error?.message || error).replaceAll(
      databaseUrl,
      "[redacted]"
    );
    note = `DATABASE_URL was set but unreadable, so nothing was compared: ${message.slice(0, 200)}`;
  }
}

const entries = compareTokenLimits({
  catalogueModels,
  storedRows,
  reconciledModelIds: STATIC_CATALOG_RECONCILIATION_MODEL_IDS,
  outputCapOnlyModelIds: OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS,
});
const findings = tokenLimitFindings(entries);

if (json) {
  console.log(JSON.stringify({ source, note, findings, entries }, null, 2));
} else {
  console.log(`Model output token limits (${source})\n  ${note}\n`);
  console.log(
    `  ${"model".padEnd(32)}${"catalogue".padEnd(18)}${"stored".padEnd(18)}` +
      `${"state".padEnd(22)}last written by`
  );
  console.log(
    `  ${"".padEnd(32)}${"max/reservation".padEnd(18)}${"max/reservation".padEnd(18)}`
  );
  for (const entry of entries) console.log(formatTokenLimitRow(entry));

  if (findings.strandedRequestCaps.length > 0) {
    console.log(
      `\n  ${findings.strandedRequestCaps.length} stranded request cap(s). The row caps output where the\n` +
        "  profile does not, no operator is named on it, and no reconciliation covers the model --\n" +
        "  so nothing will resolve this on its own. This is the shape claude-sonnet-5 was in when\n" +
        "  trace 2e4327a9 returned an empty answer: reasoning filled the cap before any text.\n" +
        "  Fixing one means adding it to STATIC_CATALOG_RECONCILIATION_MODEL_IDS, not editing here."
    );
    for (const entry of findings.strandedRequestCaps) {
      console.log(
        `    ${entry.modelId}: profile ${entry.catalogueMaxOutputTokens}, served ${entry.storedMaxOutputTokens}`
      );
    }
  }

  if (findings.operatorOwnedRequestCaps.length > 0) {
    console.log(
      `\n  ${findings.operatorOwnedRequestCaps.length} request cap(s) on a row an operator has written to.\n` +
        "  PUT /api/admin/models is what produces these, so a difference here is most likely a\n" +
        "  decision. Confirm before changing one -- the column cannot say which it is."
    );
    for (const entry of findings.operatorOwnedRequestCaps) {
      console.log(
        `    ${entry.modelId}: profile ${entry.catalogueMaxOutputTokens}, served ${entry.storedMaxOutputTokens}` +
          `${entry.updatedByEmail ? ` (last written by ${entry.updatedByEmail})` : ""}`
      );
    }
  }

  if (findings.reservationDifferences.length > 0) {
    console.log(
      `\n  ${findings.reservationDifferences.length} reservation figure(s) differ from the profile.\n` +
        "  Listed for review, not for correction: reservationOutputTokens is what a turn holds\n" +
        "  against a user's credits and against the provider budget, so moving one is an\n" +
        "  entitlement decision (docs/policy/credit-and-cost-limits.md), never a sweep."
    );
    for (const entry of findings.reservationDifferences) {
      console.log(
        `    ${entry.modelId}: profile ${entry.catalogueReservationOutputTokens}, reserved ${entry.storedReservationOutputTokens}`
      );
    }
  }

  if (findings.pendingReconciliation.length > 0) {
    console.log(
      `\n  ${findings.pendingReconciliation.length} differing row(s) inside STATIC_CATALOG_RECONCILIATION_MODEL_IDS.\n` +
        "  These are corrected on the next boot; they are listed so a run mid-deploy is not read as a finding."
    );
    for (const entry of findings.pendingReconciliation) {
      console.log(
        `    ${entry.modelId}: profile ${entry.catalogueMaxOutputTokens}/${entry.catalogueReservationOutputTokens}, ` +
          `stored ${entry.storedMaxOutputTokens}/${entry.storedReservationOutputTokens}`
      );
    }
  }

  if (findings.unreconciledReservations.length > 0) {
    console.log(
      `\n  ${findings.unreconciledReservations.length} reservation figure(s) that no reconciliation covers.\n` +
        "  A cap-only entry lifts the output cap and deliberately leaves the reservation alone, so\n" +
        "  these do not clear on a restart. That is the intended state until someone decides them."
    );
  }

  if (findings.missingInDb.length > 0) {
    console.log(
      `\n  ${findings.missingInDb.length} model(s) with no registry row. Seeding inserts these on next boot.`
    );
  }

  if (findings.unknownToCode.length > 0) {
    console.log(
      `\n  ${findings.unknownToCode.length} row(s) the catalogue does not know about.\n` +
        "  A model removed from the source keeps answering under its stored cap until the row is dealt with."
    );
    for (const entry of findings.unknownToCode) {
      console.log(
        `    ${entry.modelId}: served ${entry.storedMaxOutputTokens}/${entry.storedReservationOutputTokens}`
      );
    }
  }

  if (
    findings.diverged.length === 0 &&
    findings.missingInDb.length === 0 &&
    findings.unknownToCode.length === 0
  ) {
    console.log(
      "\n  Every registry row answers under the limits the pricing profile states."
    );
  }
}
