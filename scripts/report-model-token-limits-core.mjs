/**
 * Where the output-token limits a model is actually served with differ from
 * the ones `lib/modelPricing.ts` states today.
 *
 * Found this way on 2026-08-23, the hard way. Trace 2e4327a9 asked
 * claude-sonnet-5 for an answer over a 16,314-token prompt and got
 * AI_EMPTY_RESPONSE.MAX_TOKENS: the reply spent 4,095 of its 4,096 allowed
 * output tokens on reasoning and stopped before writing a word. 4,096 was the
 * `advanced` class fallback, seeded into the row on 2026-07-17 when the model
 * had no pricing profile. The real profile arrived on 2026-08-04 saying
 * 128,000, reached every environment with no row yet, and reached no
 * environment that had one -- `ensureModelRegistrySeeded()` inserts with
 * `skipDuplicates: true`, and claude-sonnet-5 was not in
 * `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`.
 *
 * Why these two columns need their own reporting when prices already have
 * `check:model-pricing-db`: the three price columns are nullable, so a stored
 * NULL means "inherit the code profile" and a number means "an administrator
 * decided". `maxOutputTokens` and `reservationOutputTokens` have no such rule.
 * `registryRowToModel()` reads whatever number the row holds and prefers it,
 * `createChatBudget()` carries it into the request, and app/api/chat/route.ts
 * hands it to `streamText({ maxOutputTokens })`. A fossil in these columns is
 * not a stale label -- it is the live ceiling on every answer, and the symptom
 * is an empty reply rather than an error naming the cause.
 *
 * A report, not a gate, and deliberately so:
 *
 *   * A row that differs from the catalogue is exactly what
 *     `PUT /api/admin/models` exists to produce. A deliberate override and a
 *     fossil from before a profile edit look identical in the column; telling
 *     them apart is a question about intent, which is why `actorMetadata` is
 *     reported beside every difference rather than folded into the verdict.
 *   * `reservationOutputTokens` is a credit and cost figure. Changing one is a
 *     change to what a turn reserves against a user's balance and against the
 *     provider budget, so it belongs in an entitlement review
 *     (docs/policy/credit-and-cost-limits.md), not in a script's autofix.
 *
 * `report:model-credit-weights`, `report:credit-lot-invariants` and
 * `report:unswept-tables` are the same shape.
 */

/** Both columns match what the catalogue would produce. */
export const AGREES = "agrees";
/** `maxOutputTokens` differs; the reservation figure matches. */
export const MAX_OUTPUT_DIVERGED = "max_output_diverged";
/** `reservationOutputTokens` differs; the request cap matches. */
export const RESERVATION_DIVERGED = "reservation_diverged";
/** Both columns differ. */
export const BOTH_DIVERGED = "both_diverged";
/** In the catalogue, no registry row -- seeding has not run here. */
export const MISSING_IN_DB = "missing_in_db";
/** A registry row the compiled catalogue does not know about. */
export const UNKNOWN_TO_CODE = "unknown_to_code";
/**
 * A registry row the catalogue does not know about *and* which the tree can
 * account for: a model withdrawn on purpose, whose row was left resolvable
 * rather than deleted.
 *
 * Separated from `unknown_to_code` because the two ask for opposite things. An
 * unknown row is an open question -- a model that keeps answering under a
 * stored cap nobody is looking at. A withdrawn row is a closed one, and
 * reporting it as a finding every run teaches the reader to skim the section
 * that would otherwise carry a real unknown.
 */
export const EXPECTED_HISTORICAL_WITHDRAWAL = "expected_historical_withdrawal";

/**
 * The withdrawals this report is allowed to account for, written by hand.
 *
 * Hand-written for the same reason `GATE_EVIDENCE` in
 * report-release-gate-evidence-core.mjs is: a rule inferred from the row --
 * "disabled and absent from the catalogue, so presumably intentional" -- would
 * classify any accidental withdrawal as an expected one, which is precisely
 * the failure the `unknown_to_code` state exists to surface.
 *
 * Each field below is the literal value
 * prisma/migrations/20260801200000_withdraw_orphaned_gpt_oss_row/migration.sql
 * writes. All of them must match, by strict equality, on a row that is also
 * absent from the compiled catalogue. A row that differs in any one field --
 * re-enabled, re-listed, pointed at a different replacement, or carrying an
 * operator's own reason in place of the migration's -- is NOT this withdrawal
 * and stays `unknown_to_code`, because whatever it now is was not decided
 * here. A field the caller did not select reads as `undefined` and fails the
 * same way, so a narrowed query degrades to the louder answer rather than the
 * quieter one.
 *
 * `catalogDeleted` is deliberately not among them: the migration explains that
 * it withdrew the row rather than deleting it so the id keeps resolving for
 * conversations, ledger rows and user settings that reference it, and marking
 * it deleted is an operator's decision to make later.
 */
