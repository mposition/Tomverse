import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { EXPORT_DOMAIN_DECLARATIONS } from "../lib/accountDataExportDomains.ts";

// The export library itself imports Prisma and server-only, so the wiring check
// is exercised through the declarations plus a source scan. What matters here is
// the shape of the contract, not a live query.

test("every declaration names a domain, a model and a state", () => {
  assert.ok(EXPORT_DOMAIN_DECLARATIONS.length > 0);
  for (const declaration of EXPORT_DOMAIN_DECLARATIONS) {
    assert.match(declaration.domain, /^[a-z][A-Za-z]*$/, `bad domain: ${declaration.domain}`);
    assert.match(declaration.prismaModel, /^[A-Z]\w*$/, `bad model: ${declaration.prismaModel}`);
    assert.ok(
      ["included", "excluded", "unverified"].includes(declaration.state),
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

test("only excluded domains carry a reason", () => {
  for (const declaration of EXPORT_DOMAIN_DECLARATIONS.filter((d) => d.state !== "excluded")) {
    assert.equal(
      declaration.exclusionReason,
      undefined,
      `${declaration.domain} is ${declaration.state} but explains an exclusion`
    );
  }
});

// The three families that must never be exported. Credentials would make the
// export itself a credential; the cost tables would publish Tomverse's provider
// cost basis, which is the incident /api/models/catalog already had.
test("credentials and internal cost basis are excluded, not merely unverified", () => {
  const mustExclude = [
    "account",
    "session",
    "chatCreditReservation",
    "imageCreditReservation",
    "memoryExtractionCreditReservation",
  ];
  for (const domain of mustExclude) {
    const declaration = EXPORT_DOMAIN_DECLARATIONS.find((d) => d.domain === domain);
    assert.ok(declaration, `${domain} is not declared at all`);
    assert.equal(
      declaration.state,
      "excluded",
      `${domain} must be excluded deliberately, not left unverified`
    );
  }
});

// A fetcher that selects with a spread, or with `include`, is the pattern that
// published the model cost basis once already. Every included domain has to
// name its fields.
test("no fetcher uses a spread or include instead of a field allowlist", () => {
  const source = readFileSync(new URL("../lib/accountDataExport.ts", import.meta.url), "utf8");
  const fetcherBlock = source.slice(
    source.indexOf("const FETCHERS"),
    source.indexOf("export const exportDomainWiringProblems")
  );
  assert.ok(fetcherBlock.length > 0, "could not locate the fetcher block");
  assert.equal(/\binclude:/.test(fetcherBlock), false, "a fetcher uses include:");
  assert.equal(/\.\.\./.test(fetcherBlock), false, "a fetcher spreads a row");
  const selects = fetcherBlock.match(/select:/g) ?? [];
  const included = EXPORT_DOMAIN_DECLARATIONS.filter((d) => d.state === "included").length;
  assert.ok(
    selects.length >= included,
    `${selects.length} select blocks for ${included} included domains`
  );
});

test("an included domain never also declares an exclusion reason", () => {
  const included = EXPORT_DOMAIN_DECLARATIONS.filter((d) => d.state === "included");
  assert.ok(included.length > 0, "the export covers nothing at all");
  for (const declaration of included) {
    assert.equal(declaration.exclusionReason, undefined);
  }
});
