import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Session } from "next-auth";

import { getImageModel, IMAGE_MODEL_REGISTRY, resetActiveImageModelCatalog } from "@/lib/imageModelRegistry";
import {
  latestCodingSnapshot,
  publishCodingSnapshot,
  refreshImageModelCatalog,
} from "@/lib/modelCatalog";
import {
  applyCatalogDraft,
  CatalogRefusal,
  catalogPatchBodySchema,
  createImagePriceRevision,
  storeCatalogDraft,
  updateCatalogEntry,
} from "@/lib/modelCatalogAdmin";
import { prisma } from "@/lib/prisma";

// The dynamic model catalogue against a real database: a refused enable writes
// nothing, every accepted write has its audit row, price revisions cannot be
// edited or deleted, snapshots cannot change, and the image lookups serve what
// an operator set.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const session = {
  user: { id: "catalog-test-admin", email: "catalog-admin@example.test" },
  expires: "2099-01-01T00:00:00.000Z",
} as unknown as Session;

const enabledSeed = IMAGE_MODEL_REGISTRY.find((model) => model.disabledReason === null)!;
const heldSeed = IMAGE_MODEL_REGISTRY.find((model) => model.disabledReason === "worst_case_cost_unbounded")!;

const withTriggersOff = async (table: string, trigger: string, sql: string) => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  try {
    await prisma.$executeRawUnsafe(sql);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
  }
};

const cleanup = async () => {
  await prisma.modelCatalogEntry.deleteMany({});
  await withTriggersOff(
    "ModelCatalogPriceRevision",
    "ModelCatalogPriceRevision_append_only_trigger",
    `DELETE FROM "ModelCatalogPriceRevision"`
  );
  await withTriggersOff("ModelCatalogSnapshot", "ModelCatalogSnapshot_immutable_trigger", `DELETE FROM "ModelCatalogSnapshot"`);
  resetActiveImageModelCatalog();
};

before(cleanup);
after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("the PATCH body accepts category and modelId with the patch fields", () => {
  // An intersection with the strict patch schema rejected every PATCH (review finding 2026-10-19).
  const parsed = catalogPatchBodySchema.parse({ category: "image", modelId: enabledSeed.id, enabled: false, holdReason: "x" });
  assert.equal(parsed.modelId, enabledSeed.id);
  assert.throws(() => catalogPatchBodySchema.parse({ category: "image", modelId: enabledSeed.id, extra: 1 }));
});

const auditCount = (action: string) => prisma.adminAuditLog.count({ where: { action } });