export const HISTORICAL_WITHDRAWALS = Object.freeze({
  "groq-gpt-oss-120b": Object.freeze({
    enabled: false,
    publiclyListed: false,
    status: "disabled",
    replacementModelId: "mistral-medium-3-1",
    operationalReason:
      "Tomverse does not list GPT-OSS: it is an open-weight line, not OpenAI hosted GPT. Removed from the catalogue on 2026-08-01.",
    userVisibleNote:
      "This model is no longer offered. Please select Mistral Medium 3.5 or another current model.",
  }),
});

/**
 * Every field of a known withdrawal present and equal, or it is not one.
 *
 * `Object.hasOwn` rather than a truthiness check on the lookup: a model id is
 * whatever string the registry holds, and `Object.prototype` answers to a few
 * of them. A row called `constructor` would otherwise find a function, iterate
 * none of its fields, and pass an `every` over an empty list.
 */
const matchesHistoricalWithdrawal = (row) => {
  if (!Object.hasOwn(HISTORICAL_WITHDRAWALS, row.id)) return false;
  const expected = HISTORICAL_WITHDRAWALS[row.id];
  return Object.entries(expected).every(
    ([field, value]) => row[field] === value
  );
};

/**
 * Whether a row names a human who last wrote it.
 *
 * `updatedByEmail`/`updatedById` are set by `PUT /api/admin/models` and by
 * nothing else -- neither seeding nor reconciliation writes them. So a row
 * with neither has never been touched by an operator, which makes a
 * difference on it far more likely to be a stranded seed value than a
 * decision. It is evidence, not proof: an operator could have set the same
 * number the seed already held, and a row edited before the actor columns
 * existed carries none either.
 */
export const ACTOR_PRESENT = "operator";
export const ACTOR_ABSENT = "seed_or_unknown";

/** Reconciliation carries this model's whole reviewed metadata block. */
export const SCOPE_FULL = "full";
/**
 * Reconciliation carries this model's output cap and nothing else, so a
 * reservation difference on it is NOT going to be corrected by a restart --
 * see OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS in lib/modelRegistryShared.ts.
 * Reporting one as "pending" would promise a fix nothing is going to make.
 */
export const SCOPE_OUTPUT_CAP_ONLY = "output_cap_only";
/**
 * The mirror image: reconciliation carries the reservation figure alone, so a
 * cap difference on this model is the one nothing will correct
 * (RESERVATION_ONLY_RECONCILIATION_MODEL_IDS).
 */
export const SCOPE_RESERVATION_ONLY = "reservation_only";

/** Which of the two columns a scope actually writes. */
const FIELDS_BY_SCOPE = {
  [SCOPE_FULL]: { cap: true, reservation: true },
  [SCOPE_OUTPUT_CAP_ONLY]: { cap: true, reservation: false },
  [SCOPE_RESERVATION_ONLY]: { cap: false, reservation: true },
};

const stateFor = (maxAgrees, reservationAgrees) => {
  if (maxAgrees && reservationAgrees) return AGREES;
  if (!maxAgrees && !reservationAgrees) return BOTH_DIVERGED;
  return maxAgrees ? RESERVATION_DIVERGED : MAX_OUTPUT_DIVERGED;
};

/**
 * Compare stored token limits against the compiled runtime catalogue.
 *
 * `catalogueModels` are `{ id, provider, enabled, maxOutputTokens,
 * reservationOutputTokens }` taken from `STATIC_RUNTIME_MODELS`, which is
 * `AVAILABLE_MODELS` already resolved through `getModelBillingProfile()` --
 * so the two numbers are exactly what a fresh seed would write today,
 * including the class fallback for a model with no profile.
 *
 * `storedRows` are `{ id, provider, enabled, maxOutputTokens,
 * reservationOutputTokens, updatedByEmail, updatedById, updatedAt }` from
 * `ModelRegistryEntry`, optionally with the lifecycle columns
 * `publiclyListed`, `status`, `replacementModelId`, `operationalReason` and
 * `userVisibleNote`. Those five are read for one purpose only -- telling a
 * deliberately withdrawn row apart from an unexplained one -- and a caller
 * that omits them loses that distinction rather than any part of the token
 * comparison. A NULL token column reads as `null` and is reported as
 * a difference from a catalogue number, because `registryRowToModel()` turns
 * it into `undefined` and the pricing profile then supplies the value -- which
 * is the one shape where the row and the served request already agree.
 * `inheritsProfile` marks those so they are not read as fossils.
 *
 * `reconciledModelIds` is `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`. A
 * differing row inside that set is corrected on the next boot; one outside it
 * is corrected by nothing, which is the difference between a pending change
 * and a permanent one.
 */
