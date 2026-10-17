import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Session } from "next-auth";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import {
  AMUX_V19_TRACKED_CHECKOUT_AUDIT_ACTOR,
  AMUX_V19_TRACKED_CHECKOUT_AUDIT_SUMMARY,
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_ACTION,
  AMUX_V19_TRACKED_CHECKOUT_RECORDED_TARGET,
  amuxTrackedCheckoutEvidenceAuditMetadata,
  inspectAmuxTrackedCheckoutEvidence,
} from "@/lib/amux/ideaTrackedCheckoutEvidenceCore";
import {
  AmuxTrackedCheckoutEvidenceError,
  readAmuxTrackedCheckoutEvidence,
  recordAmuxTrackedCheckoutEvidence,
} from "@/lib/amux/ideaTrackedCheckoutEvidenceStore";
import { readAmuxIdeaProgressInTx } from "@/lib/amux/ideaProgressRead";
import { commitFrontierCatalogDecision } from "@/lib/amux/ideaFrontierCatalogWrite";
import { inspectFrontierCatalogWrite } from "@/lib/amux/ideaFrontierCatalogWriteCore";
import { amuxContentUnitKeyId } from "@/lib/amux/ideaKeyStore";
import {
  commitAmuxOperatingScope,
  readAmuxOperatingScopeAuthority,
  type AmuxOperatingScopeAuthority,
} from "@/lib/amux/ideaOperatingScopeStore";
import {
  commitAmuxIdeaSessionSubmission,
} from "@/lib/amux/ideaSessionSubmissionService";
import {
  inspectAmuxIdeaSessionSubmission,
} from "@/lib/amux/ideaSessionSubmissionCore";
import { prisma } from "@/lib/prisma";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: tracked checkout evidence test requires a dedicated loopback test database");
}

const operatorId = "synthetic-checkout-owner-" + randomUUID();
const operatorEmail = "amux-checkout-owner@example.test";
process.env.ADMIN_USER_IDS = operatorId;
process.env.ADMIN_EMAILS = operatorEmail;
process.env.ADMIN_OWNER_EMAILS = operatorEmail;
process.env.ADMIN_AUDIT_INTEGRITY_KEY =
  "synthetic-amux-intake-operating-scope-audit-key-2026";
const session = {
  user: { id: operatorId, email: operatorEmail,
    authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60_000).toISOString(),
} as Session;
const request = new Request("https://tomverse.test/internal/amux/checkout-evidence", {
  method: "POST",
});
const masterKey = randomBytes(32);
const digestKey = randomBytes(32);
const keysFor = (ideaId: string) => ({
  masterKeyId: amuxContentUnitKeyId({ ideaId, purpose: "idea_raw", subjectId: ideaId }),
  masterKeyVersion: 1,
  masterKey,
  digestKeyId: "synthetic-checkout-idea-digest",
  digestKey,
});
const evidenceInput = (ideaId: string, referenceOrdinal = 0) => ({
  ideaId,
  referenceOrdinal,
  pinnedCommitSha: "a".repeat(40),
  excludedCount: 4,
  excludedPathDigest: "b".repeat(64),
  excludedPathDigestKeyId: "synthetic-checkout-path-digest-v1",
  excludedReasons: {
    secret_path: 1,
    secret_content: 1,
    non_regular: 1,
    unscannable_content: 1,
  },
});

let authority: AmuxOperatingScopeAuthority;
let ideaId: string;

before(async () => {
  const existing = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
  if (existing) {
    authority = existing;
  } else {
    const modelId = "synthetic-checkout-model-" + randomUUID();
    const frontier = inspectFrontierCatalogWrite(JSON.stringify({
      schemaVersion: 1,
      action: "approve",
      approvalId: randomUUID(),
      provider: "openai",
      modelId,
      allowedEfforts: ["high"],
      expectedPreviousVersion: 0,
      ownerConfirmedFrontierEligibility: true,
    }));
    if (!frontier.ok) throw new Error("Synthetic Frontier input rejected");
    await prisma.$transaction((tx) => commitFrontierCatalogDecision(tx, {
      session, request, decision: frontier.request,
    }));
    await prisma.$transaction((tx) => commitAmuxOperatingScope(tx, {
      session,
      request,
      id: randomUUID(),
      expectedPreviousVersion: 0,
      scope: {
        repositories: ["mposition/Tomverse"],
        model: { provider: "openai", modelId, reasoningEffort: "high" },
      },
      ownerConfirmed: true,
    }));
    const created = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx));
    if (!created) throw new Error("Synthetic operating scope was not stored");
    authority = created;
  }

  const repository = authority.scope.repositories[0];
  if (!repository) throw new Error("Synthetic operating scope has no repository");
  ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSessionSubmission({
    version: 1,
    requestId: randomUUID(),
    input: { version: 1, idea: "Synthetic checkout evidence idea",
      repositories: [repository], pullRequests: [{ repository, number: 1 }] },
    source: { toolName: "Codex", modelProvider: "OpenAI",
      sessionDisplay: "AMUX v19 tracked checkout DB test" },
  });
  if (!inspected.ok) throw new Error("Synthetic session input rejected");
  await prisma.$transaction((tx) => commitAmuxIdeaSessionSubmission(tx, {
    inspected,
    expectedAuthority: authority,
    ideaId,
    keys: keysFor(ideaId),
  }));
});

after(async () => {
  masterKey.fill(0);
  digestKey.fill(0);
  await prisma.$disconnect();
});

