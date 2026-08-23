import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import type { ProviderModelCatalogResult } from "@/lib/providerModelCatalogMonitor";
import { reconcileCatalogWithRegistry } from "@/lib/providerModelCatalogReconciliation";

// What an automatic disable leaves behind (ML-08).
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md §9.2,
// docs/policy/default-model-luna-migration.md §4.7.
//
// The monitor could already prove a provider had stopped serving a model and
// the reconciler could already switch it off, and between them they left
// `enabled=false` and a sentence in a column. Nobody was asked anything, and
// the accounts holding that model learned about it by watching their default
// resolve to something else.
//
// Two facts are worth a database to establish: that the disable and the queue
// row commit together, and that an item for accounts who hold the model cannot
// be closed without the notice -- which is `communicationRequired`, set from a
// count taken at the moment of the disable.

const provider = "groq";

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ModelLifecycleWorkItemEvent", "ModelLifecycleWorkItem",
      "ModelRegistryEntry", "Conversation", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const seedModel = async (apiModel: string, enabled = true) => {
  const id = `auto-disable-${randomUUID().slice(0, 8)}`;
  await prisma.modelRegistryEntry.create({
    data: {
      id,
      name: apiModel,
      apiModel,
      provider,
      enabled,
      status: enabled ? "enabled" : "disabled",
      publiclyListed: true,
      minimumPlan: "Free",
      usageClass: "standard",
      creditWeight: 1,
      apiBaseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnvName: "GROQ_API_KEY",
    },
  });
  return { id, apiModel };
};

/**
 * A completed scan that saw `present` and did not see `missing`.
 *
 * Two enabled models on purpose: a provider whose whole lineup goes missing at
 * once is held rather than disabled, and that branch is not what this covers.
 */
const scan = (
  missing: Array<{ modelId: string; apiModel: string; consecutiveMissing: number }>,
  mapped: string[]
): ProviderModelCatalogResult[] => [
  {
    provider: provider as ProviderModelCatalogResult["provider"],
    status: "checked",
    discovered: mapped.length,
    mapped,
    candidates: [],
    newCandidates: [],
    missing,
    lifecycleWarnings: [],
  },
];

const someone = () =>
  prisma.user.create({
    data: { email: `${randomUUID()}@example.test`, name: "Holder" },
  });

test("an automatic disable leaves a work item somebody has to answer", async () => {
  const retiring = await seedModel("llama-4-scout-17b");
  const keeping = await seedModel("llama-3-3-70b");

  const result = await reconcileCatalogWithRegistry({
    results: scan(
      [{ modelId: retiring.id, apiModel: retiring.apiModel, consecutiveMissing: 3 }],
      [keeping.id]
    ),
    confirmationRuns: 3,
  });

  assert.equal(result.disabled.length, 1);
  const row = await prisma.modelRegistryEntry.findUniqueOrThrow({
    where: { id: retiring.id },
    select: { enabled: true, status: true },
  });
  assert.equal(row.enabled, false);
  assert.equal(row.status, "disabled");

  const items = await prisma.modelLifecycleWorkItem.findMany();
  assert.equal(items.length, 1);
  assert.equal(items[0].action, "retire");
  assert.equal(items[0].status, "discovered");
  assert.equal(items[0].apiModel, retiring.apiModel);
  assert.equal(items[0].modelId, retiring.id);

  // The one event whose actor is null: a scan observed something, nobody
  // decided anything.
  const events = await prisma.modelLifecycleWorkItemEvent.findMany({
    where: { workItemId: items[0].id },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].actorEmail, null);
  assert.equal(events[0].fromStatus, null);
  assert.equal(events[0].toStatus, "discovered");
});

test("with nobody holding the model, no notice is owed", async () => {
  const retiring = await seedModel("llama-4-scout-17b");
  const keeping = await seedModel("llama-3-3-70b");

  await reconcileCatalogWithRegistry({
    results: scan(
      [{ modelId: retiring.id, apiModel: retiring.apiModel, consecutiveMissing: 3 }],
      [keeping.id]
    ),
    confirmationRuns: 3,
  });

  const item = await prisma.modelLifecycleWorkItem.findFirstOrThrow();
  assert.equal(item.communicationRequired, false);
  assert.equal(item.severity, "high");
  assert.deepEqual((item.evidence as { storedUsage: unknown }).storedUsage, {
    defaultModelAccounts: 0,
    newConversationAccounts: 0,
    conversationAccounts: 0,
    distinctAccounts: 0,
  });
});

