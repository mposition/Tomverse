import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  australianPriceClaimDecision,
  catalogueClaimSourceDecision,
  modelClaimDecision,
  priceClaimSourceDecision,
} from "@/lib/marketingFactSources";
import {
  MARKETING_EVIDENCE_PAGES,
  MARKETING_LOCALE_PAGE_LANGUAGE,
  resolveMarketingPageEvidence,
  unresolvedClaimEvidence,
} from "@/lib/marketingEvidencePages";
import { MARKETING_CLAIMS } from "@/lib/marketingClaims";
import { MARKETING_LOCALES } from "@/lib/marketingAutomationSchema";
import { isPubliclySelectableModel } from "@/lib/models";
import { billingPriceCatalogSchema } from "@/lib/billingPriceCatalog";
import { infoPages } from "@/components/marketing/marketingInfoContent";

// docs/policy/marketing-automation.md §7.2 and the S1 plan's fact-source list.

test("a price claim needs every field it uses to be stored", () => {
  assert.equal(
    priceClaimSourceDecision([{ field: "monthlyPriceCents", source: "stored" }])
      .ok,
    true,
  );

  const derived = priceClaimSourceDecision([
    { field: "monthlyPriceCents", source: "stored" },
    { field: "annualPriceCents", source: "derived_formula" },
  ]);
  assert.equal(derived.ok, false);
  assert.equal(derived.refusal, "price_source_not_stored");
  assert.match(
    derived.detail,
    /annualPriceCents=derived_formula/,
    "the alert has to name the field or somebody reads a whole table",
  );

  const compiled = priceClaimSourceDecision([
    { field: "monthlyPriceCents", source: "compiled_default" },
  ]);
  assert.equal(compiled.ok, false);
  assert.equal(compiled.refusal, "price_source_not_stored");
});

test("a price claim that names no field refuses rather than passing vacuously", () => {
  // `every` on an empty array is true, which would make a malformed claim the
  // easiest one to publish.
  const empty = priceClaimSourceDecision([]);
  assert.equal(empty.ok, false);
  assert.equal(empty.refusal, "price_source_not_stored");
});

test("only a stored catalogue backs a claim; the three fallbacks do not", () => {
  assert.equal(catalogueClaimSourceDecision("stored").ok, true);
  for (const source of [
    "created_from_default",
    "default_row_unparseable",
    "default_row_invalid",
  ]) {
    const decision = catalogueClaimSourceDecision(source);
    assert.equal(decision.ok, false, source);
    assert.equal(decision.refusal, "catalogue_source_not_stored");
    assert.equal(decision.detail, source, "which fallback it was");
  }
});

test("the catalogue still carries no GST flag, so AU price claims refuse", () => {
  // The S1 plan's B2 amendment says to record this constraint rather than
  // guess GST from a number's magnitude. The assertion is on the schema, so
  // the day somebody adds the field this test says so.
  const shape = billingPriceCatalogSchema.shape;
  assert.deepEqual(
    Object.keys(shape).sort(),
    ["creditPacks", "plans", "version"],
    "a new top-level catalogue field may be the GST flag; re-read the amendment",
  );

  const withoutFlag = australianPriceClaimDecision({
    currency: "AUD",
    catalogueSource: "stored",
  });
  assert.equal(withoutFlag.ok, false);
  assert.equal(withoutFlag.refusal, "au_price_gst_unverifiable");

  // And when the flag one day exists, a stored AUD price passes this gate --
  // it is still approval_required by §7.4, which is the Guard's decision.
  assert.equal(
    australianPriceClaimDecision({
      currency: "AUD",
      catalogueSource: "stored",
      gstInclusiveDeclared: true,
    }).ok,
    true,
  );
});

