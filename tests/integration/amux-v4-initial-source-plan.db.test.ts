import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitIdeaSubmission } from "@/lib/amux/ideaSubmissionService";
import { createInitialIdeaOnlySourcePlan, InitialSourcePlanError } from "@/lib/amux/ideaInitialSourcePlanService";
import { commitInitialIdeaSourcePlan, readInitialIdeaSourcePlan } from "@/lib/amux/ideaInitialSourcePlanAccess";
import { AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/amux/ideaIdentityCore";
import { getAdminRole } from "@/lib/adminAuth";
import { AuditWriteRefusedError, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_INITIAL_SOURCE_PLAN_SCOPE, isSystemAuditActor } from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";

const runnerTestUrl = process.env.TEST_DATABASE_URL?.trim();
const standaloneTestUrl = process.env.AMUX_V4_INITIAL_PLAN_TEST_DATABASE_URL?.trim();
const testUrl = runnerTestUrl || standaloneTestUrl;
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    (runnerTestUrl && standaloneTestUrl && runnerTestUrl !== standaloneTestUrl) ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: AMUX v4 initial source-plan test requires one dedicated loopback test database");
}

const actorUserId = `synthetic-amux-owner-${randomUUID()}`;
const actorEmail = "amux-v4-synthetic-owner@example.test";
process.env.ADMIN_USER_IDS = actorUserId;
process.env.ADMIN_EMAILS = actorEmail;
process.env.ADMIN_OWNER_EMAILS = actorEmail;
process.env.ADMIN_AUDIT_INTEGRITY_KEY = `synthetic-audit-${randomUUID()}`;
const session = {
  user: { id: actorUserId, email: actorEmail, authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
} as Session;
const request = new Request("https://tomverse.test/api/admin/amux/ideas/submissions", { method: "POST" });
const keys = {
  masterKeyId: "synthetic-master", masterKeyVersion: 1,
  masterKey: randomBytes(32), digestKeyId: "synthetic-digest", digestKey: randomBytes(32),
};

after(async () => { await prisma.$disconnect(); });

async function createIdea(input: { idea: string; repositories?: string[] }) {
  const ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSubmission(JSON.stringify({
    version: 1, requestId: randomUUID(),
    input: { version: 1, idea: input.idea,
      repositories: input.repositories ?? [], pullRequests: [] },
  }));
  if (!inspected.ok) throw new Error(inspected.code);
  await prisma.$transaction((tx) => commitIdeaSubmission(tx, {
    session, request, inspected, ideaId, keys,
  }));
  return ideaId;
}

test("operator-idea-only initial plan is bound to the owned submission and system audit", async () => {
  const text = `SYNTHETIC_PLAN_${randomUUID()}`;
  const ideaId = await createIdea({ idea: text });
  const beforeCards = await prisma.amuxWorkItem.count();
  const result = await prisma.$transaction((tx) =>
    commitInitialIdeaSourcePlan(tx, { session, request, ideaId, keys }));
  const row = await prisma.amuxIdeaSourcePlanRevision.findUniqueOrThrow({
    where: { id: result.revisionId },
  });
  const idea = await prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: ideaId } });
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: result.auditId } });
  assert.equal(isSystemAuditActor(AMUX_V4_IDEA_SYSTEM_ACTOR), true);
  assert.equal(row.ideaId, ideaId);
  assert.equal(row.actorUserId, actorUserId);
  assert.equal(row.revisionNumber, 1);
  assert.equal(row.startChunkIndex, 0);
  assert.equal(row.sourceUnitCount, 1);
  assert.equal(row.unitDigests.length, 1);
  assert.equal(row.manifestDigest, result.manifestDigest);
  assert.equal(row.state, "active");
  assert.ok(row.activatedAt);
  assert.equal(idea.currentSourcePlanRevisionId, result.revisionId);
  assert.equal(audit.action, "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED");
  assert.equal(audit.actorUserId, null);
  assert.equal((audit.metadata as Record<string, unknown>).systemActor, AMUX_V4_IDEA_SYSTEM_ACTOR);
  assert.equal((audit.metadata as Record<string, unknown>).actorScope, AMUX_V4_INITIAL_SOURCE_PLAN_SCOPE);
  assert.equal(Object.hasOwn(audit.metadata as Record<string, unknown>, "actorUserId"), false);
  assert.ok(audit.entryHash);
  assert.equal(JSON.stringify(audit.metadata).includes(text), false);
  const ownerAudit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: result.ownerAuditId },
  });
  assert.equal(ownerAudit.actorUserId, actorUserId);
  assert.equal(ownerAudit.action, "amux.v4.initial_source_plan.requested");
  assert.equal(ownerAudit.targetId, ideaId);
  assert.equal((ownerAudit.metadata as Record<string, unknown>).systemAuditId, result.auditId);
  assert.ok(ownerAudit.entryHash);
  assert.equal(await prisma.amuxWorkItem.count(), beforeCards);
  assert.deepEqual(await readInitialIdeaSourcePlan(session, ideaId),
    { ideaId, status: "committed", revisionId: result.revisionId });
  await assert.rejects(prisma.$transaction((tx) =>
    createInitialIdeaOnlySourcePlan(tx, { ideaId, actorUserId, keys })),
  (error: unknown) => error instanceof InitialSourcePlanError && error.code === "not_ready");
  assert.equal(await prisma.amuxIdeaSourcePlanRevision.count({ where: { ideaId } }), 1);
});

