import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Session } from "next-auth";

import { takeAuditChainLock } from "@/lib/adminAudit";
import { getImageModel, IMAGE_MODEL_REGISTRY, resetActiveImageModelCatalog } from "@/lib/imageModelRegistry";
import {
  latestCodingSnapshot,
  publishCodingSnapshot,
  refreshImageModelCatalog,
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
  await assert.rejects(
    applyCatalogDraft({ category: "coding", modelId: "gpt-draft-test", session }),
    (error: unknown) => error instanceof CatalogRefusal && error.code === "no_draft"
  );
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
