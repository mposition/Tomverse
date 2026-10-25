import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Session } from "next-auth";

import { inspectV4TaskCostCatalog } from "@/lib/amux/v4TaskCostCatalogCore";
import { AMUX_TASK_CATALOG_DEFAULT_CAPS } from "@/lib/amux/v4TaskCostCatalogDraftCore";
import { approveAmuxV4TaskCatalog, calculateCurrentApprovedAmuxV4TaskCost,
  draftAmuxV4TaskCatalog, readCurrentAmuxV4TaskCatalog } from
  "@/lib/amux/v4TaskCostCatalogApprovalService";
import { resolveModelPricing } from "@/lib/modelPricing";
import { getRuntimeModel } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";
import { seedAmuxWorkerCatalog } from "./amuxDerivedCatalogFixture";

// Owner decision 2026-10-25: the Task cost catalog is drafted from the worker
// registry and the Admin › Models prices, and the owner approves it as drafted.
// Against PostgreSQL through the migration history: the draft reads both
// registries, the approval redrafts it and accepts only the same digest, and
// a Task's registration-time ceiling is then calculated from it.

const requireDedicatedAmuxTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
  const url = new URL(testRaw);
  const schemaName = url.searchParams.get("schema");
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (schemaName !== "tomverse_amux_test" && !(databaseName === "tomverse_test" &&
      (schemaName === null || schemaName === "public") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) {
    throw new Error("REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database");
  }
};
requireDedicatedAmuxTestDatabase();

const OWNER_EMAIL = `catalog-owner-${randomUUID()}@example.test`;
const PRICED_MODEL = `claude-draft-test-${randomUUID().slice(0, 8)}`;
const UNPRICED_MODEL = `claude-draft-unpriced-${randomUUID().slice(0, 8)}`;
// A model the registry seeds with no price override: it inherits Chat pricing.
const INHERITED_MODEL = "claude-opus-4-8";
const REGISTRY_ROW = `draft-test-${randomUUID()}`;
const saved = { ...process.env };
let clearCatalog: () => Promise<unknown> = async () => undefined;
let session: Session;
const request = () => new Request("https://tomverse.test/admin");

before(async () => {
  process.env.ADMIN_EMAILS = OWNER_EMAIL;
  process.env.ADMIN_OWNER_EMAILS = OWNER_EMAIL;
  process.env.TOMVERSE_AMUX_V4_TASK_CATALOG_WRITE = "enabled";
  const user = await prisma.user.create({ data: { email: OWNER_EMAIL, lastLoginAt: new Date() } });
  session = { user: { id: user.id, email: OWNER_EMAIL, name: "owner",
    authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 3_600_000).toISOString() } as Session;
  clearCatalog = await seedAmuxWorkerCatalog([
    { worker_name: "claude-impl", routing_roles: ["implementation"],
      v22: { model: PRICED_MODEL, routing_roles: ["implement", "investigate"],
        tool_capabilities: ["repo_read", "repo_write"] } },
    { worker_name: "claude-chore", routing_roles: ["chore"],
      v22: { model: UNPRICED_MODEL, routing_roles: ["investigate"],
        tool_capabilities: ["repo_read"] } },
    { worker_name: "claude-contract", routing_roles: ["contract"],
      v22: { model: INHERITED_MODEL, routing_roles: ["design", "investigate"],
        tool_capabilities: ["repo_read", "repo_write"] } },
  ]);
  // The registry row names the worker's model as the API model it calls.
  await prisma.modelRegistryEntry.create({ data: { id: REGISTRY_ROW,
    name: "Draft test model", apiModel: PRICED_MODEL, provider: "anthropic",
    apiBaseUrl: "https://api.anthropic.com", apiKeyEnvName: "ANTHROPIC_API_KEY",
    minimumPlan: "pro", usageClass: "standard", creditWeight: 1,
    inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15,
    cachedInputPriceMultiplier: 0.1 } });
});

after(async () => {
  await prisma.modelRegistryEntry.deleteMany({ where: { id: REGISTRY_ROW } });
  await clearCatalog();
  process.env = saved;
  await prisma.$disconnect();
});

const approve = (catalog: unknown, overrides: Record<string, unknown> = {}) =>
  async (draft: { catalogDigest: string; evidenceDigest: string;
    preview: { expectedPreviousVersion: number } }) =>
    approveAmuxV4TaskCatalog({ session, request: request(), catalog,
      approvalId: randomUUID(), catalogDigest: draft.catalogDigest,
      evidenceDigest: draft.evidenceDigest,
      expectedPreviousVersion: draft.preview.expectedPreviousVersion,
      ownerConfirmedEvidence: true, ...overrides });