export const compareTokenLimits = ({
  catalogueModels,
  storedRows,
  reconciledModelIds = [],
  outputCapOnlyModelIds = [],
  reservationOnlyModelIds = [],
}) => {
  const stored = new Map(storedRows.map((row) => [row.id, row]));
  const reconciled = new Set(reconciledModelIds);
  const capOnly = new Set(outputCapOnlyModelIds);
  const reservationOnly = new Set(reservationOnlyModelIds);
  const scopeFor = (id) =>
    !reconciled.has(id)
      ? null
      : capOnly.has(id)
        ? SCOPE_OUTPUT_CAP_ONLY
        : reservationOnly.has(id)
          ? SCOPE_RESERVATION_ONLY
          : SCOPE_FULL;
  const seen = new Set();
  const entries = [];

  for (const model of catalogueModels) {
    seen.add(model.id);
    const row = stored.get(model.id);
    if (!row) {
      entries.push({
        modelId: model.id,
        provider: model.provider,
        enabled: model.enabled !== false,
        catalogueMaxOutputTokens: model.maxOutputTokens,
        catalogueReservationOutputTokens: model.reservationOutputTokens,
        storedMaxOutputTokens: null,
        storedReservationOutputTokens: null,
        inheritsProfile: false,
        actorMetadata: ACTOR_ABSENT,
        updatedByEmail: null,
        updatedAt: null,
        reconciled: reconciled.has(model.id),
        reconciledScope: scopeFor(model.id),
        state: MISSING_IN_DB,
      });
      continue;
    }

    const storedMax = row.maxOutputTokens ?? null;
    const storedReservation = row.reservationOutputTokens ?? null;
    // A NULL column is not a fossil: registryRowToModel() drops it and the
    // pricing profile supplies the number, so the request already uses the
    // catalogue value. Report it as agreeing, and flag how it agrees.
    const inheritsProfile = storedMax === null || storedReservation === null;
    const maxAgrees =
      storedMax === null || storedMax === model.maxOutputTokens;
    const reservationAgrees =
      storedReservation === null ||
      storedReservation === model.reservationOutputTokens;

    entries.push({
      modelId: model.id,
      provider: model.provider,
      enabled: model.enabled !== false,
      catalogueMaxOutputTokens: model.maxOutputTokens,
      catalogueReservationOutputTokens: model.reservationOutputTokens,
      storedMaxOutputTokens: storedMax,
      storedReservationOutputTokens: storedReservation,
      inheritsProfile,
      actorMetadata:
        row.updatedByEmail || row.updatedById ? ACTOR_PRESENT : ACTOR_ABSENT,
      updatedByEmail: row.updatedByEmail ?? null,
      updatedAt: row.updatedAt ? String(row.updatedAt) : null,
      reconciled: reconciled.has(model.id),
      reconciledScope: scopeFor(model.id),
      state: stateFor(maxAgrees, reservationAgrees),
    });
  }

  for (const row of storedRows) {
    if (seen.has(row.id)) continue;
    entries.push({
      modelId: row.id,
      provider: row.provider ?? null,
      enabled: row.enabled !== false,
      catalogueMaxOutputTokens: null,
      catalogueReservationOutputTokens: null,
      storedMaxOutputTokens: row.maxOutputTokens ?? null,
      storedReservationOutputTokens: row.reservationOutputTokens ?? null,
      inheritsProfile: false,
      actorMetadata:
        row.updatedByEmail || row.updatedById ? ACTOR_PRESENT : ACTOR_ABSENT,
      updatedByEmail: row.updatedByEmail ?? null,
      updatedAt: row.updatedAt ? String(row.updatedAt) : null,
      reconciled: reconciled.has(row.id),
      reconciledScope: scopeFor(row.id),
      state: matchesHistoricalWithdrawal(row)
        ? EXPECTED_HISTORICAL_WITHDRAWAL
        : UNKNOWN_TO_CODE,
    });
  }

  entries.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return entries;
};

const DIVERGED_STATES = new Set([
  MAX_OUTPUT_DIVERGED,
  RESERVATION_DIVERGED,
  BOTH_DIVERGED,
]);