test("pinned checkout evidence and its canonical system audit commit atomically", async () => {
  const stored = await prisma.$transaction((tx) =>
    recordAmuxTrackedCheckoutEvidence(tx, evidenceInput(ideaId)));
  assert.equal(stored.ideaId, ideaId);
  assert.equal(stored.referenceOrdinal, 0);
  assert.equal(stored.pinnedCommitSha, "a".repeat(40));
  assert.deepEqual(stored.excludedReasons, {
    secret_path: 1,
    secret_content: 1,
    non_regular: 1,
    unscannable_content: 1,
  });

  const [readBack, audit] = await prisma.$transaction(async (tx) => Promise.all([
    readAmuxTrackedCheckoutEvidence(tx, ideaId, 0),
    tx.adminAuditLog.findUniqueOrThrow({ where: { id: stored.auditLogId } }),
  ]));
  assert.deepEqual(readBack, stored);
  assert.equal(audit.actorUserId, null);
  assert.equal(audit.action, AMUX_V19_TRACKED_CHECKOUT_RECORDED_ACTION);
  assert.equal(audit.targetType, AMUX_V19_TRACKED_CHECKOUT_RECORDED_TARGET);
  assert.equal(audit.targetId, stored.evidenceId);
  assert.equal(JSON.stringify(audit.metadata).includes(".env"), false);
  assert.equal(JSON.stringify(audit.metadata).includes("/tmp"), false);

  const progress = await prisma.$transaction((tx) =>
    readAmuxIdeaProgressInTx(tx, authority.approvedByUserId, new Date()));
  assert.deepEqual(progress.find((row) => row.ideaId === ideaId)?.checkoutEvidence,
    [{ referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40), excludedCount: 4,
      excludedReasons: { secretPath: 1, secretContent: 1,
        nonRegular: 1, unscannableContent: 1 } }]);
});

test("duplicate or out-of-range reference evidence leaves no extra audit", async () => {
  const auditCount = await prisma.adminAuditLog.count();
  await assert.rejects(prisma.$transaction((tx) =>
    recordAmuxTrackedCheckoutEvidence(tx, evidenceInput(ideaId))),
  (error: unknown) => error instanceof AmuxTrackedCheckoutEvidenceError &&
    error.code === "already_recorded");
  assert.equal(await prisma.adminAuditLog.count(), auditCount);

  await assert.rejects(prisma.$transaction((tx) =>
    recordAmuxTrackedCheckoutEvidence(tx, evidenceInput(ideaId, 2))));
  assert.equal(await prisma.adminAuditLog.count(), auditCount);
  assert.equal(await prisma.amuxIdeaTrackedCheckoutEvidence.count({
    where: { ideaId },
  }), 1);
});

test("database rejects mismatched canonical audit and mutation of stored evidence", async () => {
  const rollback = new Error("rollback forged checkout evidence");
  await assert.rejects(prisma.$transaction(async (tx) => {
    const input = evidenceInput(ideaId, 1);
    const inspected = inspectAmuxTrackedCheckoutEvidence(input);
    assert.ok(inspected);
    const evidenceId = randomUUID();
    const auditLogId = await writeSystemAuditLog({
      tx,
      systemActor: AMUX_V19_TRACKED_CHECKOUT_AUDIT_ACTOR,
      action: AMUX_V19_TRACKED_CHECKOUT_RECORDED_ACTION,
      targetType: AMUX_V19_TRACKED_CHECKOUT_RECORDED_TARGET,
      targetId: evidenceId,
      summary: AMUX_V19_TRACKED_CHECKOUT_AUDIT_SUMMARY,
      metadata: amuxTrackedCheckoutEvidenceAuditMetadata(evidenceId, inspected),
    });
    const sameTransaction = await tx.$queryRaw<Array<{ same: boolean }>>`
      SELECT xmin = pg_current_xact_id()::xid AS same
      FROM "AdminAuditLog" WHERE "id" = ${auditLogId}
    `;
    assert.deepEqual(sameTransaction, [{ same: true }]);
    await tx.$executeRawUnsafe("SAVEPOINT forged_checkout");
    await assert.rejects(tx.amuxIdeaTrackedCheckoutEvidence.create({ data: {
      id: evidenceId,
      ideaId,
      referenceOrdinal: 1,
      pinnedCommitSha: "c".repeat(40),
      excludedCount: inspected.excludedCount,
      excludedSecretPathCount: inspected.excludedSecretPathCount,
      excludedSecretContentCount: inspected.excludedSecretContentCount,
      excludedNonRegularCount: inspected.excludedNonRegularCount,
      excludedUnscannableCount: inspected.excludedUnscannableCount,
      excludedPathDigest: inspected.excludedPathDigest,
      excludedPathDigestKeyId: inspected.excludedPathDigestKeyId,
      auditLogId,
    } }));
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT forged_checkout");
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT forged_checkout");
    throw rollback;
  }), (error: unknown) => error === rollback);

  await assert.rejects(prisma.amuxIdeaTrackedCheckoutEvidence.update({
    where: { ideaId_referenceOrdinal: { ideaId, referenceOrdinal: 0 } },
    data: { pinnedCommitSha: "d".repeat(40) },
  }), /append only/);
  await assert.rejects(prisma.amuxIdeaTrackedCheckoutEvidence.delete({
    where: { ideaId_referenceOrdinal: { ideaId, referenceOrdinal: 0 } },
  }), /append only/);
});