test("an account holding it makes the notice non-skippable", async () => {
  const retiring = await seedModel("llama-4-scout-17b");
  const keeping = await seedModel("llama-3-3-70b");

  const user = await someone();
  await prisma.userSettings.create({
    data: { userId: user.id, defaultModel: retiring.id },
  });

  await reconcileCatalogWithRegistry({
    results: scan(
      [{ modelId: retiring.id, apiModel: retiring.apiModel, consecutiveMissing: 3 }],
      [keeping.id]
    ),
    confirmationRuns: 3,
  });

  const item = await prisma.modelLifecycleWorkItem.findFirstOrThrow();
  assert.equal(item.communicationRequired, true);
  assert.equal(item.severity, "critical");
  const usage = (item.evidence as { storedUsage: { distinctAccounts: number } }).storedUsage;
  assert.equal(usage.distinctAccounts, 1);
  assert.match(String(item.recommendation), /1 account holding/);
});

test("one account holding it three ways is counted once", async () => {
  const retiring = await seedModel("llama-4-scout-17b");
  const keeping = await seedModel("llama-3-3-70b");

  const user = await someone();
  await prisma.userSettings.create({
    data: {
      userId: user.id,
      defaultModel: retiring.id,
      newConversationModelIds: [retiring.id, keeping.id],
    },
  });
  await prisma.conversation.create({
    data: {
      userId: user.id,
      title: "Holding it",
      selectedModels: JSON.stringify([retiring.id]),
    },
  });

  await reconcileCatalogWithRegistry({
    results: scan(
      [{ modelId: retiring.id, apiModel: retiring.apiModel, consecutiveMissing: 3 }],
      [keeping.id]
    ),
    confirmationRuns: 3,
  });

  const item = await prisma.modelLifecycleWorkItem.findFirstOrThrow();
  const usage = (
    item.evidence as {
      storedUsage: {
        defaultModelAccounts: number;
        newConversationAccounts: number;
        conversationAccounts: number;
        distinctAccounts: number;
      };
    }
  ).storedUsage;
  assert.equal(usage.defaultModelAccounts, 1);
  assert.equal(usage.newConversationAccounts, 1);
  assert.equal(usage.conversationAccounts, 1);
  // Three rows, one person. A notice addressed to the sum would go to the same
  // account three times.
  assert.equal(usage.distinctAccounts, 1);
});

test("a longer model id is not counted as the one being retired", async () => {
  const retiring = await seedModel("gpt-5-4");
  const keeping = await seedModel("llama-3-3-70b");

  const user = await someone();
  await prisma.userSettings.create({
    // The successor, not the model going away. A substring match would count
    // this account and address it a notice about a model it does not use.
    data: { userId: user.id, defaultModel: `${retiring.id}-mini` },
  });
  await prisma.conversation.create({
    data: {
      userId: user.id,
      title: "Using the successor",
      selectedModels: JSON.stringify([`${retiring.id}-mini`]),
    },
  });

  await reconcileCatalogWithRegistry({
    results: scan(
      [{ modelId: retiring.id, apiModel: retiring.apiModel, consecutiveMissing: 3 }],
      [keeping.id]
    ),
    confirmationRuns: 3,
  });

  const item = await prisma.modelLifecycleWorkItem.findFirstOrThrow();
  const usage = (item.evidence as { storedUsage: { distinctAccounts: number } }).storedUsage;
  assert.equal(usage.distinctAccounts, 0);
  assert.equal(item.communicationRequired, false);
});

test("a second disable of the same model does not open a second item", async () => {
  const retiring = await seedModel("llama-4-scout-17b");
  const keeping = await seedModel("llama-3-3-70b");
  const results = scan(
    [{ modelId: retiring.id, apiModel: retiring.apiModel, consecutiveMissing: 3 }],
    [keeping.id]
  );

  await reconcileCatalogWithRegistry({ results, confirmationRuns: 3 });
  // Re-enabled by hand, then missing again: the same open question, not a
  // second one.
  await prisma.modelRegistryEntry.update({
    where: { id: retiring.id },
    data: { enabled: true, status: "enabled" },
  });
  await reconcileCatalogWithRegistry({ results, confirmationRuns: 3 });

  assert.equal(await prisma.modelLifecycleWorkItem.count(), 1);
});

test("a provider losing its whole lineup is held, and opens nothing", async () => {
  const first = await seedModel("llama-4-scout-17b");
  const second = await seedModel("llama-3-3-70b");

  const result = await reconcileCatalogWithRegistry({
    results: scan(
      [
        { modelId: first.id, apiModel: first.apiModel, consecutiveMissing: 3 },
        { modelId: second.id, apiModel: second.apiModel, consecutiveMissing: 3 },
      ],
      []
    ),
    confirmationRuns: 3,
  });

  assert.equal(result.held.length, 1);
  assert.equal(result.disabled.length, 0);
  // Nothing was disabled, so nothing is owed an answer about a disable. The
  // hold has its own incident.
  assert.equal(await prisma.modelLifecycleWorkItem.count(), 0);
});