/**
 * The subset worth a person's attention, and why each is on the list.
 *
 * `strandedRequestCaps` is the finding this script exists for: the row caps
 * output somewhere the catalogue does not, no operator is named on it, and no
 * reconciliation covers the model. That is the exact shape claude-sonnet-5 was
 * in, and nothing in the system resolves it on its own.
 *
 * `reservationDifferences` is kept apart from it on purpose. A reservation
 * figure is a credit and cost decision, so it is reported for review and never
 * grouped with the request cap as one number to go and fix.
 */
const coverageOf = (entry) =>
  FIELDS_BY_SCOPE[entry.reconciledScope] ?? { cap: false, reservation: false };

const isFullyCovered = (entry) => {
  const covered = coverageOf(entry);
  const capDiverged =
    entry.state === MAX_OUTPUT_DIVERGED || entry.state === BOTH_DIVERGED;
  const reservationDiverged =
    entry.state === RESERVATION_DIVERGED || entry.state === BOTH_DIVERGED;
  return (
    (!capDiverged || covered.cap) &&
    (!reservationDiverged || covered.reservation)
  );
};

export const tokenLimitFindings = (entries) => {
  const diverged = entries.filter((entry) => DIVERGED_STATES.has(entry.state));
  const requestCapDifferences = diverged.filter(
    (entry) =>
      entry.state === MAX_OUTPUT_DIVERGED || entry.state === BOTH_DIVERGED
  );
  return {
    diverged,
    requestCapDifferences,
    strandedRequestCaps: requestCapDifferences.filter(
      (entry) =>
        !coverageOf(entry).cap && entry.actorMetadata === ACTOR_ABSENT
    ),
    operatorOwnedRequestCaps: requestCapDifferences.filter(
      (entry) => entry.actorMetadata === ACTOR_PRESENT
    ),
    reservationDifferences: diverged.filter(
      (entry) =>
        entry.state === RESERVATION_DIVERGED || entry.state === BOTH_DIVERGED
    ),
    // Only what a restart will genuinely correct: every difference this row
    // has must be one its scope actually writes. A narrow entry that fixes one
    // column leaves the other as a finding rather than filing it under
    // "corrected on the next boot", which would promise a fix nobody makes.
    pendingReconciliation: diverged.filter(isFullyCovered),
    unreconciledReservations: diverged.filter(
      (entry) =>
        !coverageOf(entry).reservation &&
        (entry.state === RESERVATION_DIVERGED || entry.state === BOTH_DIVERGED)
    ),
    missingInDb: entries.filter((entry) => entry.state === MISSING_IN_DB),
    unknownToCode: entries.filter((entry) => entry.state === UNKNOWN_TO_CODE),
    // Reported separately rather than dropped: the row is still serving a
    // stored cap, and a reader deciding whether to finally delete it needs to
    // see that it is there.
    expectedHistoricalWithdrawals: entries.filter(
      (entry) => entry.state === EXPECTED_HISTORICAL_WITHDRAWAL
    ),
  };
};

/**
 * Width of the state column, shared with the header the runner prints.
 * `expected_historical_withdrawal` is the longest name; without this the
 * header and that one row disagree about where the next column starts.
 */
export const STATE_COLUMN_WIDTH = EXPECTED_HISTORICAL_WITHDRAWAL.length + 2;

const tokens = (value) =>
  value === null ? "-" : value.toLocaleString("en-US");

/** One line per model, aligned, for the human-readable output. */
export const formatTokenLimitRow = (entry) => {
  const catalogue = `${tokens(entry.catalogueMaxOutputTokens)}/${tokens(
    entry.catalogueReservationOutputTokens
  )}`;
  const storedValues =
    entry.state === MISSING_IN_DB
      ? "(no row)"
      : `${tokens(entry.storedMaxOutputTokens)}/${tokens(
          entry.storedReservationOutputTokens
        )}`;
  // A model with no row has nobody who could have written to it, so the
  // provenance column is blank rather than claiming "seed_or_unknown" about a
  // row that does not exist.
  const actor = entry.state === MISSING_IN_DB ? "-" : entry.actorMetadata;
  return (
    `  ${entry.modelId.padEnd(32)}${catalogue.padEnd(18)}` +
    `${storedValues.padEnd(18)}${entry.state.padEnd(STATE_COLUMN_WIDTH)}` +
    `${actor.padEnd(17)}` +
    (entry.reconciled ? "reconciled " : "") +
    (entry.inheritsProfile ? "inherits-profile " : "") +
    (entry.enabled ? "" : "[disabled]")
  ).trimEnd();
};
