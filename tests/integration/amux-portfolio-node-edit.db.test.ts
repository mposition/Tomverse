import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

// First: the harness puts the shared client inside one rollback-only
// transaction before any service module creates the real one.
import { closeLifecycleHarness, lifecycle, queryAdapter, type LifecycleTx } from
  "./helpers/amuxLifecycleHarness";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from "./helpers/amuxV4PortfolioSeedFixture.mjs";
import { appendSyntheticAdminAudit } from "./helpers/appendSyntheticAdminAudit.mjs";

// Owner decision 2026-11-21: the owner edits an active Initiative, Epic or
// Feature from a Task card. One save is a content revision when the text
// changed, a new value assessment bound to the node's revision, and every
// open Task's score recalculated through the existing writers. The database
// accepts a content revision only in that exact shape.

const OWNER_EMAIL = "node-edit-owner@example.test";
const OTHER_EMAIL = "node-edit-ops@example.test";
process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-node-edit-audit-key-2026";
Object.assign(process.env, { NODE_ENV: "test",
  ADMIN_EMAILS: `${OWNER_EMAIL},${OTHER_EMAIL}`, ADMIN_OWNER_EMAILS: OWNER_EMAIL,
  ADMIN_OPS_EMAILS: OTHER_EMAIL });

const services = async () => ({
  ...(await import("@/lib/amux/portfolioNodeEditService")),
  ...(await import("@/lib/amux/portfolioAssessmentService")),
});
const digestKey = { digestKeyId: "synthetic", digestKey: Buffer.alloc(32, 7) };
// The node's unit key, as the key store would return it for this idea.
const loadKeys = async () => ({ masterKeyId: "synthetic-master", masterKeyVersion: 1,
  masterKey: Buffer.alloc(32, 9), digestKeyId: "synthetic", digestKey: Buffer.alloc(32, 7) });
const session = (email = OWNER_EMAIL) => ({ user: { id: `node-edit-${email}`, email,
  authenticatedAt: new Date().toISOString() },
expires: new Date(Date.now() + 3_600_000).toISOString() }) as unknown as Session;
const request = () => new Request("http://localhost/api/admin/amux/portfolio", { method: "POST" });
const STOP = new Error("node edit fixture stop");

type Ids = { initiative: string; epic: string; feature: string; task: string;
  sourceApproval: string;
  /** Each node's latest assessment as the owner's sheet would read it. */
  latest: Record<string, string> };

/** The shared seed's scored backlog Task under Initiative > Epic > Feature,
 * with the revision-0 rows a registered node carries. */
async function scoredFeature(tx: LifecycleTx, work: (ids: Ids) => Promise<void>) {
  try {
    await seedAmuxV4PortfolioRecoveryPrerequisites(queryAdapter(tx), {
      afterSourceConsumed: async ({ ids }: { ids: Omit<Ids, "latest"> }) => {
        for (const nodeId of [ids.initiative, ids.epic, ids.feature]) {
          await tx.$executeRaw`INSERT INTO "AmuxPortfolioNodeRevision"
            ("id", "nodeId", "revision", "priorRevision", "parentIdAtApproval",
             "contentDigest", "contentDigestKeyId", "decisionId",
             "authorizationAuditLogId", "approvedAt")
            SELECT ${randomUUID()}, "id", 0, NULL, "parentId", "contentDigest",
              "contentDigestKeyId", ${ids.sourceApproval}, "authorizationAuditLogId",
              CURRENT_TIMESTAMP
            FROM "AmuxPortfolioNode" WHERE "id" = ${nodeId}`;
        }
        const latest = await tx.$queryRaw<Array<{ nodeId: string; id: string }>>`
          SELECT DISTINCT ON ("nodeId") "nodeId", "id"::text AS "id" FROM "AmuxPortfolioAssessment"
          WHERE "nodeId" IN (${ids.initiative}, ${ids.epic}, ${ids.feature})
          ORDER BY "nodeId", "assessmentVersion" DESC`;
        await work({ ...ids, latest: Object.fromEntries(latest.map((row) => [row.nodeId, row.id])) });
        throw STOP;
      },
    });
  } catch (error) { if (error !== STOP) throw error; }
}