test("a draft from the registries is approved as drafted and prices a Task", async () => {
  const draft = await draftAmuxV4TaskCatalog(AMUX_TASK_CATALOG_DEFAULT_CAPS);
  assert.equal(draft.ok, true);
  if (!draft.ok) return;
  const inherited = await getRuntimeModel(INHERITED_MODEL);
  assert.ok(inherited, "the seeded registry has the inherited model");
  assert.equal(inherited.inputUsdPerMillionTokens ?? null, null, "it carries no override");
  const chat = resolveModelPricing(inherited, { estimatedPromptTokens: 1_000_000 });
  assert.deepEqual(draft.routes.map((route) => [route.workerName, route.modelId,
    route.grade, route.roles, route.inputUsdPerMillion, route.outputUsdPerMillion]), [
    ["claude-contract", INHERITED_MODEL, "frontier", ["design", "investigate"],
      Math.ceil(chat.inputUsdPerMillionTokens * 1e6) / 1e6,
      Math.ceil(chat.outputUsdPerMillionTokens * 1e6) / 1e6],
    ["claude-impl", PRICED_MODEL, "advanced", ["implement", "investigate"], 3, 15]]);
  assert.deepEqual(draft.skipped, [{ workerName: "claude-chore", modelId: UNPRICED_MODEL,
    reason: "price_missing" }]);
  // advanced: 600k input x $3 + 60k output x $15, two attempts.
  assert.equal(draft.maxCostMicroUsd.advanced, String(2 * (1_800_000 + 900_000)));
  assert.equal(draft.preview.catalogDigest, draft.catalogDigest);

  const approved = await approve(draft.catalog)(draft);
  assert.equal(approved.executionAuthorized, false);

  const current = await readCurrentAmuxV4TaskCatalog();
  assert.equal(current.status, "approved");
  assert.ok("caps" in current);
  assert.deepEqual(current.caps.advanced, AMUX_TASK_CATALOG_DEFAULT_CAPS.advanced);
  assert.equal(current.pricesExpireAt, draft.pricesExpireAt);

  const cost = await prisma.$transaction((tx) =>
    calculateCurrentApprovedAmuxV4TaskCost(tx, "implement", "advanced"));
  assert.equal(cost.approvalId, approved.approvalId);
  assert.equal(cost.receipt.ceilingMicroUsd, draft.maxCostMicroUsd.advanced);
  for (const [role, grade] of [["test", "advanced"], ["implement", "routine"]]) {
    await assert.rejects(prisma.$transaction((tx) =>
      calculateCurrentApprovedAmuxV4TaskCost(tx, role, grade)),
    `no worker runs ${role} at ${grade}, so it has no ceiling`);
  }
});

test("only a catalog the registries would draft is approved", async () => {
  const draft = await draftAmuxV4TaskCatalog(AMUX_TASK_CATALOG_DEFAULT_CAPS);
  assert.equal(draft.ok, true);
  if (!draft.ok) return;
  const routes = draft.catalog.routes as Array<Record<string, unknown>>;
  const edited = { ...draft.catalog, routes: routes.map((route) =>
    ({ ...route, uncachedInputMicroUsdPerMillion: 1 })) };
  await assert.rejects(approve(edited)(draft), { code: "catalog_changed" });
  // Even with its own digest, a rate the registries would not draft is refused.
  const inspection = inspectV4TaskCostCatalog(edited);
  assert.ok(inspection.ok);
  await assert.rejects(approve(edited, { catalogDigest: inspection.catalogDigest })(draft),
    { code: "evidence_unverified" });
  await assert.rejects(approve(draft.catalog, { evidenceDigest: "f".repeat(64) })(draft),
    { code: "evidence_unverified" });
});

test("a registry price change after drafting makes that draft unapprovable", async () => {
  const draft = await draftAmuxV4TaskCatalog(AMUX_TASK_CATALOG_DEFAULT_CAPS);
  assert.equal(draft.ok, true);
  if (!draft.ok) return;
  await prisma.modelRegistryEntry.update({ where: { id: REGISTRY_ROW },
    data: { inputUsdPerMillionTokens: 3.5 } });
  try {
    await assert.rejects(approve(draft.catalog)(draft), { code: "evidence_unverified" });
  } finally {
    await prisma.modelRegistryEntry.update({ where: { id: REGISTRY_ROW },
      data: { inputUsdPerMillionTokens: 3 } });
  }
});
