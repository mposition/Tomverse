import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const databaseUrl = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl) return false;
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return ["localhost", "127.0.0.1"].includes(url.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(name);
})();

test("uncertain v4 unit consumption freezes one receipt until owner no-commit confirmation", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.ADMIN_USER_IDS = "synthetic-owner";
  process.env.ADMIN_EMAILS = "synthetic-owner@example.test";
  process.env.ADMIN_OWNER_EMAILS = "synthetic-owner@example.test";
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-v4-unit-unknown-service-key";
  const [{ prisma }, { takeAuditChainLock, writeAdminAuditLog }, store] =
    await Promise.all([
      import("../../lib/prisma.ts"),
      import("../../lib/adminAudit.ts"),
      import("../../lib/amux/ideaUnitDecisionStore.ts"),
    ]);
  const session = { user: { id: "synthetic-owner",
    email: "synthetic-owner@example.test",
    authenticatedAt: new Date().toISOString() } };
  const request = new Request("http://localhost/api/admin/amux/ideas/unit-decisions/no-commit", {
    method: "POST", headers: { "content-type": "application/json" },
  });
  const ids = { idea: randomUUID(), unit: randomUUID(), preview: randomUUID(),
    decision: randomUUID(), prepare: randomUUID(), consume: randomUUID() };
  const digest = "a".repeat(64);

  try {
    await prisma.$transaction(async (tx) => {
      await takeAuditChainLock(tx);
      await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
      await tx.$executeRaw`INSERT INTO public."AmuxIdeaSubmission"
        ("id", "requestId", "actorUserId", "state", "submittedAt",
         "analysisDeadlineAt", "updatedAt")
        VALUES (${ids.idea}, ${randomUUID()}, 'synthetic-owner',
          'submitted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '7 days',
          CURRENT_TIMESTAMP)`;
      await tx.$executeRaw`INSERT INTO public."AmuxIdeaAnalysisChunk"
        ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
         "leaseGeneration", "analysisCompletedAt", "updatedAt")
        VALUES (${ids.idea}, 'synthetic-owner', 0, 'draft_ready', 0, 0,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
      await tx.$executeRaw`INSERT INTO public."AmuxIdeaTransferPreview"
        ("id", "ideaId", "chunkIndex", "attempt", "state", "modelId",
         "templateVersion", "payloadDigest", "payloadDigestKeyId",
         "expiresAt", "confirmedAt", "confirmExpiresAt",
         "confirmedByUserId", "confirmationAuditLogId", "updatedAt")
        VALUES (${ids.preview}, ${ids.idea}, 0, 99, 'completed',
          'synthetic-model', 'synthetic-template', ${digest}, 'synthetic',
          CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP + INTERVAL '15 minutes', 'synthetic-owner',
          ${randomUUID()}, CURRENT_TIMESTAMP)`;
      await tx.$executeRaw`UPDATE public."AmuxIdeaAnalysisChunk"
        SET "currentPreviewId" = ${ids.preview}
        WHERE "ideaId" = ${ids.idea} AND "chunkIndex" = 0`;
      await tx.$executeRaw`INSERT INTO public."AmuxIdeaDraftUnit"
        ("id", "ideaId", "actorUserId", "chunkIndex", "unitIndex",
         "localRef", "unitKind", "state", "bodyCiphertext", "bodyKeyId",
         "bodyKeyVersion", "bodyDigest", "bodyDigestKeyId", "updatedAt")
        VALUES (${ids.unit}, ${ids.idea}, 'synthetic-owner', 0, 99,
          'c0:card-99', 'card', 'proposed', ${Buffer.from("synthetic-only")},
          'synthetic', 1, ${digest}, 'synthetic', CURRENT_TIMESTAMP)`;
      const prepareAuditId = await writeAdminAuditLog({ tx, session,
        request, action: "amux.v4.unit.prepare",
        targetType: "AmuxIdeaUnitDecision", targetId: ids.decision,
        summary: "Synthetic v4 unit prepared for an unknown-outcome test.",
      });
      await tx.$executeRaw`INSERT INTO public."AmuxIdeaUnitDecision"
        ("id", "ideaId", "draftUnitId", "actorUserId", "chunkIndex",
         "prepareRequestId", "action", "state", "ownerSessionDigest",
         "ownerSessionDigestKeyId", "unitDigest", "unitDigestKeyId",
         "confirmationDigest", "confirmationDigestKeyId", "sourcePreviewId",
         "sourcePreviewDigest", "sourcePreviewDigestKeyId", "preparedAt",
         "expiresAt", "prepareAuditLogId", "updatedAt")
        VALUES (${ids.decision}, ${ids.idea}, ${ids.unit}, 'synthetic-owner', 0,
          ${ids.prepare}::uuid, 'reject_unit', 'prepared', ${"c".repeat(64)},
          'synthetic', ${digest}, 'synthetic', ${"d".repeat(64)}, 'synthetic',
          ${ids.preview}, ${digest}, 'synthetic', CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP + INTERVAL '15 minutes', ${prepareAuditId},
          CURRENT_TIMESTAMP)`;
    });
    const competingMarkers = await Promise.all([
      store.markAmuxV4UnitConsumeOutcomeUnknown({ session,
        decisionId: ids.decision, consumeRequestId: ids.consume }),
      store.markAmuxV4UnitConsumeOutcomeUnknown({ session,
        decisionId: ids.decision, consumeRequestId: ids.consume }),
    ]);
    assert.deepEqual(competingMarkers.sort(), ["already_unknown", "recorded"]);
    assert.equal(await store.markAmuxV4UnitConsumeOutcomeUnknown({ session,
      decisionId: ids.decision, consumeRequestId: ids.consume }), "already_unknown");
    const unknown = await store.readAmuxV4UnitDecision(session,
      { decisionId: ids.decision });
    assert.equal(unknown.state, "outcome_unknown");
    assert.equal(unknown.retryWrite, false);
    assert.equal(unknown.consumeRequestId, ids.consume);
    await assert.rejects(store.confirmAmuxV4UnitNoCommit({ session, request,
      decisionId: ids.decision, consumeRequestId: randomUUID(),
      confirmation: "no_commit" }), (error) => error.code === "reconfirm");
    const resolved = await store.confirmAmuxV4UnitNoCommit({ session, request,
      decisionId: ids.decision, consumeRequestId: ids.consume,
      confirmation: "no_commit" });
    assert.equal(resolved.state, "invalidated");
    assert.equal((await store.readAmuxV4UnitDecision(session,
      { decisionId: ids.decision })).state, "invalidated");
    await assert.rejects(store.confirmAmuxV4UnitNoCommit({ session, request,
      decisionId: ids.decision, consumeRequestId: ids.consume,
      confirmation: "no_commit" }), (error) => error.code === "reconfirm");
    assert.equal(await store.markAmuxV4UnitConsumeOutcomeUnknown({ session,
      decisionId: ids.decision, consumeRequestId: ids.consume }), "unavailable");
    const audit = await prisma.adminAuditLog.findMany({ where: {
      targetType: "AmuxIdeaUnitDecision", targetId: ids.decision },
      select: { action: true },
    });
    assert.deepEqual(audit.map((entry) => entry.action).sort(), [
      "amux.v4.unit.invalidate", "amux.v4.unit.no_commit_confirmed",
      "amux.v4.unit.outcome_unknown", "amux.v4.unit.prepare",
    ]);
  } finally {
    await prisma.$disconnect();
  }
});
