import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Session } from "next-auth";

import { takeAuditChainLock } from "@/lib/adminAudit";
import { codingSettingsSchema, fillLinkCapabilities, linkAllChatModels, linkChatModel, saveCodingSettings, unlinkCodingModel } from "@/lib/codingCatalogAdmin";
import { getImageModel, IMAGE_MODEL_REGISTRY, resetActiveImageModelCatalog } from "@/lib/imageModelRegistry";
import {
  codingCreditFloor,
  latestCodingSnapshot,
  loadCodingCatalog,
  parseSnapshotRows,
  publishCodingSnapshot,
  refreshImageModelCatalog,
  servableCodingRows,
  renewCodingSnapshotIfUnchanged,
} from "@/lib/modelCatalog";
import {
  applyCatalogDraft,
  CatalogRefusal,
  catalogPatchBodySchema,
  createImagePriceRevision,
  storeCatalogDraft,
  updateCatalogEntry,
} from "@/lib/modelCatalogAdmin";
import { codingDraftFromAnswer } from "@/lib/modelCatalogDraftLlm";
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
  await prisma.codingProviderTerms.deleteMany({});
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

  // Terms that deny resale are not a reason any more (owner decision 2026-11-21); a price page that is not the provider's is.
  const refused = { ...codingProfile, pricing: { ...codingProfile.pricing, sources: ["https://blog.example/prices"] } };
  await assert.rejects(
    updateCatalogEntry({ category: "coding", modelId: "gpt-catalog-test", patch: { profile: refused }, session }),
    (error: unknown) =>
      error instanceof CatalogRefusal &&
      error.code === "not_admitted" &&
      error.reasons.includes("unofficial_price_source:https://blog.example/prices")
  );
});

test("the scheduled renewal extends identical content once, as the system, and leaves a change to a person", async () => {
  const day = 24 * 60 * 60 * 1000;
  const renewedAudits = () => auditCount("model_catalog.snapshot_renewed");
  const versions = () => prisma.modelCatalogSnapshot.count({ where: { category: "coding" } });
  const latest = (await latestCodingSnapshot())!;
  const versionsBefore = await versions();
  const auditsBefore = await renewedAudits();

  // A fresh snapshot is not due: nothing is written.
  assert.equal((await renewCodingSnapshotIfUnchanged()).decision, "not_due");
  assert.equal(await versions(), versionsBefore);

  // Inside the last week two concurrent runs add exactly one version.
  const near = new Date(latest.coverageUntil.getTime() - 3 * day);
  const runs = await Promise.all([
    renewCodingSnapshotIfUnchanged({ now: near }),
    renewCodingSnapshotIfUnchanged({ now: near }),
  ]);
  assert.deepEqual(runs.map((run) => run.decision).sort(), ["not_due", "renew"]);
  assert.equal(await versions(), versionsBefore + 1);
  const renewed = (await latestCodingSnapshot())!;
  assert.equal(renewed.version > latest.version, true);
  assert.equal(renewed.contentHash, latest.contentHash);
  assert.deepEqual(renewed.models, latest.models);
  assert.equal(renewed.coverageUntil.getTime(), near.getTime() + 30 * day);

  // One system audit entry, in the chain, naming the actor and no person.
  assert.equal(await renewedAudits(), auditsBefore + 1);
  const entry = await prisma.adminAuditLog.findFirst({
    where: { action: "model_catalog.snapshot_renewed" },
    orderBy: { createdAt: "desc" },
  });
  assert.equal(entry?.actorUserId, null);
  assert.equal(entry?.targetType, "ModelCatalogSnapshot");
  assert.equal(entry?.targetId, String(renewed.version));
  assert.equal((entry?.metadata as { systemActor?: string } | null)?.systemActor, "model-catalog-renewal");
  const stored = await prisma.modelCatalogSnapshot.findUnique({ where: { version: renewed.version } });
  assert.equal(stored?.publishedById, null);

  // Content an operator changed is not renewed by the job, even when due.
  await updateCatalogEntry({ category: "coding", modelId: "gpt-catalog-test", patch: { enabled: false }, session });
  const changed = await renewCodingSnapshotIfUnchanged({ now: new Date(renewed.coverageUntil.getTime() - day) });
  assert.equal(changed.decision, "content_changed");
  assert.equal(changed.version, renewed.version);
  assert.equal(await versions(), versionsBefore + 1);
  assert.equal(await renewedAudits(), auditsBefore + 1);
  await updateCatalogEntry({ category: "coding", modelId: "gpt-catalog-test", patch: { enabled: true }, session });
});

