import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

import { calculateV4TaskCostCeiling } from "../../lib/amux/v4TaskCostCeilingCore.ts";

// The owner's ceiling re-approval (lib/amux/v4TaskCeilingReapprovalService.ts):
// the audit chain lock before the Task row, the offer judged again under the
// lock, the owner's binding to what they were shown, and the one audit entry.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

const route = (id: string, modelId: string, outputPrice: number) => ({ routeId: id,
  workerName: `worker-${id}`, provider: "codex", modelId, routePolicyDigest: "b".repeat(64),
  enabled: true, roles: ["implement"], grades: ["advanced"], pricingSource: "verified-price-record",
  pricingVerifiedAt: "2026-10-01T00:00:00.000Z", uncachedInputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: outputPrice, cacheReadMicroUsdPerMillion: 100_000,
  cacheWriteMicroUsdPerMillion: 150_000, toolCostCapMicroUsdPerAttempt: 500 });
const receipt = (routes: ReturnType<typeof route>[], asOfIso: string) => {
  const result = calculateV4TaskCostCeiling({ role: "implement", grade: "advanced",
    catalogVersion: "catalog-v1", catalogDigest: "a".repeat(64), pricingVersion: "pricing-v1",
    gradeRulesVersion: "grade-v1", asOfIso, caps: { uncachedInputTokens: 1000, outputTokens: 1000,
      cacheReadTokens: 500, cacheWriteTokens: 500, maxAttempts: 2 }, routes });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("receipt");
  return result.receipt;
};
const approved = receipt([route("a", "model-a", 2_000_000)], "2026-10-01T01:00:00.000Z");
const current = receipt([route("a", "model-a", 2_000_000), route("b", "model-b", 9_000_000)],
  "2026-11-14T01:00:00.000Z");

class FakeOwnerError extends Error {
  constructor(readonly code: "forbidden" | "busy") { super(code); }
}
class FakeCatalogError extends Error {}

type Task = { id: string; displayKey: string | null; sourceSystem: string; cardType: string;
  status: string; revision: number; taskRole: string | null; executionGrade: string | null;
  v4SourceApprovalId: string | null; activeDelivery: boolean; liveAttempt: boolean };
const baseTask = (): Task => ({ id: "task-1", displayKey: "AMUX-IMGOUT-003", sourceSystem: "admin-idea-v4",
  cardType: "task", status: "backlog", revision: 4, taskRole: "implement", executionGrade: "advanced",
  v4SourceApprovalId: "decision-1", activeDelivery: false, liveAttempt: false });
const world = {
  owner: true, task: baseTask() as Task | null, approved: approved as typeof approved | null,
  current: current as typeof current | null, catalogFails: false, lockFails: false,
  events: [] as string[], audits: [] as Array<Record<string, unknown>>,
};
const reset = () => {
  world.owner = true; world.task = baseTask(); world.approved = approved; world.current = current;
  world.catalogFails = false; world.lockFails = false; world.events = []; world.audits = [];
};

const tx = {
  $queryRaw: async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("AmuxWorkItem")) {
      world.events.push(sql.includes("FOR UPDATE OF w NOWAIT") ? "task_locked" : "task_read");
      if (world.lockFails) throw Object.assign(new Error("lock"), { code: "P2010", meta: { code: "55P03" } });
      return world.task ? [world.task] : [];
    }
    return [{}];
  },
  amuxIdeaUnitDecision: { findUnique: async () => ({ state: "consumed", action: "register_card",
    registeredWorkItemId: "task-1",
    confirmationSnapshot: { card: { task: { costReceipt: approved } } } }) },
};

let installed = false;
async function load() {
  if (!installed) {
    installed = true;
    mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } } });
    mock.module(mod("lib/adminAudit.ts"), { namedExports: {
      takeAuditChainLock: async () => { world.events.push("audit_locked"); },
      writeAdminAuditLog: async (input: Record<string, unknown>) => {
        world.events.push("audit_written"); world.audits.push(input); return "audit-1";
      } } });
    mock.module(mod("lib/amux/legacyCardOwnerService.ts"), { namedExports: {
      AmuxLegacyCardOwnerError: FakeOwnerError,
      assertAmuxLegacyCardOwner: async () => { if (!world.owner) throw new FakeOwnerError("forbidden"); } } });
    mock.module(mod("lib/amux/v4TaskCostCatalogApprovalService.ts"), { namedExports: {
      AmuxV4TaskCatalogApprovalError: FakeCatalogError,
      calculateCurrentApprovedAmuxV4TaskCost: async () => {
        if (world.catalogFails) throw new FakeCatalogError("evidence_unverified");
        return { receipt: world.current };
      } } });
    mock.module(mod("lib/amux/v52GradeReceipt.ts"), { namedExports: {
      readAmuxV52TaskReceipt: async () => world.approved } });
  }
  return import(mod("lib/amux/v4TaskCeilingReapprovalService.ts"));
}

