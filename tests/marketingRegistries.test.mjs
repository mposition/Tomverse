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
  MARKETING_CLAIM_REGISTRY_VERSION,
  MARKETING_CLAIM_TYPES,
  generatorProjection,
  marketingClaimRegistrySchema,
  marketingClaimUsable,
  marketingClaimSchema,
  resolveMarketingClaim,
} from "../lib/marketingClaims.ts";
import {
  MARKETING_EVIDENCE_PAGES,
  MARKETING_LOCALE_PAGE_LANGUAGE,
  isMarketingEvidenceRoute,
  unresolvedClaimEvidence,
} from "../lib/marketingEvidencePages.ts";
import {
  MARKETING_ASSET_REGISTRY_PATH,
  marketingAssetRegistrySchema,
  marketingAssetSchema,
  resolveMarketingAsset,
  loadMarketingAssetRegistry,
  AI_ORIGIN_PROVENANCES,
  MARKETING_ASSET_DISCLOSURES,
  MARKETING_ASSET_PROVENANCES,
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
  // Asked of the claim rather than of a registry. `resolveMarketingClaim()`
  // looks an id up in the registry this module owns and then asks this, and it
  // has no parameter through which a caller could name a different table --
  // the rule the link builders established.
  const claim = marketingClaimSchema.parse(
    featureClaim({ gate: "feature.compare" }),
  );
  const on = new Date("2026-09-20T00:00:00.000Z");

  assert.deepEqual(
    resolveMarketingClaim({ id: "claim.missing", locale: "en", on }),
    { ok: false, refusal: "unknown_claim" },
  );
  assert.deepEqual(
    marketingClaimUsable({ claim, locale: "ko", on, gateEnabled: true }),
    { ok: false, refusal: "locale_not_covered" },
  );
  assert.deepEqual(
    marketingClaimUsable({
      claim,
      locale: "en",
      on: new Date("2027-02-01T00:00:00.000Z"),
      gateEnabled: true,
    }),
    { ok: false, refusal: "claim_expired" },
  );

  // An unreadable flag and a flag that is off are different facts, and neither
  // publishes.
  assert.deepEqual(marketingClaimUsable({ claim, locale: "en", on }), {
    ok: false,
    refusal: "gate_unreadable",
  });
  assert.deepEqual(
    marketingClaimUsable({ claim, locale: "en", on, gateEnabled: null }),
    { ok: false, refusal: "gate_unreadable" },
  );
  assert.deepEqual(
    marketingClaimUsable({ claim, locale: "en", on, gateEnabled: false }),
    { ok: false, refusal: "gate_off" },
  );

  assert.equal(
    marketingClaimUsable({ claim, locale: "en", on, gateEnabled: true }).ok,
    true,
  );

  // The last day is inclusive, which is what a person writing that date means.
  assert.equal(
    marketingClaimUsable({
      claim,
      locale: "en",
      on: new Date("2027-01-31T23:59:59.000Z"),
      gateEnabled: true,
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

  // Through the loader, which is the only thing that makes a registry the
  // resolver accepts -- a bare `.parse()` gives a valid but mutable one.
  const registry = loadMarketingAssetRegistry({
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

// ---------------------------------------------------------------------------
// The registry itself, rather than the shape of one entry
// ---------------------------------------------------------------------------

test("the claim registry is parsed, not just typed", () => {
  // `MARKETING_CLAIMS` carries a type annotation, and `z.infer` carries
  // neither `.strict()` nor a `superRefine`. So a feature claim with no page
  // evidence, or one whose statementKey has drifted from its evidence key,
  // would satisfy the compiler and reach the Guard. The asset registry is
  // parsed from its JSON file and had no such gap; this is the claim
  // registry's version of that check.
  const parsed = marketingClaimRegistrySchema.safeParse(MARKETING_CLAIMS);
  assert.equal(parsed.success, true, parsed.error?.message);
});

test("a duplicate id is refused, because the second one never resolves", () => {
  // `marketingClaimById()` returns the first match, so a second entry under
  // the same id is in the registry, passes review, and is never used.
  const duplicated = marketingClaimRegistrySchema.safeParse([
    featureClaim(),
    featureClaim({ statementKey: "marketing.compare.different" }),
  ]);
  assert.equal(duplicated.success, false);
});

test("a registered page claim names a route whose copy can be read", () => {
  // Empty today. The day a claim is registered, this says whether the route it
  // cites is one `resolveMarketingPageEvidence()` can actually read -- a claim
  // pointing at a page whose copy is not addressable by key would otherwise
  // only fail when a post was being checked.
  for (const claim of MARKETING_CLAIMS) {
    if (claim.evidence?.kind !== "page") continue;
    assert.equal(
      isMarketingEvidenceRoute(claim.evidence.pageRoute),
      true,
      `${claim.id} cites ${claim.evidence.pageRoute}`,
    );
  }

  assert.deepEqual(unresolvedClaimEvidence(MARKETING_CLAIMS), []);
});

test("a registry that has content no longer calls itself version one", () => {
  // `MarketingPost.claimRegistryVersion` and `assetRegistryVersion` record
  // what a published post saw. A version that never moves answers that
  // question with the same number for every registry there has ever been, so
  // version 1 is reserved for the empty ones.
  if (MARKETING_CLAIMS.length > 0) {
    assert.ok(
      MARKETING_CLAIM_REGISTRY_VERSION > 1,
      "raise the claim registry version in the change that adds a claim",
    );
  }

  const registry = JSON.parse(
    readFileSync(MARKETING_ASSET_REGISTRY_PATH, "utf8"),
  );
  if (registry.assets.length > 0) {
    assert.ok(
      registry.version > 1,
      "raise the asset registry version in the change that adds an asset",
    );
  }
});

// ---------------------------------------------------------------------------
// The tables a decision is made against cannot be edited by the caller
// ---------------------------------------------------------------------------

test("every registry a Guard decision reads is frozen", () => {
  // `as const` is erased at build time and `Object.freeze` is shallow, so each
  // of these is asserted at runtime rather than believed. A writable table here
  // is a decision somebody outside this module gets to make: flipping
  // `zh-Hant` to `zh` would let a Traditional Chinese claim cite a Simplified
  // page, which is the drift the null exists to refuse.
  const frozen = [
    ["MARKETING_CLAIMS", MARKETING_CLAIMS],
    ["MARKETING_CLAIM_TYPES", MARKETING_CLAIM_TYPES],
    ["MARKETING_EVIDENCE_PAGES", MARKETING_EVIDENCE_PAGES],
    ["MARKETING_LOCALE_PAGE_LANGUAGE", MARKETING_LOCALE_PAGE_LANGUAGE],
  ];
  for (const [name, table] of frozen) {
    assert.equal(Object.isFrozen(table), true, name);
  }

  assert.throws(
    () => {
      "use strict";
      MARKETING_LOCALE_PAGE_LANGUAGE["zh-Hant"] = "zh";
    },
    TypeError,
  );
  assert.equal(MARKETING_LOCALE_PAGE_LANGUAGE["zh-Hant"], null);

  assert.throws(
    () => {
      "use strict";
      MARKETING_CLAIMS.push(featureClaim());
    },
    TypeError,
  );

  assert.throws(
    () => {
      "use strict";
      MARKETING_EVIDENCE_PAGES["/pricing"] = "faq";
    },
    TypeError,
  );
  assert.equal(isMarketingEvidenceRoute("/pricing"), false);
});

test("a parsed asset registry cannot have its provenance changed afterwards", () => {
  // The one registry that cannot be a module constant: it is read from a file
  // at runtime. So what protects it is that the checked value is immutable --
  // `superRefine` has already run by the time anybody could set `provenance`,
  // and an AI-generated asset claiming to be a capture resolves with no
  // disclosure at all.
  const loaded = loadMarketingAssetRegistry({
    version: 1,
    assets: [asset()],
  });

  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.assets), true);
  assert.equal(Object.isFrozen(loaded.assets[0]), true);
  assert.equal(Object.isFrozen(loaded.assets[0].disclosure), true);

  assert.throws(
    () => {
      "use strict";
      loaded.assets[0].provenance = "ai_generated";
    },
    TypeError,
  );
  assert.equal(loaded.assets[0].provenance, "capture");
});

test("a registry that did not come from the loader is refused outright", () => {
  // `.parse()` produces a valid registry that is still mutable, and handing
  // one to the resolver was how a checked `capture` asset could be turned into
  // `ai_generated` after every rule had run. The resolver takes only what the
  // loader made, and checks that at runtime rather than trusting the type.
  const parsed = marketingAssetRegistrySchema.parse({
    version: 1,
    assets: [asset()],
  });

  assert.deepEqual(
    resolveMarketingAsset({
      id: "asset.compare-hero",
      channel: "linkedin",
      locale: "en",
      on: new Date("2026-09-20T00:00:00.000Z"),
      registry: parsed,
    }),
    { ok: false, refusal: "registry_not_loaded" },
  );

  // A hand-made object claiming to be one is refused too.
  assert.deepEqual(
    resolveMarketingAsset({
      id: "asset.compare-hero",
      channel: "linkedin",
      locale: "en",
      on: new Date("2026-09-20T00:00:00.000Z"),
      registry: { ...parsed, assets: [{ ...asset(), provenance: "ai_generated" }] },
    }),
    { ok: false, refusal: "registry_not_loaded" },
  );
});

test("the loader mark cannot be copied onto a forged registry", () => {
  // The first attempt at this used a private symbol, which is not private
  // enough: `Object.getOwnPropertySymbols()` reaches it and a spread copies
  // it, so `{ ...loaded, assets: [forged] }` carried the mark and passed.
  // Identity cannot be copied, so membership is what is checked.
  const loaded = loadMarketingAssetRegistry({ version: 1, assets: [asset()] });
  const on = new Date("2026-09-20T00:00:00.000Z");

  const forgedAsset = {
    ...asset(),
    provenance: "ai_generated",
    depictsProductInterface: true,
    disclosure: { linkedin: "none" },
  };

  // Everything reflection offers, carried across onto an object of our own.
  const copy = { ...loaded, assets: [forgedAsset] };
  for (const key of Object.getOwnPropertySymbols(loaded)) {
    copy[key] = loaded[key];
  }
  Object.freeze(copy);

  assert.deepEqual(
    resolveMarketingAsset({
      id: forgedAsset.id,
      channel: "linkedin",
      locale: "en",
      on,
      registry: copy,
    }),
    { ok: false, refusal: "registry_not_loaded" },
  );

  // An object with the loader's own prototype is still not the loader's object.
  const impostor = Object.freeze(
    Object.assign(Object.create(Object.getPrototypeOf(loaded)), {
      version: 1,
      assets: [forgedAsset],
    }),
  );
  assert.deepEqual(
    resolveMarketingAsset({
      id: forgedAsset.id,
      channel: "linkedin",
      locale: "en",
      on,
      registry: impostor,
    }),
    { ok: false, refusal: "registry_not_loaded" },
  );

  // And the real one still resolves, so the check is identity rather than luck.
  assert.equal(
    resolveMarketingAsset({
      id: "asset.compare-hero",
      channel: "linkedin",
      locale: "en",
      on,
      registry: loaded,
    }).ok,
    true,
  );
});

test("a disclosure inherited from the prototype does not satisfy the schema", () => {
  // The schema reads `asset.disclosure[channel]` while checking that every
  // allowed channel has a decision. Without an own-property check, a property
  // on `Object.prototype` answers for a channel the asset never named -- and
  // an AI asset parses with no disclosure of its own.
  Object.defineProperty(Object.prototype, "threads", {
    value: "platform_label",
    configurable: true,
    enumerable: false,
    writable: true,
  });
  try {
    const parsed = marketingAssetSchema.safeParse(
      asset({
        provenance: "ai_generated",
        allowedChannels: ["threads"],
        disclosure: {},
      }),
    );
    assert.equal(parsed.success, false, "an empty disclosure is still empty");
  } finally {
    delete Object.prototype.threads;
  }
});

test("an inherited locale or channel is not the asset's own", () => {
  // A deep-frozen registry still inherits from `Object.prototype`. Setting a
  // property there would otherwise give every English-only asset alt text in
  // a locale nobody wrote it for, and a disclosure for a channel nobody
  // decided about.
  const registry = loadMarketingAssetRegistry({ version: 1, assets: [asset()] });
  const on = new Date("2026-09-20T00:00:00.000Z");

  Object.defineProperty(Object.prototype, "ko", {
    value: "alt text nobody wrote",
    configurable: true,
    enumerable: false,
    writable: true,
  });
  Object.defineProperty(Object.prototype, "threads", {
    value: "none",
    configurable: true,
    enumerable: false,
    writable: true,
  });
  try {
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
        channel: "threads",
        locale: "en",
        on,
        registry,
      }),
      { ok: false, refusal: "channel_not_allowed" },
    );
  } finally {
    delete Object.prototype.ko;
    delete Object.prototype.threads;
  }
});

test("the asset provenance lists are frozen", () => {
  // Splicing `ai_generated` out of the AI-origin list would let an asset claim
  // to depict the product interface with no disclosure at all, and the schema
  // reads this list at parse time.
  for (const [name, list] of [
    ["MARKETING_ASSET_PROVENANCES", MARKETING_ASSET_PROVENANCES],
    ["AI_ORIGIN_PROVENANCES", AI_ORIGIN_PROVENANCES],
    ["MARKETING_ASSET_DISCLOSURES", MARKETING_ASSET_DISCLOSURES],
  ]) {
    assert.equal(Object.isFrozen(list), true, name);
  }

  assert.throws(
    () => {
      "use strict";
      AI_ORIGIN_PROVENANCES.splice(0, 1);
    },
    TypeError,
  );

  const aiClaimingUi = marketingAssetSchema.safeParse(
    asset({ provenance: "ai_generated", depictsProductInterface: true }),
  );
  assert.equal(aiClaimingUi.success, false);
});
