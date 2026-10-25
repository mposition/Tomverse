import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { commitAmuxOperatingScope, readAmuxOperatingScope } from "@/lib/amux/ideaOperatingScopeStore";
import { commitFrontierCatalogDecision } from "@/lib/amux/ideaFrontierCatalogWrite";
import { inspectFrontierCatalogWrite } from "@/lib/amux/ideaFrontierCatalogWriteCore";

// docs/policy/amux-intake.md v19 item 2: the owner's operating scope is append-only,
// one version per save, each bound to the human audit written in the same transaction.
const testUrl = process.env.TEST_DATABASE_URL?.trim();
const target = testUrl ? new URL(testUrl) : null;
if (!target || !["postgres:", "postgresql:"].includes(target.protocol) ||
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(target.pathname) || target.search || target.hash ||
  process.env.DATABASE_URL !== testUrl || (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl))
  throw new Error("REFUSE: operating scope tests require a dedicated loopback test database");

const actorUserId = `synthetic-scope-owner-${randomUUID()}`;
const email = "amux-intake-scope-owner@example.test";
process.env.ADMIN_USER_IDS = actorUserId;
process.env.ADMIN_EMAILS = email;
process.env.ADMIN_OWNER_EMAILS = email;
process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-intake-operating-scope-audit-key-2026";
const session = { user: { id: actorUserId, email, authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60_000).toISOString() } as Session;
const request = new Request("https://tomverse.test/api/admin/amux/ideas/operating-scope", { method: "POST" });
const scope = { repositories: ["mposition/tomverse-private-docs", "mposition/Tomverse"],
  model: { provider: "anthropic", modelId: "claude-opus-5-5", reasoningEffort: "high" } };
const input = (changes = {}) => ({ session, request, id: randomUUID(), expectedPreviousVersion: 0,
  scope, ownerConfirmed: true as const, ...changes });
class Rollback extends Error {}
async function rollback(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  await assert.rejects(prisma.$transaction(async (tx) => { await work(tx); throw new Rollback(); },
    { timeout: 15_000 }), Rollback);
}

before(async () => {
  assert.equal(await prisma.amuxIdeaOperatingScopeSetting.count(), 0, "use a fresh DB, not an existing operator scope");
  // The scope's model must be in the approved catalog (v19 item 2), so approve
  // exactly one synthetic selection through the real catalog writer.
  const frontier = inspectFrontierCatalogWrite(JSON.stringify({ schemaVersion: 1, action: "approve",
    approvalId: randomUUID(), provider: "anthropic", modelId: "claude-opus-5-5", allowedEfforts: ["high"],
    expectedPreviousVersion: 0, ownerConfirmedFrontierEligibility: true }));
  assert.equal(frontier.ok, true);
  if (!frontier.ok) throw new Error("synthetic frontier request invalid");
  await prisma.$transaction((tx) => commitFrontierCatalogDecision(tx, { session, request, decision: frontier.request }));
});
after(async () => { await prisma.$disconnect(); });

test("with no saved scope there is nothing to fall back to", async () => {
  assert.equal(await prisma.$transaction((tx) => readAmuxOperatingScope(tx)), null);
});

test("the audit guard compares epoch-safe xid values", async () => {
  const guard = await prisma.$queryRaw<Array<{ definition: string }>>`
    SELECT pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = current_schema()
       AND p.proname = 'amux_idea_operating_scope_setting_guard'
  `;
  assert.equal(guard.length, 1);
  assert.match(guard[0]!.definition, /a\.xmin AS audit_xid/);
  assert.match(guard[0]!.definition,
    /audit_row\.audit_xid <> pg_current_xact_id\(\)::xid/);
  assert.doesNotMatch(guard[0]!.definition,
    /(?:xmin|pg_current_xact_id\(\))::text/);
});

test("an owner save is one version and one same-transaction human audit", async () => {
  await rollback(async (tx) => {
    const saved = await commitAmuxOperatingScope(tx, input());
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.scope.repositories, ["mposition/Tomverse", "mposition/tomverse-private-docs"]);
    const read = await readAmuxOperatingScope(tx);
    assert.deepEqual(read, { version: 1, scope: saved.scope });
    const audit = await tx.adminAuditLog.findUniqueOrThrow({ where: { id: saved.auditId } });
    assert.equal(audit.action, "amux.idea.operating_scope.updated");
    assert.equal(audit.actorUserId, actorUserId);
    assert.equal(audit.targetId, saved.id);
    assert.ok(audit.entryHash);
    const second = await commitAmuxOperatingScope(tx, input({ expectedPreviousVersion: 1,
      scope: { ...scope, repositories: ["mposition/Tomverse"] } }));
    assert.equal(second.version, 2);
    assert.deepEqual((await readAmuxOperatingScope(tx))?.scope.repositories, ["mposition/Tomverse"]);
  });
  assert.equal(await prisma.amuxIdeaOperatingScopeSetting.count(), 0);
});

