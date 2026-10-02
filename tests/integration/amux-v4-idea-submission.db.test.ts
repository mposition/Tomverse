import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { openAmuxContent } from "@/lib/amux/ideaCrypto";
import { inspectAmuxIdeaSubmission, submissionFailureKind } from "@/lib/amux/ideaSubmissionCore";
import {
  commitIdeaSubmission,
  IdeaSubmissionError,
  listRecentIdeaSubmissions,
  readIdeaSubmissionRequest,
} from "@/lib/amux/ideaSubmissionService";
import { prisma } from "@/lib/prisma";

const runnerTestUrl = process.env.TEST_DATABASE_URL?.trim();
const standaloneTestUrl = process.env.AMUX_V4_SUBMISSION_TEST_DATABASE_URL?.trim();
const testUrl = runnerTestUrl || standaloneTestUrl;
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    (runnerTestUrl && standaloneTestUrl && runnerTestUrl !== standaloneTestUrl) ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: AMUX v4 submission DB test requires one dedicated loopback test database shared with the DB integration runner");
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
  masterKeyId: "synthetic-master",
  masterKeyVersion: 1,
  masterKey: randomBytes(32),
  digestKeyId: "synthetic-digest",
  digestKey: randomBytes(32),
};
const ideaText = `SYNTHETIC_ONLY_${randomUUID()}`;
const requestId = randomUUID();
const ideaId = randomUUID();
const inspected = inspectAmuxIdeaSubmission(JSON.stringify({
  version: 1,
  requestId,
  input: { version: 1, idea: ideaText, repositories: [], pullRequests: [] },
}));
if (!inspected.ok) throw new Error(`Synthetic submission rejected: ${inspected.code}`);

after(async () => {
  await prisma.$disconnect();
});

test("synthetic idea submission is encrypted, audited, request-idempotent, and creates no card", async () => {
  const beforeCards = await prisma.amuxWorkItem.count();
  const result = await prisma.$transaction((tx) =>
    commitIdeaSubmission(tx, { session, request, inspected, ideaId, keys }),
  );
  assert.equal(result.ideaId, ideaId);
  const stored = await prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: ideaId } });
  assert.equal(stored.requestId, requestId);
  assert.equal(stored.state, "submitted");
  assert.equal(stored.analysisDeadlineAt.getTime() - stored.submittedAt.getTime(), 7 * 86_400_000);
  assert.equal(stored.rawPurgeAfter?.getTime(), stored.analysisDeadlineAt.getTime());
  assert.equal(Buffer.from(stored.rawCiphertext ?? []).includes(Buffer.from(ideaText)), false);
  const opened = openAmuxContent({
    ciphertext: Buffer.from(stored.rawCiphertext ?? []),
    keyId: stored.rawKeyId ?? "",
    keyVersion: stored.rawKeyVersion ?? 0,
  }, "idea_raw", ideaId, keys);
  assert.equal(JSON.parse(opened.toString("utf8")).idea, ideaText);
  assert.deepEqual(await readIdeaSubmissionRequest(session, requestId),
    { requestId, status: "committed", ideaId, hasExternalSources: false });
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: result.auditId } });
  assert.equal(audit.actorUserId, actorUserId);
  assert.equal(audit.action, "AMUX_V4_IDEA_SUBMITTED");
  assert.ok(audit.entryHash);
  assert.equal(JSON.stringify(audit.metadata).includes(ideaText), false);
  assert.equal(await prisma.amuxWorkItem.count(), beforeCards);
  await assert.rejects(
    prisma.$transaction((tx) => commitIdeaSubmission(tx, {
      session, request, inspected, ideaId: randomUUID(), keys,
    })),
    (error: unknown) => error instanceof IdeaSubmissionError && error.code === "request_already_seen",
  );
  assert.equal(await prisma.amuxIdeaSubmission.count({ where: { requestId } }), 1);
  let databaseUniqueError: unknown;
  try {
    await prisma.amuxIdeaSubmission.create({
      data: {
        id: randomUUID(), requestId, actorUserId, state: "submitted",
        submittedAt: stored.submittedAt, analysisDeadlineAt: stored.analysisDeadlineAt,
        updatedAt: stored.updatedAt,
      },
    });
  } catch (error) {
    databaseUniqueError = error;
  }
  assert.ok(databaseUniqueError);
  assert.notEqual(submissionFailureKind(false, databaseUniqueError), "definitive_failure");
});

