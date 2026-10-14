import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Session } from "next-auth";

import {
  AMUX_CARD_DISPLAY_BACKFILL_AUDIT_ACTION,
  AmuxCardDisplayKeyBackfillError,
  applyAmuxCardDisplayKeyBackfill,
  previewAmuxCardDisplayKeyBackfill,
} from "@/lib/amux/cardDisplayKeyBackfillService";
import { prisma } from "@/lib/prisma";

// docs/policy/amux-card-display-key.md §5, against PostgreSQL through the
// migration history: the apply writes exactly the previewed plan, under a
// human audit entry of the same transaction, without touching any other
// column, and refuses a plan whose digest no longer matches.

const requireDedicatedAmuxTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
  const url = new URL(testRaw);
  const schemaName = url.searchParams.get("schema");
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const usesDedicatedAmuxSchema = schemaName === "tomverse_amux_test";
  const usesCanonicalCiDatabase =
    databaseName === "tomverse_test" &&
    (schemaName === null || schemaName === "public") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!usesDedicatedAmuxSchema && !usesCanonicalCiDatabase) {
    throw new Error("REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database");
  }
};
requireDedicatedAmuxTestDatabase();

const created: string[] = [];
after(async () => {
  await prisma.amuxWorkItem.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

const owner = (): Session =>
  ({ user: { id: `backfill-owner-${randomUUID()}`, email: "owner@example.test" },
    expires: "2099-01-01T00:00:00.000Z" }) as Session;
const request = () => new Request("http://localhost/api/admin/amux/card-display-key-backfill", { method: "POST" });

async function addCard(sourceSystem: string | null, createdAt: Date) {
  const id: string = randomUUID();
  created.push(id);
  await prisma.$executeRaw`
    INSERT INTO "AmuxWorkItem" ("id", "title", "sourceSystem", "sourceKey", "sourceVersion",
      "sourceDigest", "sourceSnapshot", "createdAt", "updatedAt")
    VALUES (${id}, 'backfill probe', ${sourceSystem},
      ${sourceSystem === null ? null : randomUUID().replaceAll("-", "").toUpperCase()},
      ${sourceSystem === null ? null : "1"},
      ${sourceSystem === null ? null : "a".repeat(64)},
      ${sourceSystem === null ? null : JSON.stringify({ probe: true })}::jsonb,
      ${createdAt}, '2026-01-01T00:00:00Z')`;
  return id;
}

/** Other suites may add cards between preview and apply; a moved plan is refused, so look again. */
async function previewAndApply(session: Session) {
  for (let attempt = 0; ; attempt += 1) {
    const { plan, digest } = await previewAmuxCardDisplayKeyBackfill();
    try {
      return { plan, digest, result: await applyAmuxCardDisplayKeyBackfill({ session, request: request(), expectedDigest: digest }) };
    } catch (error) {
      if (attempt < 2 && error instanceof AmuxCardDisplayKeyBackfillError && error.code === "plan_changed") continue;
      throw error;
    }
  }
}

test("the apply writes the previewed numbers in creation order, audits them, and changes nothing else", async () => {
  const legacyLate = await addCard(null, new Date("2026-03-02T00:00:00Z"));
  const legacyEarly = await addCard(null, new Date("2026-03-01T00:00:00Z"));
  const intake = await addCard("codex-conversation", new Date("2026-03-03T00:00:00Z"));
  const session = owner();

  const { plan, digest, result } = await previewAndApply(session);
  const planned = new Map(plan.cards.map((item) => [item.id, item.displayKey]));
  for (const id of [legacyEarly, legacyLate, intake]) assert.ok(planned.has(id), `${id} is in the plan`);
  assert.match(planned.get(legacyEarly)!, /^AMUX-LEGACY-/);
  assert.match(planned.get(intake)!, /^AMUX-INTAKE-/);
  const number = (key: string) => Number(key.slice(key.lastIndexOf("-") + 1));
  assert.equal(number(planned.get(legacyLate)!), number(planned.get(legacyEarly)!) + 1, "creation order");

  const rows = await prisma.amuxWorkItem.findMany({ where: { id: { in: [legacyEarly, legacyLate, intake] } },
    select: { id: true, displayKey: true, updatedAt: true, revision: true, status: true } });
  for (const row of rows) {
    assert.equal(row.displayKey, planned.get(row.id), "written exactly as previewed");
    assert.equal(row.updatedAt.toISOString(), "2026-01-01T00:00:00.000Z", "updatedAt untouched");
    assert.equal(row.revision, 0);
    assert.equal(row.status, "backlog");
  }
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: result.auditId } });
  assert.equal(audit.action, AMUX_CARD_DISPLAY_BACKFILL_AUDIT_ACTION);
  assert.equal(audit.targetId, digest);
  assert.equal(audit.actorUserId, session.user!.id);
  assert.equal((audit.metadata as { cardCount: number }).cardCount, plan.cards.length);

  // Applied cards are no longer in the plan, and the same digest is refused.
  const again = await previewAmuxCardDisplayKeyBackfill();
  assert.ok(!again.plan.cards.some((item) => [legacyEarly, legacyLate, intake].includes(item.id)));
  await assert.rejects(
    applyAmuxCardDisplayKeyBackfill({ session, request: request(), expectedDigest: digest }),
    (error: unknown) => error instanceof AmuxCardDisplayKeyBackfillError &&
      (error.code === "plan_changed" || error.code === "nothing_to_apply"),
  );
});

test("a stale digest writes nothing", async () => {
  const card = await addCard(null, new Date("2026-04-01T00:00:00Z"));
  await assert.rejects(
    applyAmuxCardDisplayKeyBackfill({ session: owner(), request: request(), expectedDigest: "0".repeat(64) }),
    (error: unknown) => error instanceof AmuxCardDisplayKeyBackfillError && error.code === "plan_changed",
  );
  const row = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: card }, select: { displayKey: true } });
  assert.equal(row.displayKey, null);
});