test("a stale version, a repeated request and a malformed scope write nothing", async () => {
  await rollback(async (tx) => {
    const first = input();
    await commitAmuxOperatingScope(tx, first);
    const auditCount = await tx.adminAuditLog.count();
    for (const [change, code] of [
      [{ expectedPreviousVersion: 0 }, "revision_changed"],
      [{ id: first.id, expectedPreviousVersion: 1 }, "request_already_seen"],
      [{ expectedPreviousVersion: 1, scope: { ...scope, repositories: ["mposition/Tomverse", "MPOSITION/tomverse"] } }, "invalid_scope"],
      [{ expectedPreviousVersion: 1, scope: { ...scope, model: { ...scope.model, provider: "xai" } } }, "invalid_scope"],
    ] as const) {
      await assert.rejects(commitAmuxOperatingScope(tx, input(change)),
        (error: unknown) => error instanceof Error && error.message === code, code);
    }
    assert.equal(await tx.adminAuditLog.count(), auditCount);
    assert.equal(await tx.amuxIdeaOperatingScopeSetting.count(), 1);
  });
});

test("a non-owner cannot save a scope", async () => {
  const ops = { ...session, user: { ...session.user, id: `synthetic-scope-ops-${randomUUID()}`,
    email: "amux-intake-scope-ops@example.test" } } as Session;
  await assert.rejects(prisma.$transaction((tx) => commitAmuxOperatingScope(tx, input({ session: ops }))),
    (error: unknown) => error instanceof Error && error.message === "forbidden");
  assert.equal(await prisma.amuxIdeaOperatingScopeSetting.count(), 0);
});

test("the database refuses a row without its audit evidence and any change to a saved row", async () => {
  await rollback(async (tx) => {
    const saved = await commitAmuxOperatingScope(tx, input());
    await tx.$executeRawUnsafe("SAVEPOINT direct_insert");
    await assert.rejects(tx.amuxIdeaOperatingScopeSetting.create({ data: { id: randomUUID(), version: 2,
      repositories: ["mposition/Tomverse"], modelProvider: "anthropic", modelId: "claude-opus-5-5",
      reasoningEffort: "high", approvedByUserId: actorUserId, approvalAuditLogId: saved.auditId } }),
    /approval evidence mismatch|Unique constraint/);
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT direct_insert");
    for (const statement of [
      `UPDATE "AmuxIdeaOperatingScopeSetting" SET "modelId" = 'other-model'`,
      `DELETE FROM "AmuxIdeaOperatingScopeSetting"`,
    ]) {
      await tx.$executeRawUnsafe("SAVEPOINT change_attempt");
      await assert.rejects(tx.$executeRawUnsafe(statement), /append only/, statement);
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT change_attempt");
    }
    await tx.$executeRawUnsafe("SAVEPOINT truncate_attempt");
    await assert.rejects(
      tx.$executeRawUnsafe(`TRUNCATE "AmuxIdeaOperatingScopeSetting"`),
      /referenced in a foreign key constraint/,
    );
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT truncate_attempt");
    await tx.$executeRawUnsafe("SAVEPOINT truncate_cascade_attempt");
    await assert.rejects(
      tx.$executeRawUnsafe(`TRUNCATE "AmuxIdeaOperatingScopeSetting" CASCADE`),
      /append only/,
    );
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT truncate_cascade_attempt");
    assert.equal((await readAmuxOperatingScope(tx))?.scope.model.modelId, "claude-opus-5-5");
  });
});

test("a model or effort outside the approved catalog is refused before any write", async () => {
  for (const model of [{ ...scope.model, modelId: "claude-unapproved-1" },
    { ...scope.model, reasoningEffort: "max" }, { ...scope.model, provider: "openai" }]) {
    const auditCount = await prisma.adminAuditLog.count();
    await assert.rejects(prisma.$transaction((tx) => commitAmuxOperatingScope(tx, input({ scope: { ...scope, model } }))),
      (error: unknown) => error instanceof Error && error.message === "model_not_approved", JSON.stringify(model));
    assert.equal(await prisma.adminAuditLog.count(), auditCount);
    assert.equal(await prisma.amuxIdeaOperatingScopeSetting.count(), 0);
  }
});
