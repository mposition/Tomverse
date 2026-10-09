import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { AmuxIdeaResolutionPreviewError,
  readAmuxIdeaResolutionCatalog } from "@/lib/amux/ideaResolutionPreviewService";
import { prisma } from "@/lib/prisma";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/(?:^|[_-])test(?:[_-]|$)/i.test(url.pathname) ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: A08 catalog DB test needs a dedicated loopback test database");
}

const actorUserId = `synthetic-a08-owner-${randomUUID()}`;
const actorEmail = "amux-a08-synthetic-owner@example.test";
process.env.ADMIN_USER_IDS = actorUserId;
process.env.ADMIN_EMAILS = actorEmail;
process.env.ADMIN_OWNER_EMAILS = actorEmail;
const session = { user: { id: actorUserId, email: actorEmail,
  authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString() } as Session;

after(async () => { await prisma.$disconnect(); });

test("owner catalog is idea-bound and keeps legacy cards as non-linkable hints", async () => {
  const ideaId = randomUUID();
  const matchingLegacyId = `legacy-${randomUUID()}`;
  const longLegacyId = `legacy-${randomUUID()}`;
  const submittedAt = new Date();
  try {
    await prisma.amuxIdeaSubmission.create({ data: { id: ideaId,
      requestId: randomUUID(), actorUserId, state: "submitted",
      submittedAt, analysisDeadlineAt: new Date(submittedAt.getTime() + 7 * 86_400_000) } });
    await prisma.amuxWorkItem.create({ data: { id: matchingLegacyId,
      title: "synthetic legacy item", status: "backlog" } });
    await prisma.amuxWorkItem.create({ data: { id: longLegacyId,
      title: "x".repeat(201), status: "backlog" } });
    const catalog = await readAmuxIdeaResolutionCatalog(session, ideaId);
    assert.equal(catalog.nodes.every((node) => !("title" in node)), true);
    assert.equal(catalog.cards.some((card) =>
      card.ref === matchingLegacyId || card.ref === longLegacyId), false);
    assert.equal(catalog.legacyCards.length >= 1, true);
    assert.equal(catalog.legacyCards.some((card) =>
      card.ref === matchingLegacyId && card.title === "synthetic legacy item"), true);
    assert.equal(catalog.legacyCards.some((card) => card.ref === longLegacyId), false);
    await assert.rejects(readAmuxIdeaResolutionCatalog({ ...session,
      user: { id: `other-${randomUUID()}`, email: actorEmail } } as Session, ideaId),
    (error: unknown) => error instanceof AmuxIdeaResolutionPreviewError &&
      error.code === "not_found");
    await assert.rejects(readAmuxIdeaResolutionCatalog(session, randomUUID()),
      (error: unknown) => error instanceof AmuxIdeaResolutionPreviewError &&
        error.code === "not_found");
  } finally {
    await prisma.amuxWorkItem.deleteMany({ where: { id: {
      in: [matchingLegacyId, longLegacyId] } } });
    await prisma.amuxIdeaSubmission.deleteMany({ where: { id: ideaId,
      actorUserId } });
  }
});