test("read-back reports absence and never discloses another owner's plan", async () => {
  const ideaId = await createIdea({ idea: "SYNTHETIC_READBACK_PLAN" });
  assert.deepEqual(await readInitialIdeaSourcePlan(session, ideaId),
    { ideaId, status: "absent" });
  const otherSession = { ...session, user: { ...session.user,
    id: `other-${actorUserId}` } } as Session;
  assert.equal(getAdminRole(otherSession), "owner");
  await assert.rejects(readInitialIdeaSourcePlan(otherSession, ideaId),
    (error: unknown) => error instanceof Error && error.message === "not_found");
});

test("read-back refuses a plan lacking its initiating human audit", async () => {
  const ideaId = await createIdea({ idea: "SYNTHETIC_UNTRACED_PLAN" });
  await prisma.$transaction((tx) => createInitialIdeaOnlySourcePlan(tx,
    { ideaId, actorUserId, keys }));
  assert.deepEqual(await readInitialIdeaSourcePlan(session, ideaId),
    { ideaId, status: "partial" });
});

test("the v4 actor cannot write a different action or target", async () => {
  const before = await prisma.adminAuditLog.count();
  for (const [action, targetType] of [
    ["AMUX_V4_CARD_REGISTERED", "AmuxIdeaSourcePlanRevision"],
    ["AMUX_V4_INITIAL_SOURCE_PLAN_CREATED", "AmuxWorkItem"],
  ]) {
    await assert.rejects(prisma.$transaction((tx) => writeSystemAuditLog({
      tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR, action, targetType,
      targetId: randomUUID(), summary: "synthetic refused action",
    })), (error: unknown) => error instanceof AuditWriteRefusedError);
  }
  assert.equal(await prisma.adminAuditLog.count(), before);
});

test("two initial-plan writers serialize to one revision and one creation audit", async () => {
  const ideaId = await createIdea({ idea: "SYNTHETIC_CONCURRENT_PLAN" });
  const attempts = await Promise.allSettled([1, 2].map(() =>
    prisma.$transaction((tx) => createInitialIdeaOnlySourcePlan(tx,
      { ideaId, actorUserId, keys }))));
  const successes = attempts.filter((attempt) => attempt.status === "fulfilled");
  const failures = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  const success = successes[0] as PromiseFulfilledResult<{
    revisionId: string; manifestDigest: string; auditId: string;
  }>;
  const failure = failures[0] as PromiseRejectedResult;
  assert.ok(failure.reason instanceof InitialSourcePlanError);
  assert.equal(failure.reason.code, "not_ready");
  assert.equal(await prisma.amuxIdeaSourcePlanRevision.count({ where: { ideaId } }), 1);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED",
      targetId: success.value.revisionId },
  }), 1);
});

test("unreviewed GitHub scope and mismatched owner cannot create an initial plan", async () => {
  const ideaId = await createIdea({ idea: "SYNTHETIC_GITHUB_SCOPE", repositories: ["mposition/Tomverse"] });
  const beforePlanAudits = await prisma.adminAuditLog.count({
    where: { action: "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED" },
  });
  await assert.rejects(prisma.$transaction((tx) =>
    createInitialIdeaOnlySourcePlan(tx, { ideaId, actorUserId: `other-${actorUserId}`, keys })),
  (error: unknown) => error instanceof InitialSourcePlanError && error.code === "not_found");
  await assert.rejects(prisma.$transaction((tx) =>
    createInitialIdeaOnlySourcePlan(tx, { ideaId, actorUserId, keys })),
  (error: unknown) => error instanceof InitialSourcePlanError && error.code === "external_scope_required");
  assert.equal(await prisma.amuxIdeaSourcePlanRevision.count({ where: { ideaId } }), 0);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED" },
  }), beforePlanAudits);
});

test("source-plan row, idea pointer and canonical audit roll back together", async () => {
  const ideaId = await createIdea({ idea: "SYNTHETIC_ROLLBACK_PLAN" });
  let revisionId = "";
  let ownerAuditId = "";
  await assert.rejects(prisma.$transaction(async (tx) => {
    const result = await commitInitialIdeaSourcePlan(tx, { session, request, ideaId, keys });
    revisionId = result.revisionId;
    ownerAuditId = result.ownerAuditId;
    throw new Error("synthetic rollback");
  }), (error: unknown) => error instanceof Error && error.message === "synthetic rollback");
  assert.ok(revisionId, "the source plan must have been created before rollback");
  assert.ok(ownerAuditId, "the owner audit must have been created before rollback");
  const idea = await prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: ideaId } });
  assert.equal(idea.currentSourcePlanRevisionId, null);
  assert.equal(await prisma.amuxIdeaSourcePlanRevision.count({ where: { ideaId } }), 0);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED", targetId: revisionId },
  }), 0);
  assert.equal(await prisma.adminAuditLog.count({
    where: { id: ownerAuditId, action: "amux.v4.initial_source_plan.requested", targetId: ideaId },
  }), 0);
});