const payload = (ids: Ids, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(), requestId: randomUUID(), nodeId: ids.feature,
  expectedRevision: 0,
  expectedAssessmentId: ids.latest[(extra.nodeId as string | undefined) ?? ids.feature] ?? null,
  content: { title: "AEO-01 crawl policy", description: "Let AI search bots read public pages." },
  value: 2, uncertainty: "low" as const, reasonCode: "operator_override" as const,
  evidenceAsOf: new Date(Date.now() - 60_000).toISOString(), ...extra });

/** A refused statement, inside its own savepoint so the lifecycle goes on. */
async function refused(tx: LifecycleTx, sql: () => Promise<unknown>) {
  await tx.$executeRawUnsafe("SAVEPOINT node_edit_probe");
  try { await sql(); await tx.$executeRawUnsafe("RELEASE SAVEPOINT node_edit_probe"); return null; }
  catch (error) {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT node_edit_probe");
    return String(error);
  }
}

after(closeLifecycleHarness);

test("a saved Feature edit revises its text, records the value and recalculates the Task", async () => {
  const { previewAmuxPortfolioNodeEdit, saveAmuxPortfolioNodeEdit,
    readAmuxPortfolioNodeForEdit } = await services();
  await lifecycle(async (tx) => scoredFeature(tx, async (ids) => {
    const owner = session();
    const edit = payload(ids);
    const preview = await previewAmuxPortfolioNodeEdit(owner, edit, digestKey, { loadKeys });
    assert.equal(preview.contentChanged, true);
    assert.equal(preview.revisionAfter, 1);
    assert.equal(preview.priorValue, 5);
    assert.deepEqual(preview.tasks.map((task) => task.taskId), [ids.task]);
    // The seed's score carries Feature 5 x2 = 10; the estimate moves only that.
    const [prior] = await tx.$queryRaw<Array<{ scoreTotal: number }>>`
      SELECT "scoreTotal" FROM "AmuxPortfolioScoreSnapshot" WHERE "taskId" = ${ids.task}
      ORDER BY "computedAt" DESC LIMIT 1`;
    assert.equal(preview.tasks[0].projectedScore, prior.scoreTotal - 10 + 4);

    const saved = await saveAmuxPortfolioNodeEdit({ session: owner, request: request(),
      payload: edit, confirmationDigest: preview.confirmationDigest, digestKey,
      deps: { loadKeys } });
    assert.equal(saved.state, "saved");
    assert.equal(saved.revision, 1);
    assert.equal(saved.contentRevised, true);
    assert.deepEqual(saved.tasks.map((task) => task.state), ["scored"]);

    const [node] = await tx.$queryRaw<Array<{ revision: number; contentDigest: string;
      authorizationAuditLogId: string; approvedByUserId: string }>>`
      SELECT "revision", "contentDigest", "authorizationAuditLogId", "approvedByUserId"
      FROM "AmuxPortfolioNode" WHERE "id" = ${ids.feature}`;
    assert.equal(node.revision, 1);
    assert.notEqual(node.contentDigest, "a".repeat(64));
    assert.equal(node.approvedByUserId, owner.user!.id);
    const [revision] = await tx.$queryRaw<Array<{ priorRevision: number; decisionId: string;
      authorizationAuditLogId: string; contentDigest: string }>>`
      SELECT "priorRevision", "decisionId", "authorizationAuditLogId", "contentDigest"
      FROM "AmuxPortfolioNodeRevision" WHERE "nodeId" = ${ids.feature} AND "revision" = 1`;
    assert.deepEqual(revision, { priorRevision: 0, decisionId: ids.sourceApproval,
      authorizationAuditLogId: node.authorizationAuditLogId, contentDigest: node.contentDigest });
    const [audit] = await tx.$queryRaw<Array<{ action: string; targetId: string;
      actorUserId: string; entryHash: string | null; metadata: Record<string, unknown> }>>`
      SELECT "action", "targetId", "actorUserId", "entryHash", "metadata"
      FROM "AdminAuditLog" WHERE "id" = ${node.authorizationAuditLogId}`;
    assert.equal(audit.action, "amux.v4.portfolio.node.revise");
    assert.equal(audit.targetId, ids.feature);
    assert.match(audit.entryHash ?? "", /^[a-f0-9]{64}$/);
    // The audit keeps digests, never the text.
    assert.equal(JSON.stringify(audit.metadata).includes("crawl policy"), false);

    const [assessment] = await tx.$queryRaw<Array<{ id: string; assessmentVersion: number;
      subjectRevision: number; metrics: { value: number }; evidenceRefs: string[] }>>`
      SELECT "id", "assessmentVersion", "subjectRevision", "metrics", "evidenceRefs"
      FROM "AmuxPortfolioAssessment" WHERE "nodeId" = ${ids.feature}
      ORDER BY "assessmentVersion" DESC LIMIT 1`;
    assert.equal(assessment.id, edit.id);
    assert.equal(assessment.assessmentVersion, 2);
    assert.equal(assessment.subjectRevision, 1);
    assert.deepEqual(assessment.metrics, { value: 2 });
    assert.deepEqual(assessment.evidenceRefs, [`node:${ids.feature}:r1`]);
    const [score] = await tx.$queryRaw<Array<{ featureAssessmentId: string;
      components: { feature: number } }>>`
      SELECT "featureAssessmentId", "components" FROM "AmuxPortfolioScoreSnapshot"
      WHERE "taskId" = ${ids.task} ORDER BY "computedAt" DESC, "id" DESC LIMIT 1`;
    assert.equal(score.featureAssessmentId, edit.id);
    assert.equal(score.components.feature, 4);

    // The panel reads the new text back through the same key.
    const read = await readAmuxPortfolioNodeForEdit(owner, ids.feature, { loadKeys });
    assert.deepEqual(read.content, edit.content);
    assert.equal(read.revision, 1);
    assert.equal(read.assessment?.bound, true);
    assert.equal(read.assessment?.value, 2);
  }));
});

