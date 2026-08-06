import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  EXPORT_DOMAIN_DECLARATIONS,
  EXPORTED_STATES,
  isExportedState,
} from "../lib/accountDataExportDomains.ts";

// The export library itself imports Prisma and server-only, so the wiring check
// is exercised through the declarations plus a source scan. What matters here is
// the shape of the contract, not a live query -- the query side is covered by
// tests/integration/account-data-export.db.test.ts, where a sentinel planted in
// every withheld column has to be absent from the serialised export.

const source = readFileSync(new URL("../lib/accountDataExport.ts", import.meta.url), "utf8");
const fetcherBlock = source.slice(
  source.indexOf("const FETCHERS"),
  source.indexOf("export const exportDomainWiringProblems")
);

test("every declaration names a domain, a public name, a model and a state", () => {
  assert.ok(EXPORT_DOMAIN_DECLARATIONS.length > 0);
  for (const declaration of EXPORT_DOMAIN_DECLARATIONS) {
    assert.match(declaration.domain, /^[a-z][A-Za-z]*$/, `bad domain: ${declaration.domain}`);
    assert.match(declaration.prismaModel, /^[A-Z]\w*$/, `bad model: ${declaration.prismaModel}`);
    assert.ok(
      ["included", "included_filtered", "excluded", "unverified"].includes(declaration.state),
      `bad state for ${declaration.domain}`
    );
  }
});

test("domains are unique", () => {
  const seen = new Set();
  for (const declaration of EXPORT_DOMAIN_DECLARATIONS) {
    assert.ok(!seen.has(declaration.domain), `duplicate: ${declaration.domain}`);
    seen.add(declaration.domain);
  }
});

// The name in the file is the part a user's own tooling depends on. Prisma
// model names move with refactors; an export somebody downloaded two years ago
// should still parse.
test("public names are stable, unique and not Prisma model names", () => {
  const seen = new Set();
  for (const declaration of EXPORT_DOMAIN_DECLARATIONS) {
    assert.match(
      declaration.publicName,
      /^[a-z][a-z0-9_]*$/,
      `${declaration.domain} has an unstable publicName: ${declaration.publicName}`
    );
    assert.ok(!seen.has(declaration.publicName), `duplicate publicName: ${declaration.publicName}`);
    seen.add(declaration.publicName);
  }
});

// An exclusion without a reason is indistinguishable from an oversight, and the
// user receiving the export cannot tell which one it was.
test("every excluded domain carries its reason", () => {
  for (const declaration of EXPORT_DOMAIN_DECLARATIONS.filter((d) => d.state === "excluded")) {
    assert.ok(
      typeof declaration.exclusionReason === "string" && declaration.exclusionReason.trim() !== "",
      `${declaration.domain} is excluded without a reason`
    );
  }
});

test("only excluded domains carry an exclusion reason", () => {
  for (const declaration of EXPORT_DOMAIN_DECLARATIONS.filter((d) => d.state !== "excluded")) {
    assert.equal(
      declaration.exclusionReason,
      undefined,
      `${declaration.domain} is ${declaration.state} but explains an exclusion`
    );
  }
});

// The state that needs the most care. A projection the user is not told about
// reads as a complete answer, which is worse than an outright exclusion:
// nothing in the file says anything is missing.
test("every included_filtered domain says what was withheld and why", () => {
  const filtered = EXPORT_DOMAIN_DECLARATIONS.filter((d) => d.state === "included_filtered");
  assert.ok(filtered.length > 0, "nothing is filtered, so the state is unused");
  for (const declaration of filtered) {
    assert.ok(
      typeof declaration.withheldReason === "string" && declaration.withheldReason.trim() !== "",
      `${declaration.domain} is included_filtered without a withheldReason`
    );
  }
});

test("only included_filtered domains carry a withheld reason", () => {
  for (const declaration of EXPORT_DOMAIN_DECLARATIONS.filter(
    (d) => d.state !== "included_filtered"
  )) {
    assert.equal(
      declaration.withheldReason,
      undefined,
      `${declaration.domain} is ${declaration.state} but explains a projection`
    );
  }
});

test("isExportedState covers exactly the states that reach the file", () => {
  assert.deepEqual(EXPORTED_STATES, ["included", "included_filtered"]);
  assert.equal(isExportedState("included"), true);
  assert.equal(isExportedState("included_filtered"), true);
  assert.equal(isExportedState("excluded"), false);
  assert.equal(isExportedState("unverified"), false);
});

// The families that must never leave the building intact. Credentials would
// make the export itself a credential; the cost tables would publish Tomverse's
// provider cost basis, which is the incident /api/models/catalog already had.
// The answer is a projection, not an exclusion: excluding the whole table would
// throw away the point of having a field allowlist, and the user really is
// entitled to know which providers they linked and what they were charged.
test("credential and cost-basis tables are filtered deliberately, not left unverified", () => {
  const mustFilter = [
    "user",
    "account",
    "session",
    "billingTransaction",
    "chatCreditReservation",
    "imageCreditReservation",
    "memoryExtractionCreditReservation",
  ];
  for (const domain of mustFilter) {
    const declaration = EXPORT_DOMAIN_DECLARATIONS.find((d) => d.domain === domain);
    assert.ok(declaration, `${domain} is not declared at all`);
    assert.equal(
      declaration.state,
      "included_filtered",
      `${domain} must be a deliberate projection, not left unverified or excluded wholesale`
    );
  }
});

