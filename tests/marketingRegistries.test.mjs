// The claim and asset registries: what they refuse, and what the generator is
// allowed to see.
//
// Contract: docs/policy/marketing-automation.md §2 and §7.3. Both registries
// ship empty, so what is pinned here is the shape and the resolver rather than
// content — the failure these prevent is a claim or an asset being used on the
// day somebody adds one, not today.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MARKETING_CLAIMS,
  MARKETING_CLAIM_TYPES,
  generatorProjection,
  marketingClaimSchema,
  resolveMarketingClaim,
} from "../lib/marketingClaims.ts";
import {
  MARKETING_ASSET_REGISTRY_PATH,
  marketingAssetRegistrySchema,
  marketingAssetSchema,
  resolveMarketingAsset,
} from "../lib/marketingAssets.ts";

const featureClaim = (overrides = {}) => ({
  id: "claim.compare-side-by-side",
  type: "feature",
  statementKey: "marketing.compare.sideBySide",
  locales: ["en"],
  validUntil: "2027-01-31",
  gate: null,
  evidence: {
    kind: "page",
    pageRoute: "/compare-ai-models",
    localeKey: "marketing.compare.sideBySide",
  },
  ...overrides,
});

const asset = (overrides = {}) => ({
  id: "asset.compare-hero",
  provenance: "capture",
  allowedChannels: ["linkedin"],
  alt: { en: "Three answers to one question, side by side." },
  claimIds: [],
  validUntil: "2027-01-31",
  disclosure: { linkedin: "none" },
  depictsProductInterface: true,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

test("both registries ship empty, so nothing publishes before it is approved", () => {
  assert.deepEqual([...MARKETING_CLAIMS], []);
  const registry = marketingAssetRegistrySchema.parse(
    JSON.parse(readFileSync(MARKETING_ASSET_REGISTRY_PATH, "utf8")),
  );
  assert.deepEqual(registry.assets, []);
});

test("a feature claim's rendered sentence is its evidence", () => {
  assert.ok(marketingClaimSchema.safeParse(featureClaim()).success);

  // Two keys would be two strings, and the one on the page could change while
  // the one in the post stayed as it was.
  assert.equal(
    marketingClaimSchema.safeParse(
      featureClaim({
        evidence: {
          kind: "page",
          pageRoute: "/compare-ai-models",
          localeKey: "marketing.compare.somethingElse",
        },
      }),
    ).success,
    false,
  );

  // And a feature claim cannot point at somebody else's page instead.
  assert.equal(
    marketingClaimSchema.safeParse(
      featureClaim({
        evidence: {
          kind: "external",
          url: "https://example.test/features",
          scope: "features",
          readAt: "2026-09-20",
        },
      }),
    ).success,
    false,
  );
});

test("a comparison claim names where it was read and stores no quotation", () => {
  const comparison = {
    id: "claim.competitor-price",
    type: "comparison",
    statementKey: "marketing.compare.price",
    locales: ["en"],
    validUntil: "2027-01-31",
    gate: null,
    evidence: {
      kind: "external",
      url: "https://competitor.example/pricing",
      scope: "pricing-table",
      readAt: "2026-09-20",
    },
  };
  assert.ok(marketingClaimSchema.safeParse(comparison).success);

  // No field exists to put the competitor's words in, and `.strict()` is what
  // keeps one from being added by a caller.
  assert.equal(
    marketingClaimSchema.safeParse({ ...comparison, quote: "cheaper than X" })
      .success,
    false,
  );
  assert.equal(
    marketingClaimSchema.safeParse({
      ...comparison,
      evidence: { ...comparison.evidence, url: "http://competitor.example/pricing" },
    }).success,
    false,
    "evidence is read over https or it is not recorded",
  );
});

test("the generator is given the claims without their evidence", () => {
  const registry = [marketingClaimSchema.parse(featureClaim())];
  const projected = generatorProjection(registry);

  assert.equal(projected.length, 1);
  assert.equal("evidence" in projected[0], false, "the field is gone, not emptied");
  assert.equal(projected[0].id, registry[0].id);
  assert.equal(projected[0].statementKey, registry[0].statementKey);

  // Nothing in the projection mentions a route or a key of the evidence.
  assert.equal(
    JSON.stringify(projected).includes("/compare-ai-models"),
    false,
    "the evidence route is not in what the generator sees",
  );
});

test("a claim resolves for a locale, on a date, behind its gate", () => {
  const registry = [
    marketingClaimSchema.parse(featureClaim({ gate: "feature.compare" })),
  ];
  const on = new Date("2026-09-20T00:00:00.000Z");

  assert.deepEqual(
    resolveMarketingClaim({ id: "claim.missing", locale: "en", on, registry }),
    { ok: false, refusal: "unknown_claim" },
  );
  assert.deepEqual(
    resolveMarketingClaim({
      id: registry[0].id,
      locale: "ko",
      on,
      gateEnabled: true,
      registry,
    }),
    { ok: false, refusal: "locale_not_covered" },
  );
  assert.deepEqual(
    resolveMarketingClaim({
      id: registry[0].id,
      locale: "en",
      on: new Date("2027-02-01T00:00:00.000Z"),
      gateEnabled: true,
      registry,
    }),
    { ok: false, refusal: "claim_expired" },
  );

  // An unreadable flag and a flag that is off are different facts, and neither
  // publishes.
  assert.deepEqual(
    resolveMarketingClaim({ id: registry[0].id, locale: "en", on, registry }),
    { ok: false, refusal: "gate_unreadable" },
  );
  assert.deepEqual(
    resolveMarketingClaim({
      id: registry[0].id,
      locale: "en",
      on,
      gateEnabled: null,
      registry,
    }),
    { ok: false, refusal: "gate_unreadable" },
  );
  assert.deepEqual(
    resolveMarketingClaim({
      id: registry[0].id,
      locale: "en",
      on,
      gateEnabled: false,
      registry,
    }),
    { ok: false, refusal: "gate_off" },
  );

  const resolved = resolveMarketingClaim({
    id: registry[0].id,
    locale: "en",
    on,
    gateEnabled: true,
    registry,
  });
  assert.equal(resolved.ok, true);

  // The last day is inclusive, which is what a person writing that date means.
  assert.equal(
    resolveMarketingClaim({
      id: registry[0].id,
      locale: "en",
      on: new Date("2027-01-31T23:59:59.000Z"),
      gateEnabled: true,
      registry,
    }).ok,
    true,
  );
});

test("every claim type is one the resolver can be given", () => {
  for (const type of MARKETING_CLAIM_TYPES) {
    const needsPage = type === "feature" || type === "availability";
    const needsExternal = type === "comparison";
    const candidate = featureClaim({
      id: `claim.${type}`,
      type,
      evidence: needsPage
        ? featureClaim().evidence
        : needsExternal
          ? {
              kind: "external",
              url: "https://competitor.example/x",
              scope: "x",
              readAt: "2026-09-20",
            }
          : null,
    });
    assert.ok(
      marketingClaimSchema.safeParse(candidate).success,
      `${type} should be expressible`,
    );
  }
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

test("an AI asset may not depict the product interface", () => {
  assert.ok(marketingAssetSchema.safeParse(asset()).success);

  for (const provenance of ["ai_generated", "ai_modified"]) {
    assert.equal(
      marketingAssetSchema.safeParse(
        asset({
          provenance,
          depictsProductInterface: true,
          disclosure: { linkedin: "platform_label" },
        }),
      ).success,
      false,
      `${provenance} must not claim to show the product`,
    );
  }
});

test("an AI asset carries a disclosure on every channel it may appear on", () => {
  assert.equal(
    marketingAssetSchema.safeParse(
      asset({
        provenance: "ai_generated",
        depictsProductInterface: false,
        disclosure: { linkedin: "none" },
      }),
    ).success,
    false,
    "`none` for an AI asset is the platform's rule broken silently",
  );

  assert.ok(
    marketingAssetSchema.safeParse(
      asset({
        provenance: "ai_generated",
        depictsProductInterface: false,
        allowedChannels: ["linkedin", "x"],
        disclosure: { linkedin: "platform_label", x: "caption_disclosure" },
      }),
    ).success,
    "the decision is per channel, because the platforms do not agree",
  );
});

test("channels and disclosures name the same set", () => {
  assert.equal(
    marketingAssetSchema.safeParse(
      asset({ allowedChannels: ["linkedin", "x"], disclosure: { linkedin: "none" } }),
    ).success,
    false,
    "an allowed channel with no decision",
  );
  assert.equal(
    marketingAssetSchema.safeParse(
      asset({ disclosure: { linkedin: "none", x: "none" } }),
    ).success,
    false,
    "a decision for a channel that may not carry it",
  );
});

test("an asset needs alt text, and it resolves per locale", () => {
  assert.equal(marketingAssetSchema.safeParse(asset({ alt: {} })).success, false);

  const registry = marketingAssetRegistrySchema.parse({
    version: 1,
    assets: [marketingAssetSchema.parse(asset())],
  });
  const on = new Date("2026-09-20T00:00:00.000Z");

  assert.deepEqual(
    resolveMarketingAsset({
      id: "asset.missing",
      channel: "linkedin",
      locale: "en",
      on,
      registry,
    }),
    { ok: false, refusal: "unknown_asset" },
  );
  assert.deepEqual(
    resolveMarketingAsset({
      id: "asset.compare-hero",
      channel: "x",
      locale: "en",
      on,
      registry,
    }),
    { ok: false, refusal: "channel_not_allowed" },
  );
  assert.deepEqual(
    resolveMarketingAsset({
      id: "asset.compare-hero",
      channel: "linkedin",
      locale: "ko",
      on,
      registry,
    }),
    { ok: false, refusal: "no_alt_for_locale" },
  );
  assert.deepEqual(
    resolveMarketingAsset({
      id: "asset.compare-hero",
      channel: "linkedin",
      locale: "en",
      on: new Date("2027-02-01T00:00:00.000Z"),
      registry,
    }),
    { ok: false, refusal: "asset_expired" },
  );

  const resolved = resolveMarketingAsset({
    id: "asset.compare-hero",
    channel: "linkedin",
    locale: "en",
    on,
    registry,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.disclosure, "none");
});

test("the registry refuses two assets with one id", () => {
  assert.equal(
    marketingAssetRegistrySchema.safeParse({
      version: 1,
      assets: [marketingAssetSchema.parse(asset()), marketingAssetSchema.parse(asset())],
    }).success,
    false,
  );
});
