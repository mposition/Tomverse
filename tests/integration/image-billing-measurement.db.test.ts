import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Session } from "next-auth";

import { usagePeriodStart } from "@/lib/chatSecurity";
import {
  confirmedBillingTermsFor,
  confirmImageBillingTerms,
  MeasurementRefusal,
  runImageBillingMeasurement,
  startImageBillingMeasurement,
} from "@/lib/imageBillingMeasurement";
import { measurementPlanSchema, sampleCeilingMicroUsd } from "@/lib/imageBillingMeasurementCore";
import { getImageModel, resetActiveImageModelCatalog } from "@/lib/imageModelRegistry";
import { imageProviderBudgetBucketKey } from "@/lib/imageProviderBudget";
import { ImageProviderError, type ImageProviderResult } from "@/lib/imageProviderAdapter";
import { refreshImageModelCatalog } from "@/lib/modelCatalog";
import { createImagePriceRevision, updateCatalogEntry } from "@/lib/modelCatalogAdmin";
import { prisma } from "@/lib/prisma";

// The admin billing measurement against a real database (image policy section
// 12.1): it is off by default, holds its maximum against the provider budget
// and returns the unspent part, keeps one run at a time, and confirmed terms
// are what lets a model the code tables could not bound be priced and served.
// The provider is a stub: no request leaves the test.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const session = {
  user: { id: "measure-test-admin", email: "measure-admin@example.test" },
  expires: "2099-01-01T00:00:00.000Z",
} as unknown as Session;

const ON = { ...process.env, IMAGE_BILLING_MEASUREMENT_ENABLED: "1" };
const WAN = "wan2.7-image";
const QWEN_SOURCE = "https://www.alibabacloud.com/help/en/model-studio/model-pricing";

const wanPlan = measurementPlanSchema.parse({
  method: "per_image",
  provider: "qwen",
  apiModelId: WAN,
  samples: 2,
  perImageUsd: 0.03,
  maxCostMicroUsd: 200_000,
});

const withTriggersOff = async (table: string, trigger: string, sql: string) => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  try {
    await prisma.$executeRawUnsafe(sql);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
  }
};

const cleanup = async () => {
  await prisma.imageBillingMeasurement.deleteMany({});
  await withTriggersOff("ImageModelBillingTerms", "ImageModelBillingTerms_append_only_trigger", `DELETE FROM "ImageModelBillingTerms"`);
  await prisma.modelCatalogEntry.deleteMany({});
  await withTriggersOff(
    "ModelCatalogPriceRevision",
    "ModelCatalogPriceRevision_append_only_trigger",
    `DELETE FROM "ModelCatalogPriceRevision"`
  );
  await prisma.chatUsageBucket.deleteMany({ where: { key: { startsWith: "image-provider" } } });
  resetActiveImageModelCatalog();
};

before(cleanup);
after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const budgetHeld = async (provider: string, at: Date) => {
  const row = await prisma.chatUsageBucket.findFirst({
    where: { key: imageProviderBudgetBucketKey(provider), period: "provider-cost-day", periodStart: usagePeriodStart("day", at) },
  });
  return Number(row?.count ?? 0);
};

const qwenResult = (usage: Record<string, number>): ImageProviderResult => ({
  imageBytes: Buffer.from("not kept"),
  mimeType: "image/png",
  inputTokens: 0,
  thinkingTokens: 0,
  outputTokens: 0,
  providerUsage: usage,
  providerRequestId: "req",
  provenance: [],
  outputWidth: 1024,
  outputHeight: 1024,
  requestParams: {},
});

test("a measurement is refused while the owner switch is off, and writes nothing", async () => {
  await assert.rejects(
    startImageBillingMeasurement({ plan: wanPlan, session, env: { ...process.env, IMAGE_BILLING_MEASUREMENT_ENABLED: "" } }),
    (error: unknown) => error instanceof MeasurementRefusal && error.code === "measurement_disabled"
  );
  assert.equal(await prisma.imageBillingMeasurement.count(), 0);
});