const shown = { catalogDigest: current.catalogDigest, ceilingMicroUsd: current.ceilingMicroUsd };
const call = async (overrides: Record<string, unknown> = {}) => {
  const { reapproveAmuxV4TaskCeilingForOwner } = await load();
  return reapproveAmuxV4TaskCeilingForOwner({ session: {} as never, request: new Request("https://x.test"),
    taskId: "task-1", revision: 4, ...shown, ...overrides });
};

test("the owner's re-approval locks the chain, then the Task, and writes one bound entry", async () => {
  reset();
  const result = await call();
  assert.deepEqual(result, { outcome: "reapproved", auditId: "audit-1", ceilingMicroUsd: current.ceilingMicroUsd });
  assert.deepEqual(world.events, ["audit_locked", "task_locked", "audit_written"]);
  assert.equal(world.audits.length, 1);
  const audit = world.audits[0]!;
  assert.equal(audit.action, "amux.task.ceiling_reapproved");
  assert.equal(audit.targetType, "AmuxWorkItem");
  assert.equal(audit.targetId, "task-1");
  const metadata = audit.metadata as Record<string, unknown>;
  assert.equal(metadata.confirmedReceiptDigest, approved.receiptDigest);
  assert.equal(metadata.previousReceiptDigest, approved.receiptDigest);
  assert.equal(metadata.previousCeilingMicroUsd, approved.ceilingMicroUsd);
  assert.equal(metadata.newCeilingMicroUsd, current.ceilingMicroUsd);
  assert.equal(metadata.newReceiptDigest, current.receiptDigest);
  assert.deepEqual(metadata.newReceipt, current);
  assert.equal(metadata.reconfirmReason, "task_route_changed");
});

test("a price, revision or Task that moved since the owner looked writes nothing", async () => {
  const cases: Array<[() => void, Record<string, unknown>, unknown]> = [
    [() => {}, { ceilingMicroUsd: "1" }, { outcome: "refused", reason: "cost_changed" }],
    [() => {}, { catalogDigest: "c".repeat(64) }, { outcome: "refused", reason: "cost_changed" }],
    [() => {}, { revision: 5 }, { outcome: "refused", reason: "revision_changed" }],
    [() => { world.task!.status = "in_progress"; }, {}, { outcome: "refused", reason: "not_waiting" }],
    [() => { world.task!.liveAttempt = true; }, {}, { outcome: "refused", reason: "attempt_live" }],
    [() => { world.current = approved; }, {}, { outcome: "refused", reason: "within_approved_ceiling" }],
    [() => { world.approved = null; }, {}, { outcome: "refused", reason: "approval_invalid" }],
    [() => { world.catalogFails = true; }, {}, { outcome: "refused", reason: "cost_unavailable" }],
    [() => { world.task = null; }, {}, { outcome: "not_found" }],
    [() => { world.task!.sourceSystem = "workboard"; }, {}, { outcome: "not_found" }],
  ];
  for (const [arrange, overrides, expected] of cases) {
    reset(); arrange();
    assert.deepEqual(await call(overrides), expected);
    assert.deepEqual(world.audits, []);
  }
  reset();
  assert.deepEqual(await call({ taskId: "../x" }), { outcome: "not_found" });
  assert.deepEqual(world.events, []);
});

test("only the owner reaches it, and a held Task answers busy", async () => {
  reset(); world.owner = false;
  await assert.rejects(call(), (error: unknown) => error instanceof FakeOwnerError && error.code === "forbidden");
  assert.deepEqual(world.events, []);
  reset(); world.lockFails = true;
  await assert.rejects(call(), (error: unknown) => error instanceof FakeOwnerError && error.code === "busy");
  assert.deepEqual(world.audits, []);
});

test("the detail read shows the offer without a lock, and nothing for other cards", async () => {
  const { readAmuxV4TaskCeilingReapprovalView } = await load();
  reset();
  const view = await readAmuxV4TaskCeilingReapprovalView("task-1");
  assert.equal(view?.eligible, true);
  assert.equal(view?.approvedCeilingMicroUsd, approved.ceilingMicroUsd);
  assert.equal(view?.currentCeilingMicroUsd, current.ceilingMicroUsd);
  assert.deepEqual(view?.routes.map((item: { workerName: string; approved: boolean }) =>
    [item.workerName, item.approved]),
    [["worker-a", true], ["worker-b", false]]);
  assert.deepEqual(world.events, ["task_read"]);
  reset(); world.current = approved;
  const within = await readAmuxV4TaskCeilingReapprovalView("task-1");
  assert.equal(within?.eligible, false);
  assert.equal(within?.refusal, "within_approved_ceiling");
  reset(); world.task!.cardType = "story";
  assert.equal(await readAmuxV4TaskCeilingReapprovalView("task-1"), null);
});