test("read-back preserves whether the saved idea declared external sources", async () => {
  const sourceRequestId = randomUUID();
  const sourceIdeaId = randomUUID();
  const sourceInspection = inspectAmuxIdeaSubmission(JSON.stringify({
    version: 1, requestId: sourceRequestId,
    input: { version: 1, idea: "SYNTHETIC_SOURCE_REFERENCE", repositories: ["mposition/Tomverse"],
      pullRequests: [] },
  }));
  if (!sourceInspection.ok) throw new Error(sourceInspection.code);
  await prisma.$transaction((tx) => commitIdeaSubmission(tx, {
    session, request, inspected: sourceInspection, ideaId: sourceIdeaId, keys,
  }));
  assert.deepEqual(await readIdeaSubmissionRequest(session, sourceRequestId),
    { requestId: sourceRequestId, status: "committed", ideaId: sourceIdeaId,
      hasExternalSources: true });
  const recent = await listRecentIdeaSubmissions(session);
  assert.ok(recent.some((item) => item.ideaId === ideaId && item.requestId === requestId));
  assert.ok(recent.some((item) => item.ideaId === sourceIdeaId && item.requestId === sourceRequestId));
  assert.equal(JSON.stringify(recent).includes(ideaText), false);
  assert.ok(recent.every((item) => new Date(item.analysisDeadlineAt) > new Date(item.submittedAt)));
  const otherOwner = { ...session, user: { ...session.user, id: `other-${randomUUID()}` } } as Session;
  assert.deepEqual(await listRecentIdeaSubmissions(otherOwner), []);
});

test("recent picker omits expired, cancelled and purged ideas", async () => {
  const now = new Date();
  const recentAt = new Date(now.getTime() - 60_000);
  const expiredAt = new Date(now.getTime() - 8 * 86_400_000);
  const rows = [
    { id: randomUUID(), requestId: randomUUID(), actorUserId, state: "submitted",
      submittedAt: expiredAt,
      analysisDeadlineAt: new Date(expiredAt.getTime() + 7 * 86_400_000),
      rawPurgeAfter: new Date(expiredAt.getTime() + 7 * 86_400_000),
      rawCiphertext: Buffer.from("SYNTHETIC_EXPIRED"), rawKeyId: "synthetic-key",
      rawKeyVersion: 1 },
    { id: randomUUID(), requestId: randomUUID(), actorUserId, state: "cancelled",
      submittedAt: recentAt,
      analysisDeadlineAt: new Date(recentAt.getTime() + 7 * 86_400_000),
      cancelledAt: now, rawPurgeAfter: now,
      rawCiphertext: Buffer.from("SYNTHETIC_CANCELLED"),
      rawKeyId: "synthetic-key", rawKeyVersion: 1 },
    { id: randomUUID(), requestId: randomUUID(), actorUserId, state: "submitted",
      submittedAt: recentAt,
      analysisDeadlineAt: new Date(recentAt.getTime() + 7 * 86_400_000),
      rawPurgedAt: now },
  ] as const;
  for (const row of rows) await prisma.amuxIdeaSubmission.create({ data: row });
  const recent = await listRecentIdeaSubmissions(session);
  for (const row of rows) assert.equal(recent.some((item) => item.ideaId === row.id), false);
});

test("submission row and canonical audit roll back together", async () => {
  const rollbackRequestId = randomUUID();
  const rollbackIdeaId = randomUUID();
  const rollbackInspection = inspectAmuxIdeaSubmission(JSON.stringify({
    version: 1,
    requestId: rollbackRequestId,
    input: { version: 1, idea: "SYNTHETIC_ROLLBACK", repositories: [], pullRequests: [] },
  }));
  if (!rollbackInspection.ok) throw new Error(rollbackInspection.code);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await commitIdeaSubmission(tx, {
      session, request, inspected: rollbackInspection, ideaId: rollbackIdeaId, keys,
    });
    throw new Error("synthetic rollback");
  }));
  assert.equal(await prisma.amuxIdeaSubmission.count({ where: { id: rollbackIdeaId } }), 0);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "AMUX_V4_IDEA_SUBMITTED", targetId: rollbackIdeaId },
  }), 0);
});
