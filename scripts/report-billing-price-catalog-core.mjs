// What does production actually charge, and does the code's default agree?
//
// Pure half of `npm run report:billing-price-catalog`. Everything here works on
// two plain objects -- the stored catalogue and the compiled default -- so the
// comparison can be tested without a database and the script half can stay
// nothing but a read and a print.
//
// The distinction this exists to draw is between three states that
// `getBillingPriceCatalog()` deliberately flattens into one answer:
//
//   * `stored`     -- the AppSetting row parses and validates, and its numbers
//                     are what production charges.
//   * `absent`     -- there is no row. The next call to
//                     `getBillingPriceCatalogWithMeta()` will create one from
//                     the defaults, so the defaults ARE the price.
//   * `unusable`   -- a row exists but does not parse or does not validate.
//                     The catalogue silently falls through to the defaults, so
//                     again the defaults ARE the price -- and the Admin panel
//                     still shows the row's `updatedAt`, which reads as though
//                     the stored value were in use.
//
// In two of those three states the default is not a fallback anyone would ever
// see coming; it is the live price. That is why aligning the default with the
// approved price is a correctness question and not tidiness.

/** Currency codes the catalogue prices plans in. USD comes from BillingPlan. */
export const CATALOG_CURRENCIES = ["AUD", "CNY", "EUR", "KRW"];
const PLAN_IDS = ["pro", "max"];
const INTERVALS = ["monthly", "annual"];

/**
 * Every price the catalogue holds, flattened to addressable rows.
 *
 * Flattened rather than compared tree-to-tree so a missing branch in the stored
 * value reads as "this price is not stored" instead of vanishing from the
 * report. A price nobody mentions is exactly the kind of gap this is looking
 * for.
 */
const catalogRows = (catalog) => {
  const rows = [];
  for (const planId of PLAN_IDS) {
    for (const currency of CATALOG_CURRENCIES) {
      for (const interval of INTERVALS) {
        rows.push({
          kind: "plan",
          path: `plans.${planId}.${currency}.${interval}`,
          planId,
          currency,
          interval,
          minor: catalog?.plans?.[planId]?.[currency]?.[interval] ?? null,
        });
      }
    }
  }
  const packIds = Object.keys(catalog?.creditPacks || {}).sort();
  for (const packId of packIds) {
    for (const currency of ["USD", ...CATALOG_CURRENCIES]) {
      rows.push({
        kind: "credit_pack",
        path: `creditPacks.${packId}.${currency}`,
        packId,
        currency,
        interval: null,
        minor: catalog?.creditPacks?.[packId]?.[currency] ?? null,
      });
    }
  }
  return rows;
};

/**
 * Key paths in the stored value that the schema does not name.
 *
 * Reported as paths without their values. An operator pasting this report into
 * an issue should not have to audit it for whatever an admin once put in the
 * row, and an unexpected key is interesting as a fact about the shape rather
 * than for what it contains.
 */
export const unknownKeyPaths = (stored, defaults, prefix = "") => {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
  if (!defaults || typeof defaults !== "object") return [];
  const paths = [];
  for (const key of Object.keys(stored)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in defaults)) {
      paths.push(path);
      continue;
    }
    paths.push(...unknownKeyPaths(stored[key], defaults[key], path));
  }
  return paths.sort();
};

/**
 * @param {object} input
 * @param {"stored"|"absent"|"unusable"} input.source Which of the three states production is in.
 * @param {object|null} input.stored The parsed stored catalogue, or null when there is none to compare.
 * @param {object} input.defaults `DEFAULT_BILLING_PRICE_CATALOG`.
 */
export const compareBillingPriceCatalog = ({ source, stored, defaults }) => {
  const defaultRows = new Map(catalogRows(defaults).map((row) => [row.path, row]));
  const storedRows = new Map(
    (stored ? catalogRows(stored) : []).map((row) => [row.path, row])
  );

  const rows = [...defaultRows.keys()].map((path) => {
    const base = defaultRows.get(path);
    const storedMinor = stored ? (storedRows.get(path)?.minor ?? null) : null;
    return {
      ...base,
      defaultMinor: base.minor,
      storedMinor,
      // "Differs" only where both numbers exist. A price the stored value does
      // not carry is `missing_in_stored`, which is a different problem from a
      // disagreement and must not be counted as one.
      status: !stored
        ? "no_stored_value"
        : storedMinor === null
          ? "missing_in_stored"
          : storedMinor === base.minor
            ? "agrees"
            : "differs",
    };
  });

  const extras = [...storedRows.keys()]
    .filter((path) => !defaultRows.has(path))
    .map((path) => ({ ...storedRows.get(path), status: "missing_in_default" }));

  const of = (status) => rows.filter((row) => row.status === status);
  return {
    source,
    // What production charges today. In `absent` and `unusable` the answer is
    // the compiled default, and saying so is the whole point of the report.
    effectivePriceSource: source === "stored" ? "app_setting" : "compiled_default",
    rows: [...rows, ...extras],
    differs: of("differs"),
    missingInStored: of("missing_in_stored"),
    missingInDefault: extras,
    agrees: of("agrees").length,
    unknownKeys: stored ? unknownKeyPaths(stored, defaults) : [],
  };
};

/** One row, formatted. `format` turns (minor, currency) into a display string. */
export const formatCatalogRow = (row, format) => {
  const stored =
    row.storedMinor === null ? "--" : format(row.storedMinor, row.currency);
  const base =
    row.defaultMinor === undefined || row.defaultMinor === null
      ? "--"
      : format(row.defaultMinor, row.currency);
  return `${row.path.padEnd(34)} stored ${stored.padStart(12)}   default ${base.padStart(12)}   ${row.status}`;
};

/**
 * What a human should do about this run.
 *
 * Deliberately not a verdict. Whether a difference is a defect depends on which
 * number finance approved, and this repository cannot know that -- reverting an
 * override with no approval record is itself a price change.
 */
export const catalogFindings = (comparison) => {
  const findings = [];
  if (comparison.source === "absent") {
    findings.push(
      "No AppSetting row: the compiled default is the live price, and the next read will write it into the database."
    );
  }
  if (comparison.source === "unusable") {
    findings.push(
      "The stored row does not validate, so the compiled default is already the live price. The Admin panel still shows the row's updatedAt, so this state does not look like a fallback from the console."
    );
  }
  if (comparison.differs.length > 0) {
    findings.push(
      `${comparison.differs.length} price(s) differ between the stored catalogue and the default. Each one is a price that would change if the row were deleted or corrupted.`
    );
  }
  if (comparison.missingInStored.length > 0) {
    findings.push(
      `${comparison.missingInStored.length} price(s) are absent from the stored value. The schema requires them, so this run read a value that would not validate.`
    );
  }
  if (comparison.missingInDefault.length > 0) {
    findings.push(
      `${comparison.missingInDefault.length} stored price(s) have no counterpart in the default catalogue.`
    );
  }
  if (comparison.unknownKeys.length > 0) {
    findings.push(
      `Stored value carries ${comparison.unknownKeys.length} key(s) the schema does not name: ${comparison.unknownKeys.join(", ")}.`
    );
  }
  if (findings.length === 0) {
    findings.push(
      "The stored catalogue and the compiled default agree on every price, so losing the row would not change what anyone is charged."
    );
  }
  return findings;
};