test("a value-only save keeps the revision and writes no content audit", async () => {
  const { previewAmuxPortfolioNodeEdit, saveAmuxPortfolioNodeEdit } = await services();
  await lifecycle(async (tx) => scoredFeature(tx, async (ids) => {
    const owner = session();
    const edit = payload(ids, { nodeId: ids.epic, content: null, value: 5 });
    const preview = await previewAmuxPortfolioNodeEdit(owner, edit, digestKey, { loadKeys });
    assert.equal(preview.contentChanged, false);
    assert.equal(preview.revisionAfter, 0);
    const saved = await saveAmuxPortfolioNodeEdit({ session: owner, request: request(),
      payload: edit, confirmationDigest: preview.confirmationDigest, digestKey });
    assert.equal(saved.revision, 0);
    assert.equal(saved.revisionAuditId, null);
    // An Epic's value reaches the Task under its Feature.
    assert.deepEqual(saved.tasks.map((task) => task.taskId), [ids.task]);
    const [score] = await tx.$queryRaw<Array<{ components: { epic: number } }>>`
      SELECT "components" FROM "AmuxPortfolioScoreSnapshot" WHERE "taskId" = ${ids.task}
      ORDER BY "computedAt" DESC, "id" DESC LIMIT 1`;
    assert.equal(score.components.epic, 15);
    const revisions = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count" FROM "AmuxPortfolioNodeRevision" WHERE "nodeId" = ${ids.epic}`;
    assert.equal(revisions[0].count, 1);
  }));
});

