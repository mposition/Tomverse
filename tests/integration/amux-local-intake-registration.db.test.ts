import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { localIntakeCardDigest, type LocalIntakeCard } from "@/lib/amux/localIntakeCore";
import { commitLocalIntakeRegistration, readLocalIntakeRegistration } from "@/lib/amux/localIntakeRegistration";
import { previewLocalIntakeCard } from "@/lib/amux/localIntakeRegistrationCore";
import { prisma } from "@/lib/prisma";

// Real PostgreSQL evidence for one local intake card.
// This test calls commit directly. applyLocalIntakeRegistration also requires
// TOMVERSE_AMUX_INTAKE_LOCAL_APPLY=enabled, which this process does not set.
// A missing TEST_DATABASE_URL means this file was not executed, not that it passed.

const secret = `local-intake-hmac-${randomUUID()}-extra`;
const actorUserId = `amux-local-intake-${randomUUID()}`;
const session = {
  user: { id: actorUserId, email: "local-intake@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;
const request = new Request("https://tomverse.test/api/admin/amux/intake?action=local-register");
const cardIds: string[] = [];
const head = "b".repeat(40);
const digest = "cd".repeat(32);
const stamp = new Date().toISOString();

const requireDedicatedDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: AMUX local intake DB tests require DATABASE_URL=TEST_DATABASE_URL");
  }
  const url = new URL(testRaw);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const schemaName = url.searchParams.get("schema");
  const dedicatedSchema = schemaName === "tomverse_amux_test";
  const canonicalCiDatabase =
    databaseName === "tomverse_test" &&
    (schemaName === null || schemaName === "public") &&
    ["127.0.0.1", "localhost"].includes(url.hostname);
  if ((!dedicatedSchema && !canonicalCiDatabase) || url.hostname.startsWith("pooled.")) {
    throw new Error("REFUSE: AMUX local intake DB tests require a direct dedicated test database");
  }
};

requireDedicatedDatabase();

after(async () => {
  if (cardIds.length > 0) {
    await prisma.amuxWorkItem.updateMany({
      where: { id: { in: cardIds } },
      data: { archivedAt: new Date() },
    });
  }
  await prisma.$disconnect();
});

const card = (title: string): LocalIntakeCard => ({
  localId: "card-01",
  title,
  problem: "The operator needs one confirmed backlog card.",
  rationale: "A single card keeps the review bounded.",
  scopeIn: ["Store the confirmed card"],
  scopeOut: ["Do not start a worker"],
  acceptanceCriteria: ["The card status is backlog"],
  evidence: ["Operator confirmed the draft"],
  priority: "p2",
  priorityRationale: "Ordinary intake does not need an emergency rationale.",
  kindProposal: "doc",
  repositoryPaths: ["docs/policy/amux-intake.md"],
  dependencyIds: [],
  duplicateCandidateIds: [],
  risks: ["A stale snapshot"],
  estimatedSize: "small",
});

const confirmed = (title: string) => {
  const raw = {
    schemaVersion: 1,
    analysisId: "local-amux-intake:22222222-2222-4222-8222-222222222222",
    inputDigest: digest,
    boardSnapshotDigest: digest,
    snapshotGeneratedAt: stamp,
    generatedAt: stamp,
    agentReceipt: {
      adapter: "codex",
      model: "gpt-6-astra",
      reasoningEffort: "high",
      promptVersion: "local-amux-intake-prompt-v1",
      repositoryHeads: { tomverse: head, privateDocs: head },
    },
    classification: "investigation",
    recommendation: "new_cards",
    summary: "One investigation card.",
    questions: [],
    cards: [card(title)],
  };
  const body = JSON.stringify(raw);
  const preview = previewLocalIntakeCard(body, {
    now: new Date(),
    liveSnapshotDigest: digest,
    localId: "card-01",
    confirmationDigest: localIntakeCardDigest(card(title)),
    secret,
    existingIds: [],
    envValue: undefined,
    codeLatch: true,
  });
  if (!preview.plan) throw new Error(preview.code ?? "approval_required");
  return preview.plan;
};

const untouchedCounts = async () => ({
  attempts: await prisma.amuxExecutionAttempt.count(),
  deliveries: await prisma.amuxWorkDelivery.count(),
  routes: await prisma.amuxRouteDecision.count(),
  costs: await prisma.amuxCostLedgerEntry.count(),
  creditLots: await prisma.creditLot.count(),
  creditLedger: await prisma.creditLedgerEntry.count(),
  dependencies: await prisma.amuxWorkDependency.count(),
  todos: await prisma.amuxWorkItem.count({ where: { status: "todo" } }),
});

test("local registration writes one backlog card, one normalized row, and no dependency", async () => {
  const title = `Local intake ${randomUUID()}`;
  const plan = confirmed(title);
  assert.equal((await readLocalIntakeRegistration(plan)).kind, "absent");
  const before = await untouchedCounts();
  const result = await prisma.$transaction((tx) =>
    commitLocalIntakeRegistration(tx, {
      session,
      request,
      plan,
      approvalId: randomUUID(),
    }),
  );
  assert.equal(result.created, true);
  cardIds.push(result.cardId);
  const seen = await readLocalIntakeRegistration(plan);
  assert.equal(seen.kind, "committed");
  const stored = await prisma.amuxWorkItem.findUnique({ where: { id: result.cardId } });
  assert.equal(stored?.description, null);
  assert.equal(stored?.executionBrief, null);
  assert.equal(stored?.kind, "unknown");
  assert.equal(stored?.status, "backlog");
  assert.equal(stored?.owner, null);
  const normalized = await prisma.$queryRaw<Array<{ sourceSystem: string }>>`
    SELECT "sourceSystem" FROM "AmuxLocalIntakeNormalized" WHERE "workItemId" = ${result.cardId}
  `;
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.sourceSystem, "local-agent-intake");
  const draft = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIntakeDraft" WHERE "workItemId" = ${result.cardId}
  `;
  assert.equal(draft.length, 0);
  const audit = await prisma.adminAuditLog.findUnique({ where: { id: result.auditId ?? "" } });
  assert.equal(JSON.stringify(audit?.metadata ?? {}).includes(title), false);
  assert.deepEqual(await untouchedCounts(), before);
});