test("a change committed while the renewal waits for the lock is judged, not skipped", async () => {
  const day = 24 * 60 * 60 * 1000;
  const latest = (await latestCodingSnapshot())!;
  const versionsBefore = await prisma.modelCatalogSnapshot.count({ where: { category: "coding" } });
  const key = { category_modelId: { category: "coding", modelId: "gpt-catalog-test" } };

  // Hold the chain lock, start a due renewal behind it, commit an operator's
  // change meanwhile, then let the renewal go: it must read after the lock.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    locked();
    await gate;
  });
  await holding;
  const renewal = renewCodingSnapshotIfUnchanged({ now: new Date(latest.coverageUntil.getTime() - 3 * day) });
  // Wait until the database reports a session blocked on the advisory lock,
  // rather than guessing a delay: the change below must land behind the wait.
  for (let attempt = 0; ; attempt += 1) {
    const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
    `;
    if (Number(waiting[0]?.count ?? 0) > 0) break;
    assert.ok(attempt < 100, "the renewal never waited for the chain lock");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await prisma.modelCatalogEntry.update({ where: key, data: { enabled: false } });
  release();
  await holder;

  const result = await renewal;
  assert.equal(result.decision, "content_changed");
  assert.equal(result.version, latest.version);
  assert.equal(await prisma.modelCatalogSnapshot.count({ where: { category: "coding" } }), versionsBefore);
  await prisma.modelCatalogEntry.update({ where: key, data: { enabled: true } });
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
  // The draft carried a finer structured output value; applying is a save, so it is written as "supported".
  assert.equal((row?.profile as { capabilities?: { structuredOutput?: string } } | null)?.capabilities?.structuredOutput, "supported");
  await assert.rejects(
    applyCatalogDraft({ category: "coding", modelId: "gpt-draft-test", session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "no_draft"
  );
});

test("an automatic draft is audited as the system actor, with no administrator on the entry", async () => {
  const humanBefore = await auditCount("model_catalog.draft_stored");
  const autoBefore = await auditCount("model_catalog.draft_auto_stored");
  assert.equal(
    await storeCatalogDraft({ category: "coding", modelId: "gpt-auto-draft-test", draft: codingProfile, system: true }),
    "stored"
  );
  // The person's action is untouched; the system's own action is written once.
  assert.equal(await auditCount("model_catalog.draft_stored"), humanBefore);
  assert.equal(await auditCount("model_catalog.draft_auto_stored"), autoBefore + 1);
  const entry = await prisma.adminAuditLog.findFirst({
    where: { action: "model_catalog.draft_auto_stored", targetId: "coding:gpt-auto-draft-test" },
    orderBy: { createdAt: "desc" },
  });
  assert.equal(entry?.actorUserId, null);
  assert.equal(entry?.actorEmail, null);
  assert.equal((entry?.metadata as { systemActor?: string } | null)?.systemActor, "model-catalog-auto-draft");
  const row = await prisma.modelCatalogEntry.findUnique({
    where: { category_modelId: { category: "coding", modelId: "gpt-auto-draft-test" } },
  });
  // A draft only: nothing is applied and nothing is enabled by it.
  assert.equal(row?.draftSource, "llm");
  assert.equal(row?.profile, null);
  assert.notEqual(row?.enabled, true);
});

test("an automatic draft never overwrites a row an operator already holds", async () => {
  const modelId = "gpt-auto-draft-held";
  const operatorDraft = { ...codingProfile, name: "Operator draft" };
  await storeCatalogDraft({ category: "coding", modelId, draft: operatorDraft, session });
  const before = await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "coding", modelId } } });
  const autoBefore = await auditCount("model_catalog.draft_auto_stored");
  const result = await storeCatalogDraft({
    category: "coding",
    modelId,
    draft: { ...codingProfile, name: "Automatic draft" },
    system: true,
  });
  assert.equal(result, "exists");
  const after = await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "coding", modelId } } });
  assert.deepEqual(after?.draft, before?.draft);
  assert.equal((after?.draft as { name?: string } | null)?.name, "Operator draft");
  assert.equal(after?.draftCreatedAt?.getTime(), before?.draftCreatedAt?.getTime());
  // Nothing was written, so nothing was audited.
  assert.equal(await auditCount("model_catalog.draft_auto_stored"), autoBefore);
});

test("a dedicated row's channels are its one setting, and a new draft keeps them", async () => {
  const modelId = "gpt-draft-test";
  const key = { category_modelId: { category: "coding", modelId } };
  const channelsOf = async () => ((await prisma.modelCatalogEntry.findUnique({ where: key }))?.profile as { channels?: string[] } | null)?.channels;
  // Offered on the coding API too (owner decision 2026-11-21).
  const saved = await saveCodingSettings({ modelId, settings: { channels: ["code", "api"] }, session });
  assert.deepEqual(saved.changes, [{ field: "channels", from: ["code"], to: ["code", "api"] }]);
  assert.deepEqual(await channelsOf(), ["code", "api"]);
  // Anything else on a dedicated row changes only through a draft.
  await assert.rejects(
    saveCodingSettings({ modelId, settings: { creditWeight: 9 }, session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "settings_linked_only"
  );
  // Its coding API credits: set before a new draft, which keeps them with the channels.
  const apiCreditOf = async () => ((await prisma.modelCatalogEntry.findUnique({ where: key }))?.profile as { apiCreditWeight?: number } | null)?.apiCreditWeight;
  const set = await saveCodingSettings({ modelId, settings: { apiCreditWeight: 12 }, session });
  assert.deepEqual(set.changes, [{ field: "apiCreditWeight", from: null, to: 12 }]);
  assert.equal(await apiCreditOf(), 12);
  await storeCatalogDraft({ category: "coding", modelId, draft: codingProfile, session });
  await applyCatalogDraft({ category: "coding", modelId, session });
  assert.deepEqual(await channelsOf(), ["code", "api"]);
  assert.equal(await apiCreditOf(), 12, "a new draft keeps the operator's coding API credits");
  await saveCodingSettings({ modelId, settings: { channels: ["code"] }, session });
  assert.deepEqual(await channelsOf(), ["code"]);
  // Removed: back to the chat rule's minimum, never stored.
  await saveCodingSettings({ modelId, settings: { apiCreditWeight: null }, session });
  assert.equal(await apiCreditOf(), undefined);
});

test("an image draft carries its runtime profile and never prices another model", async () => {
  const modelId = "catalog-draft-profile";
  const profile = {
    provider: "openai",
    apiModelId: "gpt-image-draft-profile",
    name: "gpt-image-draft-profile",
    lifecycle: "preview",
    sizes: ["1024x1024"],
    qualities: ["low", "medium", "high"],
    latencyClass: "balanced",
    provenance: [],
    outputMimeTypes: ["image/png"],
  };
  const draft = {
    pricingVersion: "draft-profile-v1",
    prices: [{ quality: "medium", size: "1024x1024", credits: 50, outputCostMicroUsd: 6_000 }],
    verification,
  };
  const storedApiModel = async () =>
    ((await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "image", modelId } } }))
      ?.profile as { apiModelId?: string } | null)?.apiModelId;
  // Unpriced: a draft for model A saves A's profile; a redraft for B moves the
  // profile to B with it, so the draft always prices what the row calls.
  await storeCatalogDraft({ category: "image", modelId, draft, imageProfile: { ...profile, apiModelId: "gpt-image-draft-a" }, session });
  assert.equal(await storedApiModel(), "gpt-image-draft-a");
  await storeCatalogDraft({ category: "image", modelId, draft, imageProfile: profile, session });
  assert.equal(await storedApiModel(), "gpt-image-draft-profile");
  // Applying needs no separate profile save.
  await applyCatalogDraft({ category: "image", modelId, session });
  // Priced: a draft for another API model is refused and changes nothing.
  await assert.rejects(
    storeCatalogDraft({
      category: "image",
      modelId,
      draft: { ...draft, pricingVersion: "draft-profile-v2" },
      imageProfile: { ...profile, apiModelId: "gpt-image-draft-dearer" },
      session,
    }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "draft_profile_mismatch"
  );
  assert.equal(await storedApiModel(), "gpt-image-draft-profile");
  const row = await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "image", modelId } } });
  assert.equal(row?.draft, null);
  // Priced, same model: a new draft is stored.
  await storeCatalogDraft({ category: "image", modelId, draft: { ...draft, pricingVersion: "draft-profile-v2" }, imageProfile: profile, session });
  assert.equal(await storedApiModel(), "gpt-image-draft-profile");
});

test("an applied image draft takes the operator's credits and a free version name, and its audit row says so", async () => {
  const modelId = "catalog-draft-credits";
  const profile = {
    provider: "openai",
    apiModelId: "gpt-image-draft-credits",
    name: "Before",
    lifecycle: "preview",
    sizes: ["1024x1024"],
    qualities: ["low", "medium"],
    latencyClass: "slow",
    provenance: [],
    outputMimeTypes: ["image/png"],
  };
  await updateCatalogEntry({ category: "image", modelId, patch: { profile }, session });
  const draft = {
    pricingVersion: "draft-credits-v1",
    prices: [
      { quality: "low", size: "1024x1024", credits: 50, outputCostMicroUsd: 6_000 },
      { quality: "medium", size: "1024x1024", credits: 50, outputCostMicroUsd: 6_000 },
    ],
    verification,
  };
  // Unpriced, same model: the add form's name, sizes and qualities replace the
  // stored ones, and what only the stored profile says (latency) stays.
  await storeCatalogDraft({
    category: "image",
    modelId,
    draft,
    imageProfile: { ...profile, name: "After", sizes: ["1024x1024", "1536x1024"], latencyClass: "balanced" },
    session,
  });
  const stored = (await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "image", modelId } } }))
    ?.profile as { name: string; sizes: string[]; latencyClass: string };
  assert.equal(stored.name, "After");
  assert.deepEqual(stored.sizes, ["1024x1024", "1536x1024"]);
  assert.equal(stored.latencyClass, "slow");

  // An override for an option the draft did not price is refused and the draft stays.
  await assert.rejects(
    applyCatalogDraft({ category: "image", modelId, creditOverrides: [{ quality: "high", size: "1024x1024", credits: 90 }], session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "credit_override_unknown_option"
  );
  // Credits under the floor are refused by the judge, as for any revision.
  await assert.rejects(
    applyCatalogDraft({ category: "image", modelId, creditOverrides: [{ quality: "low", size: "1024x1024", credits: 1 }], session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "not_admitted" && error.reasons.includes("credits_below_floor:low/1024x1024")
  );
  assert.equal(await prisma.modelCatalogPriceRevision.count({ where: { category: "image", modelId } }), 0);

  await applyCatalogDraft({ category: "image", modelId, creditOverrides: [{ quality: "medium", size: "1024x1024", credits: 60 }], session });
  const first = await prisma.modelCatalogPriceRevision.findFirst({ where: { category: "image", modelId } });
  assert.equal(first?.pricingVersion, "draft-credits-v1");
  assert.deepEqual(
    (first?.prices as { quality: string; credits: number; outputCostMicroUsd: number }[]).map((p) => [p.quality, p.credits, p.outputCostMicroUsd]),
    [
      ["low", 50, 6_000],
      ["medium", 60, 6_000],
    ]
  );
  const audit = await prisma.adminAuditLog.findFirst({
    where: { action: "model_catalog.price_revision_created", targetId: first!.id },
  });
  assert.deepEqual((audit?.metadata as { provenance?: unknown }).provenance, {
    fromDraft: true,
    draftPricingVersion: "draft-credits-v1",
    creditEdits: [{ quality: "medium", size: "1024x1024", from: 50, to: 60 }],
  });

  // The same day's draft again: the second apply takes the next free name instead of a 409.
  await storeCatalogDraft({ category: "image", modelId, draft, imageProfile: profile, session });
  await applyCatalogDraft({ category: "image", modelId, session });
  const versions = (await prisma.modelCatalogPriceRevision.findMany({ where: { category: "image", modelId }, orderBy: { createdAt: "asc" } })).map(
    (row) => row.pricingVersion
  );
  assert.deepEqual(versions, ["draft-credits-v1", "draft-credits-v1-2"]);
});

test("credit overrides are for image drafts only", async () => {
  await assert.rejects(
    applyCatalogDraft({ category: "coding", modelId: "gpt-draft-test", creditOverrides: [{ quality: "low", size: "1024x1024", credits: 5 }], session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "credit_overrides_image_only"
  );
});

test("an applied coding draft takes the operator's name, plan and weight, never under the floor, and its audit row says so", async () => {
  const modelId = "gpt-coding-edit-test";
  const key = { category_modelId: { category: "coding", modelId } };
  await storeCatalogDraft({ category: "coding", modelId, draft: codingProfile, session });
  // Under the floor the judge uses: refused, and the draft is still there to fix.
  await assert.rejects(
    applyCatalogDraft({ category: "coding", modelId, codingEdit: { creditWeight: 1 }, session }),
    (error: unknown) =>
      error instanceof CatalogRefusal && error.code === "not_admitted" && /^credits_below_floor:\d+$/.test(error.reasons[0] ?? "")
  );
  assert.notEqual((await prisma.modelCatalogEntry.findUnique({ where: key }))?.draft, null);
  await assert.rejects(
    applyCatalogDraft({ category: "image", modelId: "gpt-image-2", codingEdit: { creditWeight: 9 }, session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "coding_edit_coding_only"
  );

  await applyCatalogDraft({ category: "coding", modelId, codingEdit: { name: "Edited Coder", minimumPlan: "Max", creditWeight: 9 }, session });
  const row = await prisma.modelCatalogEntry.findUnique({ where: key });
  const stored = row?.profile as typeof codingProfile;
  assert.equal(row?.draft, null);
  assert.equal(stored.name, "Edited Coder");
  assert.equal(stored.minimumPlan, "Max");
  assert.equal(stored.pricing.creditWeight, 9);
  // Prices and evidence are the draft's.
  assert.equal(stored.pricing.outputUsdPerMTok, codingProfile.pricing.outputUsdPerMTok);
  assert.deepEqual(stored.terms, codingProfile.terms);
  const audit = await prisma.adminAuditLog.findFirst({
    where: { action: "model_catalog.entry_updated", targetId: `coding:${modelId}` },
    orderBy: { createdAt: "desc" },
  });
  assert.deepEqual((audit?.metadata as { provenance?: unknown }).provenance, {
    fromDraft: true,
    edits: [
      { field: "name", from: "Catalog Test Coder", to: "Edited Coder" },
      { field: "minimumPlan", from: "Pro", to: "Max" },
      { field: "creditWeight", from: 4, to: 9 },
    ],
  });
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

test("an image model is renamed in place, code or runtime, priced or not", async () => {
  // Owner request 2026-11-13: the guided screen had no way to change a name.
  // A rename writes only the name into the stored profile.
  await updateCatalogEntry({ category: "image", modelId: enabledSeed.id, patch: { name: "Seed Renamed" }, session });
  const seedRow = await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "image", modelId: enabledSeed.id } } });
  assert.deepEqual(seedRow?.profile, { name: "Seed Renamed" });
  assert.equal(seedRow?.enabled, null);
  const models = await refreshImageModelCatalog({ force: true });
  assert.equal(models.find((model) => model.id === enabledSeed.id)?.name, "Seed Renamed");

  const modelId = "catalog-runtime-rename";
  const profile = {
    provider: "openai",
    apiModelId: "gpt-image-catalog-rename",
    name: "Runtime Before",
    lifecycle: "preview",
    sizes: ["1024x1024"],
    qualities: ["low"],
    latencyClass: "balanced",
    provenance: [],
    outputMimeTypes: ["image/png"],
  };
  // No saved profile yet: a name alone says nothing about what to call.
  await assert.rejects(
    updateCatalogEntry({ category: "image", modelId, patch: { name: "Nothing" }, session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "invalid_profile"
  );
  await updateCatalogEntry({ category: "image", modelId, patch: { profile }, session });
  await createImagePriceRevision({
    modelId,
    revision: {
      pricingVersion: "rename-v1",
      prices: [{ quality: "low", size: "1024x1024", credits: 50, outputCostMicroUsd: 6_000 }],
      verification,
    },
    session,
  });
  const audits = await auditCount("model_catalog.entry_updated");
  await updateCatalogEntry({ category: "image", modelId, patch: { name: "Runtime After" }, session });
  const row = await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "image", modelId } } });
  assert.deepEqual(row?.profile, { ...profile, name: "Runtime After" });
  assert.equal(await auditCount("model_catalog.entry_updated"), audits + 1);

  // A name is for image models, and never together with a profile.
  await assert.rejects(
    updateCatalogEntry({ category: "coding", modelId: "coding-x", patch: { name: "x" }, session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "invalid_patch"
  );
  await assert.rejects(
    updateCatalogEntry({ category: "image", modelId, patch: { name: "x", profile }, session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "invalid_patch"
  );
  assert.equal(catalogPatchBodySchema.safeParse({ category: "image", modelId, name: "" }).success, false);
  assert.equal(catalogPatchBodySchema.safeParse({ category: "image", modelId, name: "x".repeat(81) }).success, false);

  // Owner request 2026-11-15: the image router picks by fit, so each model
  // carries a note on what it is good and bad at. Like the name it is written
  // into the stored profile, on a priced model too, and reaches the router.
  const note = "Best for: posters with text; weaker at: speed.";
  await updateCatalogEntry({ category: "image", modelId, patch: { routingNote: note }, session });
  const noted = await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "image", modelId } } });
  assert.deepEqual(noted?.profile, { ...profile, name: "Runtime After", routingNote: note });
  await updateCatalogEntry({ category: "image", modelId: enabledSeed.id, patch: { routingNote: note }, session });
  const withNotes = await refreshImageModelCatalog({ force: true });
  assert.equal(withNotes.find((model) => model.id === enabledSeed.id)?.routingNote, note);
  assert.equal(withNotes.find((model) => model.id === enabledSeed.id)?.name, "Seed Renamed");
  // A rename keeps the note; null removes it.
  await updateCatalogEntry({ category: "image", modelId, patch: { name: "Runtime Last" }, session });
  await updateCatalogEntry({ category: "image", modelId: enabledSeed.id, patch: { routingNote: null }, session });
  const cleared = await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "image", modelId: enabledSeed.id } } });
  assert.deepEqual(cleared?.profile, { name: "Seed Renamed" });
  const kept = await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "image", modelId } } });
  assert.deepEqual(kept?.profile, { ...profile, name: "Runtime Last", routingNote: note });
  assert.equal(catalogPatchBodySchema.safeParse({ category: "image", modelId, routingNote: "two\nlines" }).success, false);
  assert.equal(catalogPatchBodySchema.safeParse({ category: "image", modelId, routingNote: "x".repeat(401) }).success, false);

  // The line users see under the model's name is written the same way.
  await updateCatalogEntry({ category: "image", modelId, patch: { useCase: "text" }, session });
  const described = await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "image", modelId } } });
  assert.deepEqual(described?.profile, { ...profile, name: "Runtime Last", routingNote: note, useCase: "text" });
  assert.equal((await refreshImageModelCatalog({ force: true })).find((model) => model.id === modelId)?.useCase, "text");
  await updateCatalogEntry({ category: "image", modelId, patch: { useCase: null }, session });
  const undescribed = await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "image", modelId } } });
  assert.deepEqual(undescribed?.profile, { ...profile, name: "Runtime Last", routingNote: note });
  assert.equal(catalogPatchBodySchema.safeParse({ category: "image", modelId, useCase: "cheap" }).success, false);
});

test("a priced runtime image model whose stored profile no longer parses cannot be given a new one", async () => {
  // Review nit 2026-10-21: the lock compared execution profiles only when the
  // stored one parsed, so an unreadable profile let any new request profile
  // in under the existing price. Unreadable now counts as changed.
  const modelId = "catalog-runtime-unreadable";
  const stored = { provider: "openai", apiModelId: "gpt-image-catalog-legacy" };
  await prisma.modelCatalogEntry.create({ data: { category: "image", modelId, profile: stored } });
  await prisma.modelCatalogPriceRevision.create({
    data: {
      category: "image",
      modelId,
      pricingVersion: "unreadable-v1",
      prices: [{ quality: "low", size: "1024x1024", credits: 50, outputCostMicroUsd: 6_000 }],
      verification,
      effectiveFrom: new Date(),
    },
  });
  const auditsBefore = await auditCount("model_catalog.entry_updated");
  await assert.rejects(
    updateCatalogEntry({
      category: "image",
      modelId,
      patch: {
        profile: {
          provider: "openai",
          apiModelId: "gpt-image-catalog-dearer",
          name: "Unreadable Runtime Image",
          lifecycle: "preview",
          sizes: ["1024x1024"],
          qualities: ["low"],
          latencyClass: "balanced",
          provenance: [],
          outputMimeTypes: ["image/png"],
        },
      },
      session,
    }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "execution_profile_priced"
  );
  const row = await prisma.modelCatalogEntry.findUnique({ where: { category_modelId: { category: "image", modelId } } });
  assert.deepEqual(row?.profile, stored);
  assert.equal(await auditCount("model_catalog.entry_updated"), auditsBefore);
});

test("a dedicated profile with no provider conditions is stored, turned on and published without them", async () => {
  const { terms: _terms, retention: _retention, processingRegion: _region, ...bare } = codingProfile;
  void [_terms, _retention, _region];
  const modelId = "gpt-catalog-bare";
  await updateCatalogEntry({ category: "coding", modelId, patch: { profile: { ...bare, apiModelId: modelId } }, session });
  await updateCatalogEntry({ category: "coding", modelId, patch: { enabled: true }, session });
  const published = await publishCodingSnapshot({ session });
  const row = published.snapshot.models.find((model) => model.modelId === modelId)!;
  assert.equal(row.source, "dedicated");
  assert.equal("terms" in row, false);
  assert.equal("retention" in row, false);
  assert.equal("processingRegion" in row, false);
  await updateCatalogEntry({ category: "coding", modelId, patch: { enabled: false }, session });
});

test("a draft from pages with no output limit and tiered prices applies at 8,192 and the dearest tier, and publishes without its basis", async () => {
  // Owner decisions 2026-11-22 (the Qwen3 Coder Flash case): no output limit stated, priced by input-size tier.
  const modelId = "gpt-tiered-default-cap";
  const draft = codingDraftFromAnswer(
    {
      name: "Tiered Default Cap Coder",
      minimumPlan: "Pro",
      capabilities: { toolCalling: "parallel", structuredOutput: "supported", imageInput: false, maxContextTokens: 200_000, maxOutputTokens: null },
      pricing: {
        inputUsdPerMTok: 0.3,
        outputUsdPerMTok: 1.5,
        tiers: [
          { upToInputTokens: 32_000, inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.5 },
          { upToInputTokens: null, inputUsdPerMTok: 1.6, outputUsdPerMTok: 9.6 },
        ],
      },
    },
    "openai",
    modelId,
    ["https://developers.openai.com/api/docs/pricing"],
    codingCreditFloor
  );
  await storeCatalogDraft({ category: "coding", modelId, draft, session });
  await applyCatalogDraft({ category: "coding", modelId, session });
  const stored = (await prisma.modelCatalogEntry.findUniqueOrThrow({ where: { category_modelId: { category: "coding", modelId } } })).profile as {
    capabilities: { maxOutputTokens: number; structuredOutput: string };
    pricing: { inputUsdPerMTok: number; outputUsdPerMTok: number; creditWeight: number };
    basis: { maxOutputTokens: string; priceTiers: unknown[] };
  };
  assert.equal(stored.capabilities.maxOutputTokens, 8_192);
  assert.equal(stored.capabilities.structuredOutput, "supported");
  assert.deepEqual([stored.pricing.inputUsdPerMTok, stored.pricing.outputUsdPerMTok], [1.6, 9.6]);
  assert.equal(stored.basis.maxOutputTokens, "default");
  assert.equal(stored.basis.priceTiers.length, 2);
  assert.equal(stored.pricing.creditWeight, codingCreditFloor(stored as never));
  await updateCatalogEntry({ category: "coding", modelId, patch: { enabled: true }, session });
  const published = await publishCodingSnapshot({ session });
  const row = published.snapshot.models.find((model) => model.modelId === modelId)!;
  assert.equal(row.capabilities.maxOutputTokens, 8_192);
  assert.equal(row.capabilities.structuredOutput, "supported");
  assert.equal("basis" in row, false, "the basis stays in the stored profile; the snapshot row does not carry it");
  // A link's settings save writes one of the two choices; a finer value is refused at the door.
  assert.equal(codingSettingsSchema.safeParse({ structuredOutput: "json_mode" }).success, false);
  assert.equal(codingSettingsSchema.safeParse({ structuredOutput: "supported" }).success, true);
  assert.equal(codingSettingsSchema.safeParse({ structuredOutput: "none" }).success, true);
  await updateCatalogEntry({ category: "coding", modelId, patch: { enabled: false }, session });
});

// --- chat links (owner decision 2026-11-20); provider conditions are not collected or judged (owner decision 2026-11-21) ---

const LINKED = "gpt-6-luna";
const OPENAI_TERMS = "https://openai.com/policies/services-agreement";
const OPENAI_RETENTION = "https://platform.openai.com/docs/guides/your-data";

const today = () => new Date().toISOString().slice(0, 10);

const linkedEntry = async () => (await loadCodingCatalog()).find((entry) => entry.modelId === LINKED)!;

test("a chat link is created off with its audit row, reads chat's values and the registry's capabilities, and needs no provider conditions", async () => {
  await cleanup();
  const linkedBefore = await auditCount("model_catalog.coding_linked");
  await linkChatModel({ registryModelId: LINKED, session });
  assert.equal(await auditCount("model_catalog.coding_linked"), linkedBefore + 1);
  const row = await prisma.modelCatalogEntry.findUniqueOrThrow({ where: { category_modelId: { category: "coding", modelId: LINKED } } });
  assert.equal(row.enabled, null);
  const stored = row.profile as { source: string; name?: string; channels: string[]; capabilities: unknown; evidence: { sources: string[] } };
  assert.equal(stored.source, "chat");
  assert.deepEqual(stored.channels, ["code"]);
  // Tool calling from the registry; structured output at the conservative none; no page read.
  assert.deepEqual(stored.capabilities, { toolCalling: "basic", structuredOutput: "none" });
  assert.deepEqual(stored.evidence.sources, []);
  // Only the link's own values are stored.
  assert.equal(stored.name, undefined);

  await assert.rejects(
    linkChatModel({ registryModelId: LINKED, session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "already_in_catalog"
  );

  const entry = await linkedEntry();
  assert.equal(entry.source, "chat");
  assert.equal(entry.profile?.apiModelId, "gpt-6-luna");
  assert.ok((entry.profile?.capabilities.maxContextTokens ?? 0) > 0);
  // There is no provider record, and nothing about one is asked for.
  assert.equal(await prisma.codingProviderTerms.count(), 0);
  assert.equal(entry.profile?.terms, undefined);
  if (entry.admission?.admitted === false) {
    assert.deepEqual(
      entry.admission.reasons.filter((reason) => !reason.startsWith("credits_below_floor") && reason !== "no_structured_output"),
      [],
      "only Code's own rules (the credit floor, structured output) may stand in the way of a Code-only link"
    );
  }
});

test("a weight at the floor lets the link turn on with no provider record, and the snapshot carries a row without conditions", async () => {
  const floor = codingCreditFloor((await linkedEntry()).profile!);
  assert.ok(floor !== null);
  // Code reads a plan through a structured output: the registry has none, so the operator sets one.
  await saveCodingSettings({ modelId: LINKED, settings: { creditWeight: floor, structuredOutput: "supported", channels: ["api", "code"] }, session });
  const entry = await linkedEntry();
  assert.deepEqual(entry.admission, { admitted: true });
  assert.deepEqual(entry.effectiveChannels, ["code", "api"]);
  await updateCatalogEntry({ category: "coding", modelId: LINKED, patch: { enabled: true }, session });

  const published = await publishCodingSnapshot({ session });
  const snapshotRow = published.snapshot.models.find((model) => model.modelId === LINKED)!;
  assert.equal(snapshotRow.source, "chat");
  assert.deepEqual(snapshotRow.channels, ["code", "api"]);
  assert.equal(snapshotRow.pricing.creditWeight, floor);
  assert.ok(snapshotRow.pricing.pricingVersion);
  assert.equal("terms" in snapshotRow, false);
  assert.equal("retention" in snapshotRow, false);
  assert.equal("processingRegion" in snapshotRow, false);
  // The stored snapshot parses back to the same row.
  const stored = await prisma.modelCatalogSnapshot.findFirstOrThrow({ where: { category: "coding" }, orderBy: { version: "desc" } });
  const parsed = parseSnapshotRows((stored.payload as { models: unknown[] }).models);
  assert.equal(parsed.length, (stored.payload as { models: unknown[] }).models.length);
  // Publishing again with nothing changed is not a new version.
  const again = await publishCodingSnapshot({ session });
  assert.equal(again.created, false);
});

test("a provider record applied before they were dropped is carried into the row, unjudged, even when it denies and is old", async () => {
  await prisma.codingProviderTerms.create({
    data: {
      provider: "openai",
      terms: {
        allowsResaleAndCodingAgent: false,
        termsUrl: OPENAI_TERMS,
        retentionUrl: OPENAI_RETENTION,
        processingRegion: "US",
        checkedAt: "2026-01-01",
        sources: [OPENAI_TERMS],
      },
    },
  });
  const entry = await linkedEntry();
  assert.deepEqual(entry.admission, { admitted: true });
  assert.equal(entry.profile?.terms?.url, OPENAI_TERMS);
  assert.equal("warnings" in entry, false);
  // Already on: a settings change is judged and kept.
  await saveCodingSettings({ modelId: LINKED, settings: { channels: ["code"] }, session });
  // Held and turned on again is a new activation: nothing about the old check stands in its way.
  await updateCatalogEntry({ category: "coding", modelId: LINKED, patch: { holdReason: "check" }, session });
  await updateCatalogEntry({ category: "coding", modelId: LINKED, patch: { holdReason: null, enabled: true }, session });
  // Its published row carries the record's fields as it did before.
  const published = await publishCodingSnapshot({ session });
  assert.equal(published.snapshot.models.find((model) => model.modelId === LINKED)?.terms?.url, OPENAI_TERMS);
  await prisma.codingProviderTerms.deleteMany({});
});

test("a link is taken out of the catalogue only once it is off, with its audit row", async () => {
  await assert.rejects(
    unlinkCodingModel({ modelId: LINKED, session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "unlink_turn_off_first"
  );
  await updateCatalogEntry({ category: "coding", modelId: LINKED, patch: { enabled: false, holdReason: null }, session });
  const before = await auditCount("model_catalog.coding_unlinked");
  await unlinkCodingModel({ modelId: LINKED, session });
  assert.equal(await auditCount("model_catalog.coding_unlinked"), before + 1);
  assert.equal(await prisma.modelCatalogEntry.count({ where: { category: "coding", modelId: LINKED } }), 0);
});

test("add-all links every candidate on the coding API at chat's credits, on Code only where Code's rules pass, and a refused model leaves no row", async () => {
  await cleanup();
  const linkedBefore = await auditCount("model_catalog.coding_linked");
  const updatedBefore = await auditCount("model_catalog.entry_updated");
  const result = await linkAllChatModels({ session });
  assert.ok(result.attempted > 0, "the chat registry has candidates");
  // The coding API takes nearly everything: Code's credit floor, context window and structured output do not stand in its way.
  assert.ok(result.added.length >= result.attempted - 2, `added ${result.added.length} of ${result.attempted}: ${JSON.stringify(result.reasonCounts)}`);
  assert.equal(result.attempted, result.added.length + result.refused.length);
  assert.ok(result.withCode.every((id) => result.added.includes(id)));
  assert.equal(new Set(result.added).size, result.added.length);
  assert.ok(result.refused.every((row) => row.reasons.length > 0));
  // What is left over is a real reason, never one of Code's.
  for (const reason of Object.keys(result.reasonCounts)) {
    assert.ok(!["credits_below_floor", "credit_floor_unbounded", "chat_context_unknown", "no_structured_output", "reasoning_cost_unbounded"].includes(reason), reason);
  }

  const rows = await prisma.modelCatalogEntry.findMany({ where: { category: "coding" } });
  assert.deepEqual(rows.map((row) => row.modelId).sort(), [...result.added].sort());
  for (const row of rows) {
    const stored = row.profile as { source: string; channels: string[]; creditWeight?: number; capabilities: unknown };
    assert.equal(row.enabled, true, row.modelId);
    assert.equal(stored.source, "chat");
    assert.deepEqual(stored.channels, result.withCode.includes(row.modelId) ? ["code", "api"] : ["api"], row.modelId);
    assert.equal(stored.creditWeight, undefined, "credits stay chat's");
    assert.deepEqual(stored.capabilities, { toolCalling: "basic", structuredOutput: "none" });
  }
  // The registry gives no structured output, so Code is on for none of them until the operator sets one.
  assert.deepEqual(result.withCode, []);
  // The same audit rows as adding and activating by hand: one link and one activation per model, none for the refused.
  assert.equal(await auditCount("model_catalog.coding_linked"), linkedBefore + result.added.length);
  assert.equal(await auditCount("model_catalog.entry_updated"), updatedBefore + result.added.length);
  const catalogue = await loadCodingCatalog();
  for (const entry of catalogue) {
    assert.deepEqual(entry.admission, { admitted: true }, entry.modelId);
    assert.deepEqual(entry.effectiveChannels, ["api"], entry.modelId);
    assert.deepEqual(entry.channelAdmission.api, { admitted: true }, entry.modelId);
    assert.equal(entry.channelAdmission.code, null, "Code is not among its channels");
  }

  // A second run adds nothing: what was added is no longer a candidate, and what was refused is refused again.
  const again = await linkAllChatModels({ session });
  assert.deepEqual(again.added, []);
  assert.equal(again.attempted, result.refused.length);
  assert.deepEqual(again.reasonCounts, result.reasonCounts);
  assert.equal(await prisma.modelCatalogEntry.count({ where: { category: "coding" } }), result.added.length);

  // Nothing reaches the coding API until a snapshot is published; the next publish lists what was added, for the coding API only.
  const published = await publishCodingSnapshot({ session });
  assert.deepEqual(
    published.snapshot.models.map((model) => model.modelId).sort(),
    [...result.added].sort()
  );
  for (const model of published.snapshot.models) assert.deepEqual(model.channels, ["api"], model.modelId);
});

test("a link that passes the coding API and fails Code is published for the coding API alone, and the snapshot of one that passes both does not move", async () => {
  await cleanup();
  await linkChatModel({ registryModelId: LINKED, session });
  const floor = codingCreditFloor((await linkedEntry()).profile!)!;
  // Both channels, structured output set, but chat's own credits below Code's floor.
  await saveCodingSettings({ modelId: LINKED, settings: { structuredOutput: "supported", channels: ["api", "code"] }, session });
  const entry = await linkedEntry();
  const chatCredits = entry.profile!.pricing.creditWeight;
  assert.ok(chatCredits < floor, "this registry model's chat credits are below Code's floor");
  assert.equal(entry.channelAdmission.api?.admitted, true);
  assert.equal(entry.channelAdmission.code?.admitted, false);
  assert.deepEqual(entry.admission, { admitted: true });
  assert.deepEqual(entry.effectiveChannels, ["api"]);
  await updateCatalogEntry({ category: "coding", modelId: LINKED, patch: { enabled: true }, session });

  // The snapshot row lists the coding API alone, so Code's managed path (which needs "code" in it and compares it with this very row) keeps Code's rules.
  const servable = servableCodingRows(await loadCodingCatalog());
  assert.deepEqual(servable.map((row) => [row.modelId, row.channels]), [[LINKED, ["api"]]]);
  const published = await publishCodingSnapshot({ session });
  assert.deepEqual(published.snapshot.models.map((row) => row.channels), [["api"]]);

  // Raised to the floor, the same link passes both: its row lists both channels, as an unchanged published one would.
  await saveCodingSettings({ modelId: LINKED, settings: { creditWeight: floor }, session });
  assert.deepEqual((await linkedEntry()).effectiveChannels, ["code", "api"]);
  assert.deepEqual(servableCodingRows(await loadCodingCatalog()).map((row) => row.channels), [["code", "api"]]);
  await updateCatalogEntry({ category: "coding", modelId: LINKED, patch: { holdReason: "done" }, session });
});

test("filling a link's capabilities from the documentation changes only its capabilities and evidence, never its channels, and is audited", async () => {
  await cleanup();
  await linkChatModel({ registryModelId: LINKED, session });
  await saveCodingSettings({ modelId: LINKED, settings: { channels: ["api"] }, session });
  const filledBefore = await auditCount("model_catalog.coding_capabilities_filled");
  const updatedBefore = await auditCount("model_catalog.entry_updated");
  const sources = ["https://developers.openai.com/api/docs/guides/function-calling", "https://developers.openai.com/api/docs/guides/structured-outputs"];
  let llmCalls = 0;
  const deps = {
    draftLlm: async () => ({
      draftImagePrices: async () => {
        throw new Error("not used");
      },
      draftCodingProfile: async () => {
        throw new Error("not used");
      },
      draftCodingCapabilities: async ({ pages }: { pages: { url: string }[] }) => {
        llmCalls += 1;
        // A finer value than the two choices: the save writes "supported" (owner decision 2026-11-22).
        return { toolCalling: "parallel" as const, structuredOutput: "strict_schema", note: "Stated on the pages.", sources: pages.map((page) => page.url), draftedAt: today() };
      },
    }),
    fetchPage: async (_provider: string, url: string) => ({ url, text: "page" }),
  };
  const result = await fillLinkCapabilities({ modelId: LINKED, session, deps: deps as never });
  assert.equal(llmCalls, 1);
  assert.deepEqual(result.changes.map((change) => change.field), ["toolCalling", "structuredOutput"]);
  const row = await prisma.modelCatalogEntry.findUniqueOrThrow({ where: { category_modelId: { category: "coding", modelId: LINKED } } });
  const stored = row.profile as { capabilities: unknown; channels: string[]; evidence: { sources: string[]; note?: string } };
  assert.deepEqual(stored.capabilities, { toolCalling: "parallel", structuredOutput: "supported" });
  assert.deepEqual(stored.evidence.sources, sources);
  assert.equal(stored.evidence.note, "Stated on the pages.");
  assert.deepEqual(stored.channels, ["api"], "Code stays the operator's to tick");
  assert.equal(await auditCount("model_catalog.coding_capabilities_filled"), filledBefore + 1);
  assert.equal(await auditCount("model_catalog.entry_updated"), updatedBefore + 1);

  // A failure changes nothing and writes nothing.
  const failing = { ...deps, draftLlm: async () => ({ draftCodingCapabilities: async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); } }) };
  await assert.rejects(
    fillLinkCapabilities({ modelId: LINKED, session, deps: failing as never }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "timeout_outcome_unknown"
  );
  assert.deepEqual((await prisma.modelCatalogEntry.findUniqueOrThrow({ where: { category_modelId: { category: "coding", modelId: LINKED } } })).profile, row.profile);
  assert.equal(await auditCount("model_catalog.coding_capabilities_filled"), filledBefore + 1);
});

// Coding notes (owner decision 2026-11-22): filled by the same call as the
// capabilities, standing on the fetched official pages, edited by the
// operator, kept through a new draft, and never part of a published row.
test("coding notes are filled with the capabilities, edited by the operator, and leave the published content as it was", async () => {
  await cleanup();
  await linkChatModel({ registryModelId: LINKED, session });
  const floor = codingCreditFloor((await linkedEntry()).profile!)!;
  await saveCodingSettings({ modelId: LINKED, settings: { creditWeight: floor, structuredOutput: "supported", channels: ["api", "code"] }, session });
  await updateCatalogEntry({ category: "coding", modelId: LINKED, patch: { enabled: true }, session });
  const first = await publishCodingSnapshot({ session });
  const key = { category_modelId: { category: "coding", modelId: LINKED } };
  const stored = async () => (await prisma.modelCatalogEntry.findUniqueOrThrow({ where: key })).profile as { codingNotes?: { strengths: string[]; weaknesses: string[]; sources: string[]; editedAt?: string } };

  let answer: { strengths: string[]; weaknesses: string[]; sourceUrls: string[] } = { strengths: [], weaknesses: [], sourceUrls: [] };
  const deps = {
    draftLlm: async () => ({
      draftImagePrices: async () => {
        throw new Error("not used");
      },
      draftCodingProfile: async () => {
        throw new Error("not used");
      },
      draftCodingCapabilities: async ({ pages }: { pages: { url: string }[] }) => ({
        toolCalling: "basic" as const,
        structuredOutput: "supported" as const,
        note: "",
        sources: pages.map((page) => page.url),
        draftedAt: today(),
        codingNotes: answer,
      }),
    }),
    fetchPage: async (_provider: string, url: string) => ({ url, text: "page" }),
  };
  const pages = ["https://developers.openai.com/api/docs/guides/function-calling", "https://developers.openai.com/api/docs/guides/structured-outputs"];

  // A page that is not the provider's: refused, nothing written.
  answer = { strengths: ["Best coder"], weaknesses: [], sourceUrls: ["https://blog.example/gpt"] };
  const before = await stored();
  await assert.rejects(
    fillLinkCapabilities({ modelId: LINKED, session, deps: deps as never }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "unofficial_source"
  );
  assert.deepEqual(await stored(), before);

  // Notes on the fetched pages: written with the capabilities.
  answer = { strengths: ["Parallel tool calls in one response", "Strict schema outputs"], weaknesses: ["No schema on JSON mode"], sourceUrls: [pages[0]] };
  await fillLinkCapabilities({ modelId: LINKED, session, deps: deps as never });
  const filled = await stored();
  assert.deepEqual(filled.codingNotes?.strengths, answer.strengths);
  assert.deepEqual(filled.codingNotes?.sources, [pages[0]]);
  // The published content is the same: notes are not part of a resolved or snapshot row.
  const servable = servableCodingRows(await loadCodingCatalog());
  assert.ok(servable.every((row) => !("codingNotes" in row)));
  const again = await publishCodingSnapshot({ session });
  assert.equal(again.created, false, "nothing to publish: the content hash did not move");
  assert.equal(again.snapshot.contentHash, first.snapshot.contentHash);

  // The operator edits them: kept sources, an edit date; an empty pair removes them.
  const edited = await saveCodingSettings({ modelId: LINKED, settings: { codingNotes: { strengths: ["Parallel tool calls"], weaknesses: [] } }, session });
  assert.deepEqual(edited.changes.map((change) => change.field), ["codingNotes"]);
  assert.deepEqual((await stored()).codingNotes?.sources, [pages[0]]);
  assert.equal((await stored()).codingNotes?.editedAt, today());
  // The same text again changes nothing.
  assert.deepEqual((await saveCodingSettings({ modelId: LINKED, settings: { codingNotes: { strengths: ["Parallel tool calls"], weaknesses: [] } }, session })).changes, []);
  assert.equal(codingSettingsSchema.safeParse({ codingNotes: { strengths: ["x".repeat(121)], weaknesses: [] } }).success, false);
  assert.equal(codingSettingsSchema.safeParse({ codingNotes: { strengths: ["a", "b", "c", "d"], weaknesses: [] } }).success, false);
  await saveCodingSettings({ modelId: LINKED, settings: { codingNotes: null }, session });
  assert.equal((await stored()).codingNotes, undefined);
  assert.equal((await publishCodingSnapshot({ session })).created, false);
  await updateCatalogEntry({ category: "coding", modelId: LINKED, patch: { enabled: false }, session });
});

test("a dedicated row takes coding notes from the operator and from a fill, and keeps them through a new draft", async () => {
  const modelId = "gpt-notes-dedicated";
  await storeCatalogDraft({ category: "coding", modelId, draft: { ...codingProfile, apiModelId: modelId }, session });
  await applyCatalogDraft({ category: "coding", modelId, session });
  const key = { category_modelId: { category: "coding", modelId } };
  const notesOf = async () => ((await prisma.modelCatalogEntry.findUniqueOrThrow({ where: key })).profile as { codingNotes?: { strengths: string[]; sources: string[] } }).codingNotes;
  await saveCodingSettings({ modelId, settings: { codingNotes: { strengths: ["Fast on short edits"], weaknesses: ["Weak at long plans"] } }, session });
  assert.deepEqual((await notesOf())?.strengths, ["Fast on short edits"]);
  assert.deepEqual((await notesOf())?.sources, [], "written by the operator");
  // Anything else on a dedicated row still changes only through a draft.
  await assert.rejects(
    saveCodingSettings({ modelId, settings: { creditWeight: 9 }, session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "settings_linked_only"
  );
  // A new draft keeps them.
  await storeCatalogDraft({ category: "coding", modelId, draft: { ...codingProfile, apiModelId: modelId }, session });
  await applyCatalogDraft({ category: "coding", modelId, session });
  assert.deepEqual((await notesOf())?.strengths, ["Fast on short edits"]);
  // A fill writes the notes only, standing on the fetched page.
  const page = "https://developers.openai.com/api/docs/guides/function-calling";
  const deps = {
    draftLlm: async () => ({
      draftCodingCapabilities: async ({ pages }: { pages: { url: string }[] }) => ({
        toolCalling: "none" as const,
        structuredOutput: "none" as const,
        note: "",
        sources: pages.map((entry) => entry.url),
        draftedAt: today(),
        codingNotes: { strengths: ["Parallel tool calls"], weaknesses: [], sourceUrls: [page] },
      }),
    }),
    fetchPage: async (_provider: string, url: string) => ({ url, text: "page" }),
  };
  const capabilitiesBefore = ((await prisma.modelCatalogEntry.findUniqueOrThrow({ where: key })).profile as { capabilities: unknown }).capabilities;
  await fillLinkCapabilities({ modelId, session, deps: deps as never });
  assert.deepEqual((await notesOf())?.strengths, ["Parallel tool calls"]);
  assert.deepEqual((await notesOf())?.sources, [page]);
  assert.deepEqual(((await prisma.modelCatalogEntry.findUniqueOrThrow({ where: key })).profile as { capabilities: unknown }).capabilities, capabilitiesBefore, "a dedicated row's capabilities are its draft's");
});