test("a changed field, a stale revision, a non-owner or a first-assessment reason is refused", async () => {
  const { previewAmuxPortfolioNodeEdit, saveAmuxPortfolioNodeEdit, AmuxPortfolioError } =
    await services();
  await lifecycle(async (tx) => scoredFeature(tx, async (ids) => {
    const owner = session();
    const edit = payload(ids);
    const preview = await previewAmuxPortfolioNodeEdit(owner, edit, digestKey, { loadKeys });
    const code = (expected: string) => (error: unknown) =>
      error instanceof AmuxPortfolioError && error.code === expected;
    // The digest binds every field the owner saw.
    await assert.rejects(saveAmuxPortfolioNodeEdit({ session: owner, request: request(),
      payload: { ...edit, value: 3 }, confirmationDigest: preview.confirmationDigest,
      digestKey, deps: { loadKeys } }), code("reconfirm"));
    await assert.rejects(previewAmuxPortfolioNodeEdit(owner,
      { ...edit, expectedRevision: 1 }, digestKey, { loadKeys }), code("reconfirm"));
    await assert.rejects(previewAmuxPortfolioNodeEdit(owner,
      { ...edit, reasonCode: "initial" }, digestKey, { loadKeys }), code("reconfirm"));
    await assert.rejects(previewAmuxPortfolioNodeEdit(owner,
      { ...edit, expectedAssessmentId: randomUUID() }, digestKey, { loadKeys }), code("reconfirm"));
    await assert.rejects(previewAmuxPortfolioNodeEdit(session(OTHER_EMAIL), edit,
      digestKey, { loadKeys }), code("forbidden"));
    await assert.rejects(saveAmuxPortfolioNodeEdit({ session: session(OTHER_EMAIL),
      request: request(), payload: edit, confirmationDigest: preview.confirmationDigest,
      digestKey, deps: { loadKeys } }), code("forbidden"));
    await assert.rejects(previewAmuxPortfolioNodeEdit(owner,
      { ...edit, evidenceAsOf: new Date(Date.now() + 86_400_000).toISOString() },
      digestKey, { loadKeys }), code("invalid_input"));
    // Nothing was written by the refusals.
    const [node] = await tx.$queryRaw<Array<{ revision: number }>>`
      SELECT "revision" FROM "AmuxPortfolioNode" WHERE "id" = ${ids.feature}`;
    assert.equal(node.revision, 0);
  }));
});