// The specific columns that would turn the export file into a live credential.
// A source scan is weaker than the sentinel test in the integration suite, but
// it fails in the pull request rather than only where a database exists.
test("no fetcher selects a credential column", () => {
  assert.ok(fetcherBlock.length > 0, "could not locate the fetcher block");
  const credentialColumns = [
    "access_token",
    "refresh_token",
    "id_token",
    "sessionToken",
    "session_state",
    "securityIncidentNote",
    "billingRiskStatus",
    "billingRiskReason",
    "pricingSnapshot",
    "reservationPayload",
    "stripeCustomerId",
  ];
  for (const column of credentialColumns) {
    assert.equal(
      new RegExp(`\\b${column}\\s*:\\s*true`).test(fetcherBlock),
      false,
      `a fetcher selects ${column}`
    );
  }
});

// A fetcher that selects with a spread, or with `include`, is the pattern that
// published the model cost basis once already. Every exported domain has to
// name its fields.
test("no fetcher uses a spread or include instead of a field allowlist", () => {
  assert.ok(fetcherBlock.length > 0, "could not locate the fetcher block");
  assert.equal(/\binclude:/.test(fetcherBlock), false, "a fetcher uses include:");
  assert.equal(/\.\.\./.test(fetcherBlock), false, "a fetcher spreads a row");
  const selects = fetcherBlock.match(/select:/g) ?? [];
  const exported = EXPORT_DOMAIN_DECLARATIONS.filter((d) => isExportedState(d.state)).length;
  assert.ok(
    selects.length >= exported,
    `${selects.length} select blocks for ${exported} exported domains`
  );
});

// A select naming a column that does not exist is a runtime error the moment
// somebody asks for their data, and nothing in the type system catches it: the
// fetcher table is typed as returning unknown[], which erases the literal.
// Three of these were already shipped -- conversationProject.instructions,
// memoryItem.content/category and creditPurchase.credits -- so the field names
// are pinned against prisma/schema.prisma here rather than only where a test
// database exists.
test("every selected column exists on the model it is selected from", () => {
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const columnsByModel = new Map();
  const relationTargets = new Map();
  for (const [, name, body] of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const columns = new Set();
    const relations = new Map();
    for (const line of body.split("\n")) {
      const match = /^\s{2}(\w+)\s+(\w+)(\[\])?\??/.exec(line);
      if (!match) continue;
      columns.add(match[1]);
      relations.set(match[1], match[2]);
    }
    columnsByModel.set(name, columns);
    relationTargets.set(name, relations);
  }

  // Each fetcher is `domain: (userId) => prisma.<model>.findMany({...})`, so
  // the model is recoverable from the call and the selects from the braces
  // between it and the next fetcher.
  const fetchers = [...fetcherBlock.matchAll(/prisma\.(\w+)\.findMany\(/g)];
  assert.ok(fetchers.length > 0, "found no fetchers to check");

  const capitalise = (name) => name[0].toUpperCase() + name.slice(1);
  let checked = 0;

  for (const [index, match] of fetchers.entries()) {
    const model = capitalise(match[1]);
    const columns = columnsByModel.get(model);
    assert.ok(columns, `prisma.${match[1]} does not name a model in the schema`);

    const end = fetchers[index + 1]?.index ?? fetcherBlock.length;
    const body = fetcherBlock.slice(match.index, end);

    for (const [, column] of body.matchAll(/(\w+):\s*true\b/g)) {
      // A nested select reaches a related model; accept the column if any
      // relation target of this model has it.
      const reachable =
        columns.has(column) ||
        [...(relationTargets.get(model)?.values() ?? [])].some((target) =>
          columnsByModel.get(target)?.has(column)
        );
      assert.ok(reachable, `${model} has no column "${column}", but a fetcher selects it`);
      checked += 1;
    }
  }
  assert.ok(checked > 50, `only ${checked} columns were checked`);
});

// The manifest is what makes a partial export legible. Without it, a domain
// left out is indistinguishable from a domain that held nothing.
test("the export carries a versioned manifest", () => {
  for (const field of [
    "schemaVersion",
    "generatedAt",
    "includedDomains",
    "filteredDomains",
    "excludedDomains",
    "undecidedDomains",
    "truncatedDomains",
  ]) {
    assert.ok(source.includes(field), `the manifest has no ${field}`);
  }
  assert.match(source, /EXPORT_SCHEMA_VERSION\s*=\s*\d+/);
});

// Keys in the file come from publicName. A Prisma model name reaching the
// output would tie a user's saved file to an internal refactor.
test("the export is keyed by publicName, never by the internal domain name", () => {
  const builder = source.slice(source.indexOf("export const buildAccountDataExport"));
  assert.match(builder, /data\[declaration\.publicName\]/);
  assert.equal(
    /data\[declaration\.domain\]/.test(builder),
    false,
    "the export is keyed by the internal domain name"
  );
});
