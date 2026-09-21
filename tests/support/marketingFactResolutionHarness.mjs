import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative) => pathToFileURL(resolve(ROOT, relative)).href;

const world = {
  priceStored: true,
  modelPublic: true,
  featurePublic: true,
  assetKnown: true,
};

const claims = [
  {
    id: "claim.price",
    type: "pricing",
    statementKey: "price",
    locales: ["en"],
    validUntil: "2099-12-31",
    gate: null,
    planMeaning: null,
    factSource: {
      kind: "billing_plan",
      planId: "pro",
      fields: ["monthlyPriceCents"],
      targetsAustralia: false,
    },
    evidence: null,
  },
  {
    id: "claim.model",
    type: "model",
    statementKey: "model",
    locales: ["en"],
    validUntil: "2099-12-31",
    gate: null,
    planMeaning: null,
    factSource: {
      kind: "model_registry",
      modelId: "model.fixture",
      minimumPlan: "Pro",
    },
    evidence: null,
  },
  {
    id: "claim.feature",
    type: "feature",
    statementKey: "feature",
    locales: ["en"],
    validUntil: "2099-12-31",
    gate: null,
    planMeaning: null,
    factSource: null,
    evidence: {
      kind: "page",
      pageRoute: "/faq",
      localeKey: "feature",
    },
  },
];

const claimById = (id) => claims.find((claim) => claim.id === id);

mock.module(mod("lib/marketingClaims.ts"), {
  namedExports: {
    MARKETING_CLAIM_REGISTRY_VERSION: 41,
    marketingClaimById: claimById,
    resolveMarketingClaim: ({ id }) => {
      const claim = claimById(id);
      return claim ? { ok: true, claim } : { ok: false, refusal: "unknown_claim" };
    },
  },
});

mock.module(mod("lib/billingConfig.ts"), {
  namedExports: {
    getBillingPlansWithFieldSources: async () => [
      {
        plan: { id: "pro", currency: "AUD" },
        sources: {
          monthlyPriceCents: world.priceStored ? "stored" : "compiled_default",
        },
      },
    ],
  },
});

mock.module(mod("lib/billingPriceCatalog.ts"), {
  namedExports: { getBillingPriceCatalogWithMeta: async () => null },
});

mock.module(mod("lib/marketingClaimGates.ts"), {
  namedExports: { resolveMarketingClaimGate: async () => true },
});

mock.module(mod("lib/marketingEvidencePages.ts"), {
  namedExports: {
    resolveMarketingPageEvidence: () =>
      world.featurePublic
        ? { ok: true, text: "Three answers to one question, side by side." }
        : { ok: false, refusal: "key_not_found" },
  },
});

mock.module(mod("lib/modelRegistry.ts"), {
  namedExports: {
    getRuntimeModel: async () =>
      world.modelPublic
        ? {
            id: "model.fixture",
            minimumPlan: "Pro",
            enabled: true,
            publiclyListed: true,
            status: "available",
            catalogDeleted: false,
          }
        : null,
  },
});

mock.module(mod("lib/marketingAssets.ts"), {
  namedExports: {
    MARKETING_ASSET_REGISTRY_PATH: "docs/marketing/asset-registry.json",
    loadMarketingAssetRegistry: () => ({ version: 73, assets: [] }),
    resolveMarketingAsset: () =>
      world.assetKnown
        ? { ok: true, asset: {}, disclosure: "none" }
        : { ok: false, refusal: "unknown_asset" },
  },
});

const { resolveMarketingFacts } = await import(
  mod("lib/marketingFactResolution.ts")
);
const {
  guardDraft,
  sealMarketingGuardContext,
  sealMarketingTemplateProof,
} = await import(mod("lib/marketingGuardCore.ts"));

const database = {
  marketingPost: {
    findMany: async () => [
      {
        claimIds: claims.map((claim) => claim.id),
        assetIds: ["asset.hero"],
      },
    ],
  },
};

const context = sealMarketingGuardContext({
  priceFallbackAlertReady: true,
  incidentOrSecurity: "proved_false",
  testimonial: "proved_false",
  legalOrPolicy: "proved_false",
});

const decide = async ({ claimIds = [], assetIds = [], renderedText }) => {
  const facts = await resolveMarketingFacts(database, {
    claimIds,
    assetIds,
    channelId: "channel-1",
    channel: "linkedin",
    locale: "en",
    factSnapshotDigest: null,
  });
  const renderedTextDigest = createHash("sha256")
    .update(renderedText, "utf8")
    .digest("hex");
  return guardDraft({
    draft: {
      renderedText,
      locale: "en",
      channel: "linkedin",
      channelId: "channel-1",
      claimIds,
      assetIds,
      templateId: "template.fixture",
    },
    facts,
    templates: [
      sealMarketingTemplateProof({
        templateId: "template.fixture",
        channelId: "channel-1",
        channel: "linkedin",
        locale: "en",
        historyVersion: 1,
        status: "approved",
        approvedDigest: "a".repeat(64),
        renderedTextDigest,
        slotsFromRegistry: true,
        claimIds,
        assetIds,
      }),
    ],
    context,
  });
};

const bothDirections = async (name, settings, input, refusal) => {
  Object.assign(world, settings.good);
  const good = await decide(input);
  Object.assign(world, settings.bad);
  const bad = await decide(input);
  return {
    name,
    goodVerdict: good.verdict,
    goodCodes: good.codes,
    badVerdict: bad.verdict,
    badCodes: bad.codes,
    refusal,
  };
};

const results = [
  await bothDirections(
    "price",
    { good: { priceStored: true }, bad: { priceStored: false } },
    { claimIds: ["claim.price"], renderedText: "Pro gives teams room to work." },
    "price_source_not_stored",
  ),
  await bothDirections(
    "model",
    { good: { modelPublic: true }, bad: { modelPublic: false } },
    { claimIds: ["claim.model"], renderedText: "A reviewed model is available." },
    "model_claim_false",
  ),
  await bothDirections(
    "feature",
    { good: { featurePublic: true }, bad: { featurePublic: false } },
    {
      claimIds: ["claim.feature"],
      renderedText: "Three answers to one question, side by side.",
    },
    "feature_not_public",
  ),
  await bothDirections(
    "asset",
    { good: { assetKnown: true }, bad: { assetKnown: false } },
    { assetIds: ["asset.hero"], renderedText: "One view of the workspace." },
    "asset_unknown",
  ),
];

process.stdout.write(`MARKETING_FACT_RESULTS=${JSON.stringify(results)}\n`);
