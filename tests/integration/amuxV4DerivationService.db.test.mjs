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

test("owner split and merge preserve originals and append complete audited lineage", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.ADMIN_USER_IDS = "synthetic-owner";
  process.env.ADMIN_EMAILS = "synthetic-owner@example.test";
  process.env.ADMIN_OWNER_EMAILS = "synthetic-owner@example.test";
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-v4-derivation-audit-key";
  const [{ prisma }, { sealAmuxContent }, { amuxCanonicalJson }, service] =
    await Promise.all([
      import("../../lib/prisma.ts"),
      import("../../lib/amux/ideaCrypto.ts"),
      import("../../lib/amux/boardImportCore.ts"),
      import("../../lib/amux/ideaDerivationService.ts"),
    ]);
  const session = { user: { id: "synthetic-owner",
    email: "synthetic-owner@example.test",
    authenticatedAt: new Date().toISOString() } };
  const request = new Request("http://localhost/api/admin/amux/ideas/derivations/approve", {
    method: "POST", headers: { "content-type": "application/json" },
  });
  const keys = { masterKeyId: "synthetic-master", masterKeyVersion: 1,
    masterKey: Buffer.alloc(32, 3), digestKeyId: "synthetic-digest",
    digestKey: Buffer.alloc(32, 7) };
  const ideaId = randomUUID();
  const sourceIds = [randomUUID(), randomUUID()];
  const sourceCard = (index) => ({ kind: "card", localId: `c0:card-${index}`,
    cardType: "story", storyKind: "general", title: `Original ${index}`,
    problem: "Original problem", scopeIn: ["Original scope"], scopeOut: [],
    completionCriteria: ["Original done"], featureRef: "c0:node-0",
    parentStoryRef: null, dependencyRefs: [], duplicateCandidateRefs: [],
    taskRole: null, executionGrade: null, executionBrief: null,
    sourceRefIds: ["operator_idea"] });
  const authored = (title) => ({ cardType: "story", storyKind: "general",
    title, problem: "Owner-authored problem", scopeIn: ["Owner scope"],
    scopeOut: [], completionCriteria: ["Owner done"],
    featureRef: "c0:node-0", parentStoryRef: null, dependencyRefs: [],
    duplicateCandidateRefs: [], taskRole: null, executionGrade: null,
    executionBrief: null });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
      await tx.$executeRaw`INSERT INTO public."AmuxIdeaSubmission"
        ("id", "requestId", "actorUserId", "state", "submittedAt",
         "analysisDeadlineAt", "updatedAt")
        VALUES (${ideaId}, ${randomUUID()}, 'synthetic-owner',
          'analyzing', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '7 days',
          CURRENT_TIMESTAMP)`;
      await tx.$executeRaw`INSERT INTO public."AmuxIdeaAnalysisChunk"
        ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
         "leaseGeneration", "analysisCompletedAt", "updatedAt")
        VALUES (${ideaId}, 'synthetic-owner', 0, 'draft_ready', 0, 0,
          CURRENT_TIMESTAMP - INTERVAL '1 day', CURRENT_TIMESTAMP)`;
      for (let index = 0; index < sourceIds.length; index += 1) {
        const sourceId = sourceIds[index];
        const sealed = sealAmuxContent(Buffer.from(amuxCanonicalJson(sourceCard(index))),
          "analysis_draft", sourceId, keys);
        await tx.amuxIdeaDraftUnit.create({ data: {
          id: sourceId, ideaId, actorUserId: "synthetic-owner",
          chunkIndex: 0, unitIndex: index, localRef: `c0:card-${index}`,
          unitKind: "card", state: "proposed",
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
          bodyCiphertext: Uint8Array.from(sealed.ciphertext),
          bodyKeyId: sealed.keyId, bodyKeyVersion: sealed.keyVersion,
          bodyDigest: sealed.digest, bodyDigestKeyId: sealed.digestKeyId,
        } });
      }
    });
    const originalRows = await prisma.amuxIdeaDraftUnit.findMany({
      where: { id: { in: sourceIds } }, select: { id: true,
        state: true, bodyDigest: true }, orderBy: { id: "asc" },
    });
    const split = { ideaId, groupId: randomUUID(), requestId: randomUUID(),
      operation: "split", sourceUnitIds: [sourceIds[0]],
      targetUnitIds: [randomUUID(), randomUUID()],
      cards: [authored("Derived alpha"), authored("Derived beta")],
      reason: "Separate two independently verifiable outcomes" };
    const preview = await service.previewAmuxV4Derivation(session, split, keys);
    assert.equal(preview.targets.length, 2);
    const approved = await service.commitAmuxV4Derivation({ session, request,
      payload: split, confirmationDigest: preview.confirmationDigest, keys });
    assert.equal(approved.state, "approved");
    assert.equal((await service.readAmuxV4Derivation(session,
      split.requestId)).state, "approved");
    await assert.rejects(service.previewAmuxV4Derivation(session, {
      ...split, groupId: randomUUID(), requestId: randomUUID(),
      targetUnitIds: [randomUUID(), randomUUID()],
    }, keys), /not_ready/);
    assert.equal(await prisma.amuxWorkItem.count({ where: {
      sourceKey: { in: split.targetUnitIds.map((id) => id.toUpperCase()) },
    } }), 0);
    assert.equal(await prisma.amuxIdeaUnitDecision.count({ where: {
      draftUnitId: { in: split.targetUnitIds },
    } }), 0);
    await assert.rejects(prisma.$executeRaw`
      INSERT INTO public."AmuxIdeaUnitDecision" ("id", "draftUnitId")
      VALUES (${randomUUID()}, ${sourceIds[0]})`,
    /derivation source cannot receive another decision/);
    const splitAudit = await prisma.adminAuditLog.findFirst({ where: {
      action: "amux.v4.derivation.approve", targetId: split.groupId,
    }, select: { entryHash: true, metadata: true } });
    assert.equal(typeof splitAudit?.entryHash, "string");
    assert.equal(JSON.stringify(splitAudit?.metadata).includes("Derived alpha"), false);
    assert.equal(JSON.stringify(splitAudit?.metadata).includes(split.reason), false);
    const merge = { ideaId, groupId: randomUUID(), requestId: randomUUID(),
      operation: "merge", sourceUnitIds: split.targetUnitIds,
      targetUnitIds: [randomUUID()], cards: [authored("Merged outcome")],
      reason: "One independent acceptance criterion covers both originals" };
    const mergePreview = await service.previewAmuxV4Derivation(session, merge, keys);
    assert.equal((await service.commitAmuxV4Derivation({ session, request,
      payload: merge, confirmationDigest: mergePreview.confirmationDigest,
      keys })).state, "approved");
    assert.equal(await prisma.amuxIdeaDerivationEdge.count({ where: {
      groupId: merge.groupId,
    } }), 2);
    await assert.rejects(prisma.amuxIdeaDerivationEdge.create({ data: {
      id: randomUUID(), groupId: split.groupId,
      sourceUnitId: sourceIds[1], targetUnitId: split.targetUnitIds[0],
    } }), /derivation group missing a complete edge set/);
    assert.deepEqual(await prisma.amuxIdeaDraftUnit.findMany({
      where: { id: { in: sourceIds } }, select: { id: true,
        state: true, bodyDigest: true }, orderBy: { id: "asc" },
    }), originalRows);
    await assert.rejects(prisma.amuxIdeaDerivationEdge.deleteMany({ where: {
      groupId: split.groupId,
    } }), /derivation edge is immutable/);
    await assert.rejects(prisma.amuxIdeaDerivationGroup.delete({ where: {
      id: split.groupId,
    } }), /derivation group is immutable/);
    await prisma.$executeRaw`INSERT INTO public."AmuxIdeaAnalysisChunk"
      ("ideaId", "actorUserId", "chunkIndex", "state", "attempt",
       "leaseGeneration", "analysisCompletedAt", "updatedAt")
      VALUES (${ideaId}, 'synthetic-owner', 1, 'draft_ready', 0, 0,
        clock_timestamp() AT TIME ZONE 'UTC', CURRENT_TIMESTAMP)`;
    const laterId = randomUUID();
    const laterSealed = sealAmuxContent(Buffer.from(amuxCanonicalJson({
      ...sourceCard(0), localId: "c1:card-0",
    })), "analysis_draft", laterId, keys);
    await prisma.amuxIdeaDraftUnit.create({ data: {
      id: laterId, ideaId, actorUserId: "synthetic-owner",
      chunkIndex: 1, unitIndex: 0, localRef: "c1:card-0",
      unitKind: "card", state: "proposed",
      expiresAt: new Date(Date.now() + 60 * 86_400_000),
      bodyCiphertext: Uint8Array.from(laterSealed.ciphertext),
      bodyKeyId: laterSealed.keyId, bodyKeyVersion: laterSealed.keyVersion,
      bodyDigest: laterSealed.digest,
      bodyDigestKeyId: laterSealed.digestKeyId,
    } });
    const clocks = await prisma.$queryRaw`
      SELECT later."expiresAt" = first."analysisCompletedAt" + INTERVAL '30 days'
        AS "firstClock" FROM public."AmuxIdeaDraftUnit" later
        JOIN public."AmuxIdeaAnalysisChunk" first ON first."ideaId" = later."ideaId"
          AND first."chunkIndex" = 0 WHERE later."id" = ${laterId}`;
    assert.equal(clocks[0]?.firstClock, true);
  } finally { await prisma.$disconnect(); }
});