test("turning on a model the judge refuses writes neither the row nor an audit entry", async () => {
  const auditsBefore = await auditCount("model_catalog.entry_updated");
  await assert.rejects(
    updateCatalogEntry({ category: "image", modelId: heldSeed.id, patch: { enabled: true }, session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "not_admitted"
  );
  assert.equal(
    await prisma.modelCatalogEntry.count({ where: { category: "image", modelId: heldSeed.id } }),
    0
  );
  assert.equal(await auditCount("model_catalog.entry_updated"), auditsBefore);
});

test("a hold takes effect in the lookups, with its audit row", async () => {
  const auditsBefore = await auditCount("model_catalog.entry_updated");
  await updateCatalogEntry({
    category: "image",
    modelId: enabledSeed.id,
    patch: { holdReason: "provider incident" },
    session,
  });
  assert.equal(await auditCount("model_catalog.entry_updated"), auditsBefore + 1);
  await refreshImageModelCatalog({ force: true });
  assert.equal(getImageModel(enabledSeed.id)?.disabledReason, "operational_hold");

  await updateCatalogEntry({
    category: "image",
    modelId: enabledSeed.id,
    patch: { holdReason: null, enabled: null },
    session,
  });
  await refreshImageModelCatalog({ force: true });
  assert.equal(getImageModel(enabledSeed.id)?.disabledReason, null);
});

const verification = {
  verifiedAt: "2026-10-19",
  sources: ["https://developers.openai.com/api/docs/pricing"],
  thinkingCapMicroUsd: 0,
};

test("a price revision is append-only, not retroactive, and cites official sources", async () => {
  const created = await createImagePriceRevision({
    modelId: enabledSeed.id,
    revision: {
      pricingVersion: `${enabledSeed.id}-catalog-test-v1`,
      prices: [{ quality: "low", size: "1024x1024", credits: 50, outputCostMicroUsd: 6_000 }],
      verification,
    },
    session,
  });
  await refreshImageModelCatalog({ force: true });
  assert.equal(getImageModel(enabledSeed.id)?.pricingVersion, `${enabledSeed.id}-catalog-test-v1`);
  assert.equal(await auditCount("model_catalog.price_revision_created") >= 1, true);

  await assert.rejects(
    prisma.modelCatalogPriceRevision.update({ where: { id: created.id }, data: { pricingVersion: "edited" } }),
    /append-only/
  );
  await assert.rejects(prisma.modelCatalogPriceRevision.delete({ where: { id: created.id } }), /append-only/);

  // Below the credit floor: refused before it is stored (review finding 2026-10-19).
  await assert.rejects(
    createImagePriceRevision({
      modelId: enabledSeed.id,
      revision: {
        pricingVersion: "below-floor",
        prices: [{ quality: "high", size: "1024x1024", credits: 1, outputCostMicroUsd: 2_000_000 }],
        verification,
      },
      session,
    }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "not_admitted"
  );
  await assert.rejects(
    createImagePriceRevision({
      modelId: enabledSeed.id,
      revision: {
        pricingVersion: "retro",
        prices: [{ quality: "low", size: "1024x1024", credits: 50, outputCostMicroUsd: 6_000 }],
        verification,
        effectiveFrom: "2020-01-01T00:00:00.000Z",
      },
      session,
    }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "retroactive_price"
  );
  await assert.rejects(
    createImagePriceRevision({
      modelId: enabledSeed.id,
      revision: {
        pricingVersion: "blog",
        prices: [{ quality: "low", size: "1024x1024", credits: 50, outputCostMicroUsd: 6_000 }],
        verification: { ...verification, sources: ["https://someblog.example/pricing"] },
      },
      session,
    }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "unofficial_source"
  );
  await assert.rejects(
    createImagePriceRevision({
      modelId: enabledSeed.id,
      revision: {
        pricingVersion: `${enabledSeed.id}-catalog-test-v1`,
        prices: [{ quality: "low", size: "1024x1024", credits: 50, outputCostMicroUsd: 6_000 }],
        verification,
      },
      session,
    }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "pricing_version_reused"
  );
});

const codingProfile = {
  name: "Catalog Test Coder",
  provider: "openai",
  apiModelId: "gpt-catalog-test",
  minimumPlan: "Pro",
  capabilities: {
    toolCalling: "parallel",
    structuredOutput: "strict_schema",
    imageInput: false,
    maxContextTokens: 200_000,
    maxOutputTokens: 32_000,
  },
  pricing: {
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 8,
    creditWeight: 4,
    verifiedAt: "2026-10-19",
    sources: ["https://developers.openai.com/api/docs/pricing"],
  },
  terms: {
    allowsResaleAndCodingAgent: true,
    url: "https://openai.com/policies/services-agreement",
    checkedAt: "2026-10-19",
  },
  retention: { url: "https://platform.openai.com/docs/guides/your-data", checkedAt: "2026-10-19" },
  processingRegion: "US",
};

test("a coding model is published in an immutable snapshot only once admitted and on", async () => {
  await updateCatalogEntry({ category: "coding", modelId: "gpt-catalog-test", patch: { profile: codingProfile }, session });
  const empty = await publishCodingSnapshot({ session });
  assert.equal(empty.snapshot.models.length, 0);

  await updateCatalogEntry({ category: "coding", modelId: "gpt-catalog-test", patch: { enabled: true }, session });
  const first = await publishCodingSnapshot({ session });
  assert.equal(first.created, true);
  assert.deepEqual(first.snapshot.models.map((m) => m.modelId), ["gpt-catalog-test"]);

  const again = await publishCodingSnapshot({ session });
  assert.equal(again.created, false);
  assert.equal(again.snapshot.version, first.snapshot.version);
  assert.equal((await latestCodingSnapshot())?.contentHash, first.snapshot.contentHash);

  await assert.rejects(
    prisma.modelCatalogSnapshot.update({ where: { version: first.snapshot.version }, data: { contentHash: "0".repeat(64) } }),
    /immutable/
  );

  const refused = { ...codingProfile, terms: { ...codingProfile.terms, allowsResaleAndCodingAgent: false } };
  await assert.rejects(
    updateCatalogEntry({ category: "coding", modelId: "gpt-catalog-test", patch: { profile: refused }, session }),
    (error: unknown) =>
      error instanceof CatalogRefusal && error.code === "not_admitted" && error.reasons.includes("terms_do_not_allow")
  );
});

test("a stored draft is audited, applied in one step, and cleared", async () => {
  const draftsBefore = await auditCount("model_catalog.draft_stored");
  await storeCatalogDraft({ category: "coding", modelId: "gpt-draft-test", draft: codingProfile, session });
  assert.equal(await auditCount("model_catalog.draft_stored"), draftsBefore + 1);
  await applyCatalogDraft({ category: "coding", modelId: "gpt-draft-test", session });
  const row = await prisma.modelCatalogEntry.findUnique({
    where: { category_modelId: { category: "coding", modelId: "gpt-draft-test" } },
  });
  assert.equal(row?.draft, null);
  assert.equal((row?.profile as { apiModelId?: string } | null)?.apiModelId, "gpt-catalog-test");
  await assert.rejects(
    applyCatalogDraft({ category: "coding", modelId: "gpt-draft-test", session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "no_draft"
  );
});

test("the database refuses a category it has no policy for", async () => {
  await assert.rejects(
    prisma.modelCatalogEntry.create({ data: { category: "video", modelId: "veo-x" } }),
    /ModelCatalogEntry_category_check/
  );
});

test("a priced runtime image model cannot change what it calls", async () => {
  const modelId = "catalog-runtime-image";
  const profile = {
    provider: "openai",
    apiModelId: "gpt-image-catalog-a",
    name: "Runtime Image",
    lifecycle: "preview",
    sizes: ["1024x1024"],
    qualities: ["low"],
    latencyClass: "balanced",
    provenance: [],
    outputMimeTypes: ["image/png"],
  };
  await updateCatalogEntry({ category: "image", modelId, patch: { profile }, session });
  // Before any price: the profile is still a draft and may change.
  await updateCatalogEntry({ category: "image", modelId, patch: { profile: { ...profile, name: "Renamed" } }, session });
  await createImagePriceRevision({
    modelId,
    revision: {
      pricingVersion: "runtime-v1",
      prices: [{ quality: "low", size: "1024x1024", credits: 50, outputCostMicroUsd: 6_000 }],
      verification,
    },
    session,
  });
  // Once priced, a display change is fine and a request change is refused.
  await updateCatalogEntry({ category: "image", modelId, patch: { profile: { ...profile, name: "Renamed again" } }, session });
  await assert.rejects(
    updateCatalogEntry({
      category: "image",
      modelId,
      patch: { profile: { ...profile, apiModelId: "gpt-image-catalog-dearer" } },
      session,
    }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "execution_profile_priced"
  );
  const row = await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "image", modelId } } });
  assert.equal((row?.profile as { apiModelId?: string } | null)?.apiModelId, "gpt-image-catalog-a");
});
