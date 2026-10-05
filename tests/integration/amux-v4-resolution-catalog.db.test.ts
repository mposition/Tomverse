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

test("owner catalog is idea-bound and excludes non-v4 cards", async () => {
  const ideaId = randomUUID();
  const submittedAt = new Date();
  await prisma.amuxIdeaSubmission.create({ data: { id: ideaId,
    requestId: randomUUID(), actorUserId, state: "submitted",
    submittedAt, analysisDeadlineAt: new Date(submittedAt.getTime() + 7 * 86_400_000) } });
  await prisma.amuxWorkItem.create({ data: { id: `legacy-${randomUUID()}`,
    title: "synthetic legacy item", status: "backlog" } });
  assert.deepEqual(await readAmuxIdeaResolutionCatalog(session, ideaId),
    { nodes: [], cards: [] });
  await assert.rejects(readAmuxIdeaResolutionCatalog({ ...session,
    user: { id: `other-${randomUUID()}`, email: actorEmail } } as Session, ideaId),
  (error: unknown) => error instanceof AmuxIdeaResolutionPreviewError &&
    error.code === "not_found");
  await assert.rejects(readAmuxIdeaResolutionCatalog(session, randomUUID()),
    (error: unknown) => error instanceof AmuxIdeaResolutionPreviewError &&
      error.code === "not_found");
});