test("an AU claim on a non-stored catalogue refuses for the catalogue first", () => {
  const decision = australianPriceClaimDecision({
    currency: "AUD",
    catalogueSource: "default_row_invalid",
    gstInclusiveDeclared: true,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.refusal, "catalogue_source_not_stored");
});

test("a non-AUD price is not an Australian price, and says so", () => {
  const decision = australianPriceClaimDecision({
    currency: "USD",
    catalogueSource: "stored",
    gstInclusiveDeclared: true,
  });
  assert.equal(decision.ok, false);
  assert.equal(
    decision.refusal,
    "au_price_not_in_aud",
    "a currency problem named as a GST problem sends somebody looking for a tax flag",
  );
});

const registryRow = (overrides = {}) => ({
  id: "gpt-5-6-luna",
  minimumPlan: "free",
  enabled: true,
  publiclyListed: true,
  status: "available",
  catalogDeleted: false,
  ...overrides,
});

test("a model claim is about the runtime row, and every unselectable shape refuses", () => {
  assert.equal(modelClaimDecision({ model: registryRow() }).ok, true);

  const missing = modelClaimDecision({ model: null });
  assert.equal(missing.ok, false);
  assert.equal(
    missing.refusal,
    "model_not_in_registry",
    "not in the registry is a different fact from not offered",
  );

  for (const overrides of [
    { enabled: false },
    { publiclyListed: false },
    { catalogDeleted: true },
    { status: "disabled" },
    { status: "coming-soon" },
  ]) {
    const decision = modelClaimDecision({ model: registryRow(overrides) });
    assert.equal(decision.ok, false, JSON.stringify(overrides));
    assert.equal(decision.refusal, "model_not_publicly_selectable");
  }
});

test("the selectability rule agrees with isPubliclySelectableModel", () => {
  // Restated in marketingFactSources rather than imported, so it is pinned
  // here rather than trusted.
  for (const overrides of [
    {},
    { enabled: false },
    { publiclyListed: false },
    { catalogDeleted: true },
    { status: "disabled" },
    { status: "coming-soon" },
    { status: "available", publiclyListed: undefined },
  ]) {
    const row = registryRow(overrides);
    const mine = modelClaimDecision({ model: row }).ok;
    const theirs = isPubliclySelectableModel(row);
    assert.equal(mine, theirs, JSON.stringify(overrides));
  }
});

test("a claimed minimum plan must equal the row's", () => {
  assert.equal(
    modelClaimDecision({
      model: registryRow({ minimumPlan: "pro" }),
      claimedMinimumPlan: "pro",
    }).ok,
    true,
  );

  const wrong = modelClaimDecision({
    model: registryRow({ minimumPlan: "pro" }),
    claimedMinimumPlan: "free",
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.refusal, "model_minimum_plan_mismatch");
  assert.match(wrong.detail, /free!=pro/);
});

// --- evidence pages -------------------------------------------------------

test("every mapped route is rendered by a page that names that content key", () => {
  // The mapping is only true if the route actually renders it, so the page
  // component is read rather than believed.
  for (const [route, key] of Object.entries(MARKETING_EVIDENCE_PAGES)) {
    const source = readFileSync(
      `app/(site)/(marketing)${route}/page.tsx`,
      "utf8",
    );
    assert.match(
      source,
      new RegExp(`infoPages\\.${key}\\b`),
      `${route} should render infoPages.${key}`,
    );
  }
});

test("zh-Hant resolves to no page, and every marketing locale has an answer", () => {
  // The site has one `zh` and its copy is Simplified, so a Traditional Chinese
  // claim has no page whose bytes it could be.
  assert.equal(MARKETING_LOCALE_PAGE_LANGUAGE["zh-Hant"], null);
  for (const locale of MARKETING_LOCALES) {
    assert.ok(
      locale in MARKETING_LOCALE_PAGE_LANGUAGE,
      `${locale} needs an answer, even if it is null`,
    );
  }

  const refused = resolveMarketingPageEvidence({
    pageRoute: "/faq",
    localeKey: "title",
    locale: "zh-Hant",
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.refusal, "locale_has_no_page");
});

test("a key resolves to the page's own bytes", () => {
  const resolved = resolveMarketingPageEvidence({
    pageRoute: "/faq",
    localeKey: "title",
    locale: "en",
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.text, infoPages.faq.en.title);

  const nested = resolveMarketingPageEvidence({
    pageRoute: "/faq",
    localeKey: "sections.0.title",
    locale: "ko",
  });
  assert.equal(nested.ok, true);
  assert.equal(nested.text, infoPages.faq.ko.sections[0].title);
});

test("an unmapped route, a missing key and a non-string each refuse distinctly", () => {
  assert.equal(
    resolveMarketingPageEvidence({
      pageRoute: "/pricing",
      localeKey: "title",
      locale: "en",
    }).refusal,
    "route_not_evidence_bearing",
  );
  assert.equal(
    resolveMarketingPageEvidence({
      pageRoute: "/faq",
      localeKey: "nope",
      locale: "en",
    }).refusal,
    "key_not_found",
  );
  assert.equal(
    resolveMarketingPageEvidence({
      pageRoute: "/faq",
      localeKey: "sections",
      locale: "en",
    }).refusal,
    "key_not_a_string",
    "an array is not a sentence",
  );
});

test("a prototype key is not page copy", () => {
  for (const key of [
    "constructor",
    "__proto__",
    "toString",
    "sections.0.constructor",
  ]) {
    const resolution = resolveMarketingPageEvidence({
      pageRoute: "/faq",
      localeKey: key,
      locale: "en",
    });
    assert.equal(resolution.ok, false, key);
    assert.equal(resolution.refusal, "key_not_found", key);
  }
});

test("the registered claims all resolve their page evidence", () => {
  // Empty today, which is the point: the day somebody registers a claim, this
  // says whether the sentence it cites is still on the page it names.
  assert.deepEqual(unresolvedClaimEvidence(MARKETING_CLAIMS), []);
});

test("a claim naming a moved sentence is reported per locale", () => {
  const claims = [
    {
      id: "feature.gone",
      type: "feature",
      locales: ["en", "ko", "zh-Hant"],
      evidence: { kind: "page", pageRoute: "/faq", localeKey: "movedAway" },
    },
    {
      id: "feature.fine",
      type: "feature",
      locales: ["en"],
      evidence: { kind: "page", pageRoute: "/faq", localeKey: "title" },
    },
    {
      id: "comparison.elsewhere",
      type: "comparison",
      locales: ["en"],
      evidence: { kind: "external", pageRoute: undefined, localeKey: undefined },
    },
    {
      // The one a skip-on-kind check agrees it has nothing to verify.
      id: "feature.noEvidenceAtAll",
      type: "availability",
      locales: ["en"],
      evidence: null,
    },
  ];

  assert.deepEqual(unresolvedClaimEvidence(claims), [
    { claimId: "feature.gone", locale: "en", refusal: "key_not_found" },
    { claimId: "feature.gone", locale: "ko", refusal: "key_not_found" },
    { claimId: "feature.gone", locale: "zh-Hant", refusal: "locale_has_no_page" },
    {
      claimId: "feature.noEvidenceAtAll",
      locale: null,
      refusal: "evidence_not_page",
    },
  ]);
});
