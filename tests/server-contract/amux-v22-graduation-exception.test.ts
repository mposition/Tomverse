import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const now = new Date("2026-10-11T00:00:00Z");
const world = { control: null as null | Record<string, unknown>,
  audit: null as null | Record<string, unknown>, writes: 0, readyChecks: 0,
  halted: false };
const db = {
  amuxV22PromotionControl: {
    findUnique: async () => world.control,
    upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
      world.control = { ...(world.control ?? args.create), ...args.update };
    },
  },
  amuxRecommendationDecision: { findMany: async () => [] },
  adminAuditLog: { findUnique: async () => world.audit },
  amuxRecommendationAutoHalt: { findFirst: async () => world.halted ? { id: "halt" } : null },
  amuxRecommendationCapacity: { findUnique: async () => ({ active: true, wipLimit: 9 }) },
  amuxWorkItem: { count: async () => 0 },
  amuxWorkerRuntime: { count: async () => 3 },
  amuxRecommendationAutoCostEntry: { findMany: async () => [] },
  appSetting: { findUnique: async () => ({ value: JSON.stringify({
    version: 1, state: "normal", transition_id: null,
    changed_at: now.toISOString(), reason: "synthetic normal mode", ticket: "S0",
  }) }) },
  $queryRaw: async (strings: TemplateStringsArray) => strings.join("").includes("clock_timestamp") ?
    [{ now }] : [{ id: "score", taskId: "task", scoreTotal: 80 }],
  $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
};
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: db } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async () => undefined,
  writeAdminAuditLog: async (input: Record<string, unknown>) => {
    world.writes += 1;
    world.audit = { ...input, actorUserId: "owner-1", entryHash: "canonical-hash" };
    return `audit-${world.writes}`;
  },
} });
mock.module(mod("lib/amux/autoPromotionService.ts"), { namedExports: {
  OWNER_TRANSACTION_LIMITS: {}, TICK_TRANSACTION_LIMITS: {},
  withAutoTransaction: async (_id: unknown, _limits: unknown,
    fn: (tx: unknown, now: Date, receipt: () => void) => unknown) => fn(db, now, () => {}),
} });
mock.module(mod("lib/amux/orchestratorHaltStore.ts"), { namedExports: {
  findOpenAmuxOrchestratorHalt: async () => null,
} });
// The services read the assignment catalog (orchestration policy version 35,
// section 3); while R2c is off it is the v22 variable, stood in for here.
mock.module(mod("lib/amux/workerAssignmentCatalog.ts"), { namedExports: {
  readAmuxAssignmentCatalogs: async () => ({ workers: [], v22: [1, 2, 3].map((n) => ({ worker_name: `worker-${n}` })) }),
} });
mock.module(mod("lib/amux/v4TaskReadyService.ts"), { namedExports: {
  loadAmuxV4TaskReadyContext: async () => ({}),
  evaluateAmuxV4TaskReadyInTransaction: async () => { world.readyChecks += 1; return { ready: false }; },
} });
mock.module(mod("lib/amux/v22AutoPromotionAudit.ts"), { namedExports: {
  writeV22AutoPromotionAudit: async () => "system-audit",
} });
const load = () => import(mod("lib/amux/v22AutoPromotionService.ts"));
const input = { session: { user: { id: "owner-1" } },
  request: new Request("https://tomverse.test"), active: true,
  expectedAuditLogId: null };

test("activation needs the owner, is recorded, and ticks enforce revocation and audit binding", async () => {
  const previous = ["TOMVERSE_AMUX_BOARD_AUTO_PROMOTE"]
    .map((key) => [key, process.env[key]] as const);
  try {
    process.env.TOMVERSE_AMUX_BOARD_AUTO_PROMOTE = "disabled";
    const service = await load();
    // No count of decisions gates activation (2026-11-16).
    await service.configureV22AutoPromotion({ ...input });
    assert.equal(world.writes, 1);
    const status = await service.readV22AutoPromotionControl();
    assert.equal(status.graduation.ok, true);
    assert.equal(status.graduation.count, 0);
    assert.equal(status.active, true);
    assert.equal((await service.tickV22AutoPromotion()).reason, "no_ready_candidate");
    assert.equal(world.readyChecks, 1);

    world.audit!.actorUserId = "another-owner";
    assert.equal((await service.tickV22AutoPromotion()).reason, "v22_not_activated");
    world.audit!.actorUserId = "owner-1";
    world.halted = true;
    assert.equal((await service.tickV22AutoPromotion()).reason, "auto_halted");
    assert.equal(world.readyChecks, 1);
    await service.configureV22AutoPromotion({ ...input, active: false,
      expectedAuditLogId: world.control!.authorizationAuditLogId as string });
    assert.equal(world.control!.active, false);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
