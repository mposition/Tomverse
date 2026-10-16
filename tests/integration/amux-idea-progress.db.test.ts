import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { AMUX_DB_BOUNDARIES, AmuxDbBoundaryError, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { AMUX_IDEA_PROGRESS_LIMIT, readAmuxIdeaProgressForOwner } from "@/lib/amux/ideaProgressRead";
import { amuxIdeaProgressFailureLog } from "@/lib/amux/ideaProgressCore";
import { prisma } from "@/lib/prisma";

// The Ideas tab's progress list against PostgreSQL: the one statement that
// replaced seven reads (lib/amux/ideaProgressRead.ts) runs inside the real
// read boundary with its ceiling of three, and the boundary's 100 ms
// idle-in-transaction timeout is the mechanism that made the seven-read
// version fail in production.

const requireDedicatedAmuxTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
  const url = new URL(testRaw);
  const schemaName = url.searchParams.get("schema");
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const usesDedicatedAmuxSchema = schemaName === "tomverse_amux_test";
  const usesCanonicalCiDatabase =
    databaseName === "tomverse_test" &&
    (schemaName === null || schemaName === "public") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!usesDedicatedAmuxSchema && !usesCanonicalCiDatabase) {
    throw new Error("REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database");
  }
};
requireDedicatedAmuxTestDatabase();

after(async () => {
  await prisma.$disconnect();
});

const DAY_MS = 86_400_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const seedIdea = async (actorUserId: string, submittedAt: Date) => {
  const id = randomUUID();
  const completedAt = new Date(submittedAt.getTime() + 1_000);
  await prisma.amuxIdeaSubmission.create({
    data: {
      id, requestId: randomUUID(), actorUserId, state: "awaiting_owner", submittedAt,
      analysisDeadlineAt: new Date(submittedAt.getTime() + 7 * DAY_MS),
      analysisCompletedAt: completedAt, rawPurgeAfter: completedAt,
    },
  });
  await prisma.amuxIdeaAnalysisChunk.create({
    data: { ideaId: id, actorUserId, chunkIndex: 0, state: "awaiting_preview", attempt: 0, leaseGeneration: 0 },
  });
  return id;
};

test("the progress list reads the owner's newest ideas in one statement inside its three-call boundary", async () => {
  assert.equal(AMUX_DB_BOUNDARIES.ideaProgressListRead.prismaCallCeiling, 3);
  const owner = `idea-progress-owner-${randomUUID()}`;
  const other = `idea-progress-other-${randomUUID()}`;
  const base = Date.now() - 60 * 60 * 1000;
  const ids: string[] = [];
  // One more than the limit, oldest first, so the oldest one must be the one left out.
  for (let index = 0; index <= AMUX_IDEA_PROGRESS_LIMIT; index += 1) {
    ids.push(await seedIdea(owner, new Date(base + index * 1_000)));
  }
  await seedIdea(other, new Date(base + 5_000));

  const rows = await readAmuxIdeaProgressForOwner(owner);
  assert.equal(rows.length, AMUX_IDEA_PROGRESS_LIMIT);
  assert.deepEqual(rows.map((row) => row.ideaId), ids.slice(1).reverse(), "newest first, bounded, the other owner's idea absent");
  for (const row of rows) {
    assert.equal(row.stage, "execution_approval", "saved, with nothing approved yet");
    assert.equal(row.waitingFor, "execution_approval");
    assert.equal(row.displayKey, null);
    assert.deepEqual(row.reviewPullRequests, []);
    assert.match(row.submittedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  assert.equal(rows[0].submittedAt, new Date(base + AMUX_IDEA_PROGRESS_LIMIT * 1_000).toISOString(),
    "the timestamp is the stored UTC instant, whatever the session time zone is");
  assert.deepEqual(await readAmuxIdeaProgressForOwner(`nobody-${randomUUID()}`), [], "no ideas is an empty list");
});

test("a gap over the boundary's idle-in-transaction timeout ends a read with no code at all", async () => {
  // Why the list is one statement: every gap between two statements of a boundary must stay under
  // 100 ms (the session is ended with 25P03), and seven sequential reads made eight of them. The pg
  // client reports it as a plain Error, which is why the page used to log only the bare event.
  const probe = (gapMs: number) => withAmuxDbBoundary(
    { operation: "idea_progress_gap_probe", prismaCallCeiling: 5, isolation: "read" }, async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      await sleep(gapMs);
      await tx.$queryRaw`SELECT 1`;
    });
  await probe(10);
  let failure: unknown;
  await probe(400).catch((error: unknown) => { failure = error; });
  assert.ok(failure, "a 400 ms gap between two statements ends the session");
  assert.equal(failure instanceof AmuxDbBoundaryError, false);
  assert.deepEqual(amuxIdeaProgressFailureLog(failure), {
    subsystem: "amux", event: "idea_progress_read_failed", name: "Error", boundaryCode: null, prismaCode: null,
    sqlState: null, signal: "connection_closed",
  });
});