test("an assessment saved after the preview sends the owner back to review", async () => {
  const { previewAmuxPortfolioNodeEdit, saveAmuxPortfolioNodeEdit,
    writeAmuxPortfolioAssessmentInTx, AmuxPortfolioError } = await services();
  await lifecycle(async (tx) => scoredFeature(tx, async (ids) => {
    const owner = session();
    // Another value lands between preview and save: on the same Feature, or
    // on the Epic above it, which the Task's recalculated score also reads.
    for (const [kind, id] of [["feature", ids.feature], ["epic", ids.epic]] as const) {
      // The sheet reads the Feature's latest assessment again each time.
      const [latest] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"::text AS "id" FROM "AmuxPortfolioAssessment" WHERE "nodeId" = ${ids.feature}
        ORDER BY "assessmentVersion" DESC LIMIT 1`;
      const edit = payload(ids, { content: null, expectedAssessmentId: latest.id });
      const preview = await previewAmuxPortfolioNodeEdit(owner, edit, digestKey, { loadKeys });
      await writeAmuxPortfolioAssessmentInTx(tx, { session: owner, request: request(),
        confirmationDigest: null, digestKey, payload: { id: randomUUID(),
          requestId: randomUUID(), subject: { kind, id },
          metrics: { value: 1 }, uncertainty: "low", evidenceRefs: ["proof_0002"],
          evidenceAsOf: new Date(Date.now() - 60_000).toISOString(),
          reasonCode: "new_evidence", modelProposalDigest: null } });
      await assert.rejects(saveAmuxPortfolioNodeEdit({ session: owner, request: request(),
        payload: edit, confirmationDigest: preview.confirmationDigest, digestKey }),
      (error: unknown) => error instanceof AmuxPortfolioError && error.code === "reconfirm",
      `${kind} assessment after the preview`);
    }
  }));
});

test("of two saves previewed from the same state, only one can ever be written", async () => {
  const { previewAmuxPortfolioNodeEdit, saveAmuxPortfolioNodeEdit, AmuxPortfolioError } =
    await services();
  await lifecycle(async (tx) => scoredFeature(tx, async (ids) => {
    const owner = session();
    // A request whose outcome the sheet lost, and a fresh one the owner made
    // after reading no record: whichever arrives second is refused.
    const lost = payload(ids, { content: null, value: 1 });
    const fresh = payload(ids, { content: null, value: 3 });
    const lostPreview = await previewAmuxPortfolioNodeEdit(owner, lost, digestKey, { loadKeys });
    const freshPreview = await previewAmuxPortfolioNodeEdit(owner, fresh, digestKey, { loadKeys });
    await saveAmuxPortfolioNodeEdit({ session: owner, request: request(), payload: fresh,
      confirmationDigest: freshPreview.confirmationDigest, digestKey });
    await assert.rejects(saveAmuxPortfolioNodeEdit({ session: owner, request: request(),
      payload: lost, confirmationDigest: lostPreview.confirmationDigest, digestKey }),
    (error: unknown) => error instanceof AmuxPortfolioError && error.code === "reconfirm");
    // A sheet still showing the old read cannot even preview over the save it has not seen.
    await assert.rejects(previewAmuxPortfolioNodeEdit(owner,
      payload(ids, { content: null, value: 5 }), digestKey, { loadKeys }),
    (error: unknown) => error instanceof AmuxPortfolioError && error.code === "reconfirm");
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count" FROM "AmuxPortfolioAssessment" WHERE "nodeId" = ${ids.feature}`;
    assert.equal(rows[0].count, 2); // the seed's first, and the fresh save only
  }));
});

test("the database accepts a content revision only in the exact owner shape", async () => {
  await lifecycle(async (tx) => scoredFeature(tx, async (ids) => {
    const db = queryAdapter(tx);
    const revise = (auditId: string, revision: number, digest: string) => tx.$executeRaw`
      UPDATE "AmuxPortfolioNode" SET "revision" = ${revision},
        "titleCiphertext" = ${Buffer.from("new-title")},
        "descriptionCiphertext" = ${Buffer.from("new-description")},
        "contentDigest" = ${digest}, "approvedByUserId" = 'synthetic-owner',
        "authorizationAuditLogId" = ${auditId}
      WHERE "id" = ${ids.feature}`;
    const addRevision = (auditId: string, revision: number, digest: string,
      decisionId = ids.sourceApproval) => tx.$executeRaw`
      INSERT INTO "AmuxPortfolioNodeRevision" ("id", "nodeId", "revision", "priorRevision",
        "parentIdAtApproval", "contentDigest", "contentDigestKeyId", "decisionId",
        "authorizationAuditLogId", "approvedAt")
      VALUES (${randomUUID()}, ${ids.feature}, ${revision}, ${revision - 1}, ${ids.epic},
        ${digest}, 'synthetic', ${decisionId}, ${auditId}, CURRENT_TIMESTAMP)`;
    const audit = (action: string) => appendSyntheticAdminAudit(db, {
      actorUserId: "synthetic-owner", action, targetType: "AmuxPortfolioNode",
      targetId: ids.feature, summary: "synthetic node revision" });

    // Text changed with no revision row: closed, as before.
    assert.match(await refused(tx, () => tx.$executeRaw`
      UPDATE "AmuxPortfolioNode" SET "contentDigest" = ${"b".repeat(64)}
      WHERE "id" = ${ids.feature}`) ?? "", /revision path is closed/);
    // A revision whose audit is some other action.
    const wrongAudit = await audit("amux.v4.portfolio.assessment.approve");
    assert.match(await refused(tx, async () => {
      await addRevision(wrongAudit, 1, "b".repeat(64));
      await revise(wrongAudit, 1, "b".repeat(64));
    }) ?? "", /revision path is closed/);
    // A revision that skips a number, or moves the content key scope.
    const right = await audit("amux.v4.portfolio.node.revise");
    assert.match(await refused(tx, async () => {
      await addRevision(right, 2, "b".repeat(64));
      await revise(right, 2, "b".repeat(64));
    }) ?? "", /revision path is closed/);
    assert.match(await refused(tx, async () => {
      await addRevision(right, 1, "b".repeat(64), randomUUID());
      await revise(right, 1, "b".repeat(64));
    }) ?? "", /revision path is closed/);
    // A digest the revision row does not carry.
    assert.match(await refused(tx, async () => {
      await addRevision(right, 1, "b".repeat(64));
      await revise(right, 1, "c".repeat(64));
    }) ?? "", /revision path is closed/);
    // The exact shape passes; identity stays closed even then.
    assert.equal(await refused(tx, async () => {
      await addRevision(right, 1, "b".repeat(64));
      await revise(right, 1, "b".repeat(64));
    }), null);
    assert.match(await refused(tx, () => tx.$executeRaw`
      UPDATE "AmuxPortfolioNode" SET "parentId" = NULL WHERE "id" = ${ids.feature}`) ?? "",
    /revision path is closed/);
  }));
});

// Owner decision 2026-11-22: ideas that split one goal (AEO-01, AEO-02) are
// brought under one hierarchy by moving a node under another parent. A move
// is a node revision in the same owner shape; cards stay with their Feature.
async function secondEpic(tx: LifecycleTx, ids: Ids) {
  const epic = randomUUID();
  await tx.$executeRaw`INSERT INTO "AmuxPortfolioNode"
    ("id", "level", "parentId", "state", "revision", "titleCiphertext",
     "descriptionCiphertext", "contentKeyId", "contentKeyVersion", "contentDigest",
     "contentDigestKeyId", "approvedByUserId", "authorizationAuditLogId", "updatedAt")
    VALUES (${epic}, 'epic', ${ids.initiative}, 'active', 0, ${Buffer.from("x")},
      ${Buffer.from("y")}, 'synthetic', 1, ${"d".repeat(64)}, 'synthetic',
      'synthetic-owner', ${randomUUID()}, CURRENT_TIMESTAMP)`;
  await tx.$executeRaw`INSERT INTO "AmuxPortfolioNodeRevision"
    ("id", "nodeId", "revision", "priorRevision", "parentIdAtApproval",
     "contentDigest", "contentDigestKeyId", "decisionId", "authorizationAuditLogId", "approvedAt")
    SELECT ${randomUUID()}, "id", 0, NULL, "parentId", "contentDigest", "contentDigestKeyId",
      ${ids.sourceApproval}, "authorizationAuditLogId", CURRENT_TIMESTAMP
    FROM "AmuxPortfolioNode" WHERE "id" = ${epic}`;
  const assessmentId = randomUUID();
  const auditId = await appendSyntheticAdminAudit(queryAdapter(tx), {
    actorUserId: "synthetic-owner", action: "amux.v4.portfolio.assessment.approve",
    targetType: "AmuxPortfolioAssessment", targetId: assessmentId,
    summary: "synthetic assessment" });
  await tx.$executeRaw`INSERT INTO "AmuxPortfolioAssessment"
    ("id", "requestId", "nodeId", "subjectKind", "subjectRevision", "subjectDigest",
     "subjectDigestKeyId", "assessmentVersion", "metrics", "uncertainty", "evidenceRefs",
     "evidenceAsOf", "reasonCode", "confirmationDigest", "confirmationDigestKeyId",
     "approvedByUserId", "approvalAuditLogId", "approvedAt")
    VALUES (${assessmentId}, ${randomUUID()}, ${epic}, 'epic', 0, ${"d".repeat(64)},
      'synthetic', 1, '{"value": 1}'::jsonb, 'low', '["proof_0001"]'::jsonb,
      CURRENT_TIMESTAMP - INTERVAL '1 day', 'initial', ${"c".repeat(64)}, 'synthetic',
      'synthetic-owner', ${auditId}, CURRENT_TIMESTAMP)`;
  return epic;
}

test("a Feature moves under another Epic as one owner revision, with its Task rescored", async () => {
  const { previewAmuxPortfolioNodeEdit, saveAmuxPortfolioNodeEdit,
    readAmuxPortfolioNodeForEdit } = await services();
  await lifecycle(async (tx) => scoredFeature(tx, async (ids) => {
    const owner = session();
    const target = await secondEpic(tx, ids);
    // A text revision first, as every real node has its description sealed.
    const first = payload(ids);
    const firstPreview = await previewAmuxPortfolioNodeEdit(owner, first, digestKey, { loadKeys });
    await saveAmuxPortfolioNodeEdit({ session: owner, request: request(), payload: first,
      confirmationDigest: firstPreview.confirmationDigest, digestKey, deps: { loadKeys } });

    // The sheet offers the active Epics, with the current one selected.
    const read = await readAmuxPortfolioNodeForEdit(owner, ids.feature, { loadKeys });
    assert.equal(read.parentId, ids.epic);
    assert.deepEqual(read.parentOptions.map((option) => option.id).sort(), [ids.epic, target].sort());

    const move = payload(ids, { expectedRevision: 1, expectedAssessmentId: first.id,
      content: null, parentId: target });
    const preview = await previewAmuxPortfolioNodeEdit(owner, move, digestKey, { loadKeys });
    assert.equal(preview.parentChanged, true);
    assert.equal(preview.contentChanged, false);
    assert.equal(preview.revisionAfter, 2);
    assert.deepEqual(preview.tasks.map((task) => task.taskId), [ids.task]);
    const saved = await saveAmuxPortfolioNodeEdit({ session: owner, request: request(),
      payload: move, confirmationDigest: preview.confirmationDigest, digestKey,
      deps: { loadKeys } });
    assert.equal(saved.moved, true);
    assert.equal(saved.contentRevised, false);
    assert.equal(saved.revision, 2);
    assert.deepEqual(saved.tasks.map((task) => task.state), ["scored"]);

    const [node] = await tx.$queryRaw<Array<{ parentId: string; revision: number;
      authorizationAuditLogId: string }>>`
      SELECT "parentId", "revision", "authorizationAuditLogId" FROM "AmuxPortfolioNode"
      WHERE "id" = ${ids.feature}`;
    assert.deepEqual({ parentId: node.parentId, revision: node.revision },
      { parentId: target, revision: 2 });
    const [revision] = await tx.$queryRaw<Array<{ parentIdAtApproval: string }>>`
      SELECT "parentIdAtApproval" FROM "AmuxPortfolioNodeRevision"
      WHERE "nodeId" = ${ids.feature} AND "revision" = 2`;
    assert.equal(revision.parentIdAtApproval, target);
    const [audit] = await tx.$queryRaw<Array<{ action: string; metadata: Record<string, unknown> }>>`
      SELECT "action", "metadata" FROM "AdminAuditLog" WHERE "id" = ${node.authorizationAuditLogId}`;
    assert.equal(audit.action, "amux.v4.portfolio.node.revise");
    assert.equal(audit.metadata.priorParentId, ids.epic);
    assert.equal(audit.metadata.parentId, target);
    // The card stays with its Feature; its score now reads the new Epic.
    const [card] = await tx.$queryRaw<Array<{ parentFeatureNodeId: string }>>`
      SELECT "parentFeatureNodeId" FROM "AmuxWorkItem" WHERE "id" = ${ids.task}`;
    assert.equal(card.parentFeatureNodeId, ids.feature);
    const [score] = await tx.$queryRaw<Array<{ epicAssessmentId: string; components: { epic: number } }>>`
      SELECT "epicAssessmentId"::text AS "epicAssessmentId", "components"
      FROM "AmuxPortfolioScoreSnapshot" WHERE "taskId" = ${ids.task}
      ORDER BY "computedAt" DESC, "id" DESC LIMIT 1`;
    const [targetAssessment] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"::text AS "id" FROM "AmuxPortfolioAssessment" WHERE "nodeId" = ${target}`;
    assert.equal(score.epicAssessmentId, targetAssessment.id);
    assert.equal(score.components.epic, 3);

    // The emptied Epic can now be archived by the existing clean-up.
    const [children] = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS "count" FROM "AmuxPortfolioNode"
      WHERE "parentId" = ${ids.epic} AND "state" = 'active'`;
    assert.equal(children.count, 0);
  }));
});

test("a move to a node of the wrong level, an Initiative move or a bare parent update is refused", async () => {
  const { previewAmuxPortfolioNodeEdit } = await services();
  await lifecycle(async (tx) => scoredFeature(tx, async (ids) => {
    const owner = session();
    const target = await secondEpic(tx, ids);
    // A Feature under an Initiative, and an Initiative under anything.
    await assert.rejects(previewAmuxPortfolioNodeEdit(owner,
      payload(ids, { parentId: ids.initiative }), digestKey, { loadKeys }), { code: "invalid_input" });
    await assert.rejects(previewAmuxPortfolioNodeEdit(owner,
      payload(ids, { nodeId: ids.initiative, parentId: target }), digestKey, { loadKeys }),
    { code: "invalid_input" });
    // The database refuses any parent change outside the owner revision shape.
    const bare = await refused(tx, () => tx.$executeRaw`
      UPDATE "AmuxPortfolioNode" SET "parentId" = ${target} WHERE "id" = ${ids.feature}`);
    assert.match(bare ?? "", /portfolio content and identity revision path is closed/);
    const initiative = await refused(tx, () => tx.$executeRaw`
      UPDATE "AmuxPortfolioNode" SET "parentId" = ${target} WHERE "id" = ${ids.initiative}`);
    assert.match(initiative ?? "", /closed|initiative/);
  }));
});