test("Wan 2.7: measure, confirm per-image billing, then its price revision is admitted and it serves", async () => {
  const now = new Date();
  const auditsBefore = await prisma.adminAuditLog.count({ where: { action: { startsWith: "model_catalog.billing_" } } });
  const row = await startImageBillingMeasurement({ plan: wanPlan, session, env: ON, now });
  assert.equal(row.status, "running");
  assert.equal(await budgetHeld("qwen", now), 200_000);
  // One run at a time.
  await assert.rejects(
    startImageBillingMeasurement({ plan: wanPlan, session, env: ON, now }),
    (error: unknown) => error instanceof MeasurementRefusal && error.code === "measurement_running"
  );

  const calls: unknown[] = [];
  await runImageBillingMeasurement({
    measurementId: row.id,
    session,
    generate: async (model, input) => {
      calls.push({ apiModelId: model.apiModelId, size: input.size });
      return qwenResult({ image_count: 1, width: 1024, height: 1024 });
    },
  });
  assert.equal(calls.length, 2);
  const done = await prisma.imageBillingMeasurement.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(done.status, "completed");
  assert.equal(done.spentMicroUsd, 60_000);
  // The unspent part of the maximum went back to the budget.
  assert.equal(await budgetHeld("qwen", now), 60_000);
  assert.equal((done.verdict as { confirmable: boolean }).confirmable, true);
  // No image is stored: the samples hold counts only.
  assert.doesNotMatch(JSON.stringify(done.samples), /not kept|imageBytes/);

  await assert.rejects(
    confirmImageBillingTerms({ measurementId: row.id, sources: ["https://example.com/wan"], session }),
    (error: unknown) => error instanceof MeasurementRefusal && error.code === "unofficial_source"
  );
  assert.equal(await confirmedBillingTermsFor("qwen", WAN), null);
  await confirmImageBillingTerms({ measurementId: row.id, sources: [QWEN_SOURCE], session });
  assert.equal((await confirmedBillingTermsFor("qwen", WAN))?.kind, "per_image_no_thinking");
  // Append-only at the database: no edit, delete or truncate of confirmed terms.
  await assert.rejects(prisma.imageModelBillingTerms.updateMany({ data: { kind: "tokens_per_image" } }), /append-only/);
  await assert.rejects(prisma.imageModelBillingTerms.deleteMany({}), /append-only/);
  await assert.rejects(prisma.$executeRawUnsafe(`TRUNCATE "ImageModelBillingTerms"`), /append-only/);
  assert.equal(
    await prisma.adminAuditLog.count({ where: { action: { startsWith: "model_catalog.billing_" } } }),
    auditsBefore + 3
  );

  // The same model through the catalogue: a runtime profile, a price revision
  // with no thinking cost, and turning it on -- all refused before the terms.
  await updateCatalogEntry({
    category: "image",
    modelId: WAN,
    patch: {
      profile: {
        provider: "qwen",
        apiModelId: WAN,
        name: "Wan 2.7 Image",
        lifecycle: "preview",
        sizes: ["1024x1024"],
        qualities: ["medium"],
        latencyClass: "balanced",
        provenance: [],
        outputMimeTypes: ["image/png"],
      },
    },
    session,
  });
  await createImagePriceRevision({
    modelId: WAN,
    revision: {
      pricingVersion: "wan2.7-image-2026-11-13",
      prices: [{ quality: "medium", size: "1024x1024", credits: 60, outputCostMicroUsd: 30_000 }],
      verification: { verifiedAt: "2026-11-13", sources: [QWEN_SOURCE], thinkingCapMicroUsd: 0 },
    },
    session,
  });
  await updateCatalogEntry({ category: "image", modelId: WAN, patch: { enabled: true }, session });
  await refreshImageModelCatalog({ force: true });
  assert.equal(getImageModel(WAN)?.disabledReason, null);
  assert.equal(getImageModel(WAN)?.billingTerms?.kind, "per_image_no_thinking");
});

test("a sample that bills past its ceiling stops the run, and the overage is charged to the budget", async () => {
  const plan = measurementPlanSchema.parse({
    method: "tokens_per_image",
    provider: "openai",
    apiModelId: "gpt-image-2.6-flare",
    options: [
      { quality: "low", size: "1024x1024" },
      { quality: "high", size: "1024x1024" },
    ],
    samplesPerOption: 1,
    imageOutputUsdPerMTok: 30,
    maxCostMicroUsd: 1_100_000,
  });
  const ceiling = sampleCeilingMicroUsd(plan);
  const now = new Date();
  const row = await startImageBillingMeasurement({ plan, session, env: ON, now });
  let calls = 0;
  await runImageBillingMeasurement({
    measurementId: row.id,
    session,
    generate: async () => {
      calls += 1;
      return { ...qwenResult({ output_tokens: 40_000 }), outputTokens: 40_000, mimeType: "image/png" };
    },
  });
  assert.equal(calls, 1);
  const done = await prisma.imageBillingMeasurement.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(done.status, "stopped");
  assert.equal(done.stopReason, "sample_over_ceiling");
  assert.ok(done.spentMicroUsd > ceiling);
  assert.equal(await budgetHeld("openai", now), done.spentMicroUsd);
  // A stopped run cannot be confirmed.
  await assert.rejects(
    confirmImageBillingTerms({ measurementId: row.id, sources: ["https://developers.openai.com/api/docs/pricing"], session }),
    (error: unknown) => error instanceof MeasurementRefusal && error.code === "measurement_not_completed"
  );
});

test("Nano Banana 2.1: samples without images complete but cannot be confirmed", async () => {
  const plan = measurementPlanSchema.parse({
    method: "output_limit",
    provider: "google",
    apiModelId: "gemini-nano-banana-2.1",
    maxOutputTokens: 2_048,
    samples: 2,
    textOutputUsdPerMTok: 7.5,
    imageOutputUsdPerMTok: 30,
    maxCostMicroUsd: 1_000_000,
  });
  const row = await startImageBillingMeasurement({ plan, session, env: ON });
  const sent: unknown[] = [];
  await runImageBillingMeasurement({
    measurementId: row.id,
    session,
    generate: async (model) => {
      sent.push({ maxOutputTokens: model.maxOutputTokens, thinkingLevel: model.thinkingLevel ?? null });
      const error = new ImageProviderError("provider_failed", "no image", 200, "req");
      error.nonImageBillableTokens = 2_040;
      error.billedImageTokens = 0;
      throw error;
    },
  });
  // The measured request is the one the confirmed terms would describe.
  assert.deepEqual(sent[0], { maxOutputTokens: 2_048, thinkingLevel: null });
  const done = await prisma.imageBillingMeasurement.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(done.status, "completed");
  assert.equal(done.spentMicroUsd, 2 * (Math.ceil(2_040 * 7.5) + 5_000));
  await assert.rejects(
    confirmImageBillingTerms({ measurementId: row.id, sources: ["https://aistudio.google.com/docs/pricing"], session }),
    (error: unknown) => error instanceof MeasurementRefusal && error.code === "not_confirmable"
  );
});
