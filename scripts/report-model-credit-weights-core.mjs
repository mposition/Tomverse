/**
 * Where the credit price a model is actually billed at differs from the one
 * `lib/models.ts` appears to state.
 *
 * Found this way on 2026-08-15: `perplexity/sonar` carries
 * `creditWeight: 16` in the compiled catalogue and charged 20. Both numbers
 * were right about their own half. The registry row was created before the
 * 16 was written, `ensureModelRegistrySeeded()` inserts with
 * `skipDuplicates: true` so it never revisits an existing row, and
 * `perplexity/sonar` is not in `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`, so
 * nothing was ever going to carry the new value across. The edit shipped and
 * changed nothing, and reading the source is how you would have concluded it
 * worked.
 *
 * A report, not a gate. A row that differs from the catalogue is exactly what
 * `PUT /api/admin/models` exists to produce (`lib/modelRegistryAdmin.ts:45`),
 * so divergence is not by itself a defect -- an override nobody remembers
 * making and a fossil from before an edit look identical in the column, and
 * telling them apart is a question about intent. `report:unswept-tables` and
 * `report:credit-lot-invariants` are the same shape.
 *
 * Why credits need their own reporting when prices already have
 * `check:model-pricing-db`: the three price columns are nullable, so NULL
 * means "inherits the code profile" and a number means "an administrator
 * decided". `ModelRegistryEntry.creditWeight` is `Int` and not nullable. Every
 * row carries a number, no row can say where its number came from, and the two
 * sources can drift apart in silence for as long as nobody bills a turn and
 * counts.
 */

/** A row whose stored weight is the one the catalogue would produce. */
export const AGREES = "agrees";
/** Stored weight differs from what the catalogue produces today. */
export const DIVERGED = "diverged";
/** In the catalogue, no registry row -- seeding has not run here. */
export const MISSING_IN_DB = "missing_in_db";
/** A registry row the compiled catalogue does not know about. */
export const UNKNOWN_TO_CODE = "unknown_to_code";

/**
 * Compare stored credit weights against the compiled catalogue.
 *
 * `catalogueModels` are `{ id, provider, enabled, creditWeight }` already
 * resolved through `getModelUsageProfile()`, so `creditWeight` is the number
 * the catalogue would seed -- an explicit `creditWeight` where one is written,
 * the `usageClass` default otherwise. `explicitInCode` says which of those two
 * it was, because "the source names 16 and the row says 20" is a different
 * finding from "the source names nothing and both agree on the class default".
 *
 * `storedRows` are `{ id, creditWeight }` from `ModelRegistryEntry`.
 *
 * `reconciledModelIds` is `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`. A
 * diverged row inside that set will be corrected on the next boot; one outside
 * it will not be corrected by anything, which is the difference between a
 * pending change and a permanent one.
 */
export const compareCreditWeights = ({
  catalogueModels,
  storedRows,
  reconciledModelIds = [],
}) => {
  const stored = new Map(storedRows.map((row) => [row.id, row.creditWeight]));
  const reconciled = new Set(reconciledModelIds);
  const seen = new Set();
  const entries = [];

  for (const model of catalogueModels) {
    seen.add(model.id);
    const storedWeight = stored.get(model.id);
    const present = storedWeight !== undefined;
    const agrees = present && storedWeight === model.creditWeight;
    entries.push({
      modelId: model.id,
      provider: model.provider,
      enabled: model.enabled !== false,
      catalogueCredits: model.creditWeight,
      storedCredits: present ? storedWeight : null,
      explicitInCode: Boolean(model.explicitInCode),
      reconciled: reconciled.has(model.id),
      state: !present ? MISSING_IN_DB : agrees ? AGREES : DIVERGED,
    });
  }

  for (const row of storedRows) {
    if (seen.has(row.id)) continue;
    entries.push({
      modelId: row.id,
      provider: row.provider ?? null,
      enabled: row.enabled !== false,
      catalogueCredits: null,
      storedCredits: row.creditWeight,
      explicitInCode: false,
      reconciled: reconciled.has(row.id),
      state: UNKNOWN_TO_CODE,
    });
  }

  entries.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return entries;
};

/**
 * The subset worth a person's attention, and why each is on the list.
 *
 * `strandedEdits` is the finding this script exists for: the source states a
 * weight explicitly, the row disagrees, and no reconciliation covers the
 * model. Nothing in the system will resolve that on its own.
 */
export const creditWeightFindings = (entries) => {
  const diverged = entries.filter((entry) => entry.state === DIVERGED);
  return {
    diverged,
    strandedEdits: diverged.filter(
      (entry) => entry.explicitInCode && !entry.reconciled
    ),
    pendingReconciliation: diverged.filter((entry) => entry.reconciled),
    missingInDb: entries.filter((entry) => entry.state === MISSING_IN_DB),
    unknownToCode: entries.filter((entry) => entry.state === UNKNOWN_TO_CODE),
  };
};

/** One line per model, aligned, for the human-readable output. */
export const formatCreditWeightRow = (entry) => {
  const catalogue =
    entry.catalogueCredits === null
      ? "-"
      : `${entry.catalogueCredits}${entry.explicitInCode ? "" : " (class)"}`;
  const storedCredits =
    entry.storedCredits === null ? "(no row)" : String(entry.storedCredits);
  return (
    `  ${entry.modelId.padEnd(34)}${String(catalogue).padEnd(14)}` +
    `${storedCredits.padEnd(12)}${entry.state.padEnd(17)}` +
    (entry.reconciled ? "reconciled" : "") +
    (entry.enabled ? "" : "   [disabled]")
  );
};
