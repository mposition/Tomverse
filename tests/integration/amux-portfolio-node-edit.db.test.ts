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
  sourceApproval: string };

/** The shared seed's scored backlog Task under Initiative > Epic > Feature,
 * with the revision-0 rows a registered node carries. */
async function scoredFeature(tx: LifecycleTx, work: (ids: Ids) => Promise<void>) {
  try {
    await seedAmuxV4PortfolioRecoveryPrerequisites(queryAdapter(tx), {
      afterSourceConsumed: async ({ ids }: { ids: Ids }) => {
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
        await work(ids);
        throw STOP;
      },
    });
  } catch (error) { if (error !== STOP) throw error; }
}

const payload = (ids: Ids, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(), requestId: randomUUID(), nodeId: ids.feature,
  expectedRevision: 0,
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
      const edit = payload(ids, { content: null });
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
