import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { seedAmuxV4PortfolioRecoveryPrerequisites } from
  "./helpers/amuxV4PortfolioSeedFixture.mjs";

// Real PostgreSQL, rollback-only (owner decision 2026-11-18,
// docs/policy/amux-v22-result-transfer.md): a v22 run's result, patch and
// changed-path list arrive in sealed chunks, commit through the routes the
// Rust bridge calls, read back in slices, and leave no staging behind; what no
// commit takes is swept and its unit key queued for deletion. The routes run
// against the seeded attempt inside the test's own transaction, with an
// in-memory unit key store in place of S3.

const raw = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!raw || process.env.DATABASE_URL !== raw) return false;
  const value = new URL(raw);
  return ["localhost", "127.0.0.1"].includes(value.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(value.pathname);
})();
const skip = allowed ? undefined : "requires a dedicated loopback test database";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MIB = 1024 * 1024;

// The test's own transaction, which every module's `prisma` resolves to.
let current = null;
const prisma = new Proxy({}, {
  get(_, key) {
    if (!current) throw new Error("no test transaction");
    if (key === "$transaction") return async (work) => work(current);
    const value = current[key];
    return typeof value === "function" ? value.bind(current) : value;
  },
});
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma,
  prismaPoolUsage: () => ({ total: 0, idle: 0, waiting: 0 }) } });
// A route's unknown outcome is recorded by class and code only; with only
// synthetic data here, the test prints the whole error so a failure says why.
mock.module(mod("lib/amux/operationalError.ts"), { namedExports: {
  reportAmuxOperationalIncident: (operation, error) => {
    console.error(`[${operation}]`, error instanceof Error ? error.stack : String(error));
    return { incidentId: "00000000-0000-4000-8000-000000000000",
      errorClass: "Error", errorCode: "AMUX_INTERNAL_OPERATION_FAILED" };
  },
} });
// The real modules under another URL, so the mocks below keep their exports.
const realGuard = await import(`${mod("lib/amux/guard.ts")}?real`);
mock.module(mod("lib/amux/guard.ts"), {
  namedExports: { ...realGuard, isAmuxSyncAuthorized: () => true },
});
const realKeyStore = await import(`${mod("lib/amux/ideaKeyStore.ts")}?real`);
const unitKeys = new Map();
const digestKey = randomBytes(32);
const coordinate = (identity) => `${identity.ideaId}\0${identity.purpose}\0${identity.subjectId}`;
const keysOf = (identity) => ({ masterKeyId: realKeyStore.amuxContentUnitKeyId(identity),
  masterKeyVersion: 1, masterKey: Buffer.from(unitKeys.get(coordinate(identity))),
  digestKeyId: "synthetic-digest", digestKey: Buffer.from(digestKey) });
const keyCalls = { create: 0, load: 0, deleted: [] };
mock.module(mod("lib/amux/ideaKeyStore.ts"), { namedExports: { ...realKeyStore,
  createAmuxContentUnitKeys: async (identity) => {
    keyCalls.create += 1;
    if (unitKeys.has(coordinate(identity)))
      throw new realKeyStore.AmuxIdeaKeyStoreError("conflict");
    unitKeys.set(coordinate(identity), randomBytes(32));
    return keysOf(identity);
  },
  loadAmuxContentUnitKeys: async (identity) => {
    keyCalls.load += 1;
    if (!unitKeys.has(coordinate(identity)))
      throw new realKeyStore.AmuxIdeaKeyStoreError("missing");
    return keysOf(identity);
  },
  deleteAmuxContentUnitKey: async (identity) => {
    keyCalls.deleted.push(coordinate(identity));
    unitKeys.delete(coordinate(identity));
  },
} });

const upload = await import(mod("app/api/internal/amux/v22/execution/upload/route.ts"));
const result = await import(mod("app/api/internal/amux/v22/execution/result/route.ts"));
const paths = await import(mod("app/api/internal/amux/v22/execution/changed-paths/route.ts"));
const { readAmuxSealedBytea } = await import(mod("lib/amux/sealedByteaRead.ts"));
const { openAmuxV22TaskResultRow, openAmuxV22TaskPatchRow } =
  await import(mod("lib/amux/v22TaskResultStore.ts"));
const { resolveAmuxV22NamedChangedPaths } = await import(mod("lib/amux/v22ChangedPathsStore.ts"));
const { sweepAmuxV22TransferStaging } = await import(mod("lib/amux/v22TransferStore.ts"));
const { readAmuxContentPurgeOutcome } =
  await import(mod("lib/amux/ideaContentKeyRetirementService.ts"));
const { AMUX_V22_EMPTY_SHA256, AMUX_V22_TRANSFER_CHUNK_BYTES, amuxV22TransferChunkRange,
  encodeAmuxV22ChangedPaths } = await import(mod("lib/amux/v22TransferCore.ts"));

function prismaQueryAdapter(tx) {
  return { query: async (sql, params = []) => {
    if (/^\s*SELECT\s+pg_advisory_xact_lock\b/i.test(sql)) {
      const rowCount = await tx.$executeRawUnsafe(sql, ...params);
      return { rows: [], rowCount };
    }
    if (/^\s*SELECT\b|\bRETURNING\b/i.test(sql)) {
      const rows = await tx.$queryRawUnsafe(sql, ...params);
      return { rows, rowCount: rows.length };
    }
    const rowCount = await tx.$executeRawUnsafe(sql, ...params);
    return { rows: [], rowCount };
  } };
}

/** Seeds a live implement (or investigate) attempt, runs `work` against it
 * inside the seeding transaction, then rolls everything back. */
async function withLiveAttempt(taskRole, work) {
  const client = new PrismaClient({ adapter: new PrismaPg(new pg.Pool({
    connectionString: raw, max: 1 })) });
  const rollback = new Error("synthetic transfer rollback");
  try {
    await assert.rejects(client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '60000', true)`;
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      current = tx;
      await seedAmuxV4PortfolioRecoveryPrerequisites(prismaQueryAdapter(tx), {
        taskRole, afterAttempt: async ({ ids, attemptId }) => {
          await work({ tx, attemptId, taskId: ids.task });
          // The seed settles the attempt next; the long statements above left
          // their own timeouts, so restore the seed's.
          await tx.$executeRaw`SELECT set_config('statement_timeout', '60000', true)`;
        } });
      throw rollback;
    }, { timeout: 180_000, maxWait: 10_000 }), (error) => error === rollback);
  } finally {
    current = null;
    await client.$disconnect();
  }
}

const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(body) });
const endpoint = (path) => `https://tomverse.test/api/internal/amux/v22/execution/${path}`;
const post = async (handler, path, body) => {
  const response = await handler.POST(new Request(endpoint(path), json(body)));
  return { status: response.status, body: await response.json() };
};
const get = async (handler, path, attemptId) => {
  const response = await handler.GET(new Request(`${endpoint(path)}?attemptId=${attemptId}`));
  return { status: response.status, body: await response.json() };
};

/** The upload body of chunk `index` of `bytes`, as the bridge sends it. */
const chunkBody = (attemptId, part, bytes, index, extra = {}) => {
  const range = amuxV22TransferChunkRange(bytes.length, index);
  const chunk = bytes.subarray(range.start, range.end);
  return { attemptId, worker: "worker-one", part, totalBytes: bytes.length,
    sha256: sha256(bytes), index, chunkSha256: sha256(chunk),
    bytesBase64: chunk.toString("base64"), ...extra };
};
const stagedParts = async (tx, attemptId) =>
  (await tx.$queryRaw`SELECT "part" FROM "AmuxV22TransferPart"
    WHERE "attemptId" = ${attemptId} ORDER BY "part"`).map((row) => row.part);

test("a two-chunk result and its patch commit once and read back in slices", { skip }, async () => {
  await withLiveAttempt("implement", async ({ tx, attemptId }) => {
    // Two chunks of plain text: one full chunk and a short last one.
    const resultText = `${"r".repeat(AMUX_V22_TRANSFER_CHUNK_BYTES)}\nlast line of the report\n`;
    const resultBytes = Buffer.from(resultText, "utf8");
    const patchText = "diff --git a/lib/x.ts b/lib/x.ts\n--- a/lib/x.ts\n+++ b/lib/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const patchBytes = Buffer.from(patchText, "utf8");
    const baseSha = "a".repeat(40);
    const commitBody = { attemptId, worker: "worker-one", transfer: "chunked_v1",
      sourceSha256: sha256(resultBytes), resultBytes: resultBytes.length,
      patch: { sha256: sha256(patchBytes), baseSha, bytes: patchBytes.length } };

    // The last chunk first: the part counts what it has.
    let answer = await post(upload, "upload", chunkBody(attemptId, "result", resultBytes, 1));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, { attemptId, part: "result", index: 1,
      duplicate: false, received: 1, chunkCount: 2 });
    // A commit before the rest names what is missing, for each part.
    answer = await post(result, "result", commitBody);
    assert.equal(answer.status, 409);
    assert.deepEqual(answer.body, { error: "upload_incomplete",
      missing: { result: [0], patch: [0] } });
    answer = await post(upload, "upload", chunkBody(attemptId, "result", resultBytes, 0));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.received, 2);
    // The same chunk again is a duplicate; other bytes at that index conflict.
    answer = await post(upload, "upload", chunkBody(attemptId, "result", resultBytes, 0));
    assert.equal(answer.status, 200);
    assert.equal(answer.body.duplicate, true);
    const forged = Buffer.from(resultBytes);
    forged[5] = 0x73;
    const forgedChunk = forged.subarray(0, AMUX_V22_TRANSFER_CHUNK_BYTES);
    answer = await post(upload, "upload", { ...chunkBody(attemptId, "result", resultBytes, 0),
      chunkSha256: sha256(forgedChunk), bytesBase64: forgedChunk.toString("base64") });
    assert.deepEqual(answer, { status: 409, body: { error: "chunk_conflict" } });
    // Another description of the same part is an upload conflict.
    answer = await post(upload, "upload", chunkBody(attemptId, "result", forged, 1));
    assert.deepEqual(answer, { status: 409, body: { error: "upload_conflict" } });
    // A patch chunk names its base; a part outside the schema is refused.
    answer = await post(upload, "upload", chunkBody(attemptId, "patch", patchBytes, 0));
    assert.equal(answer.status, 400);
    answer = await post(upload, "upload", chunkBody(attemptId, "patch", patchBytes, 0, { baseSha }));
    assert.equal(answer.status, 200);
    assert.equal(answer.body.chunkCount, 1);
    assert.deepEqual(await stagedParts(tx, attemptId), ["patch", "result"]);

    answer = await post(result, "result", commitBody);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, { attemptId, sourceSha256: sha256(resultBytes),
      patchSha256: sha256(patchBytes), duplicate: false, filesDigest: null,
      patchRejected: false });
    // The commit took its staging with it.
    assert.deepEqual(await stagedParts(tx, attemptId), []);
    // The same commit again is a duplicate; a chunk after it is refused.
    answer = await post(result, "result", commitBody);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.duplicate, true);
    assert.equal(answer.body.patchSha256, sha256(patchBytes));
    answer = await post(result, "result", { ...commitBody,
      patch: { ...commitBody.patch, bytes: patchBytes.length + 1 } });
    assert.deepEqual(answer, { status: 409, body: { error: "result_conflict" } });
    answer = await post(upload, "upload", chunkBody(attemptId, "result", resultBytes, 0));
    assert.deepEqual(answer, { status: 409, body: { error: "already_recorded" } });

    // The readback names sizes and does not need to open a large body.
    answer = await get(result, "result", attemptId);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { status: "recorded", attemptId,
      sourceSha256: sha256(resultBytes), resultBytes: resultBytes.length,
      bodyAvailable: true, patch: { sha256: sha256(patchBytes), baseSha,
        bytes: patchBytes.length, bodyAvailable: true, filesDigest: null } });

    // Read back in slices smaller than the body; it opens to the same text.
    const stored = await tx.amuxV22TaskResult.findUnique({ where: { attemptId },
      select: { ideaId: true, keyId: true, keyVersion: true, digest: true,
        digestKeyId: true, bodyPurgedAt: true, sourceSha256: true } });
    const sliced = await readAmuxSealedBytea("task_result", attemptId, tx, 1 * MIB + 7);
    const whole = await readAmuxSealedBytea("task_result", attemptId, tx);
    assert.ok(sliced && whole && sliced.equals(whole) && sliced.length > resultBytes.length);
    assert.equal(await openAmuxV22TaskResultRow(attemptId, stored), resultText);
    const storedPatch = await tx.amuxV22TaskPatch.findUnique({ where: { attemptId },
      select: { ideaId: true, keyId: true, keyVersion: true, digest: true,
        digestKeyId: true, bodyPurgedAt: true, patchSha256: true } });
    assert.equal(await openAmuxV22TaskPatchRow(attemptId, storedPatch), patchText);
    assert.equal(await readAmuxSealedBytea("task_changed_paths", attemptId, tx), null);
  });
});

test("a changed-path list commits on its own and is named by digest", { skip }, async () => {
  await withLiveAttempt("investigate", async ({ tx, attemptId }) => {
    const list = ["lib/a.ts", "docs/한글.md", "tests/b.test.mjs"];
    const bytes = encodeAmuxV22ChangedPaths(list);
    const named = { sha256: sha256(bytes), count: list.length };
    const commitBody = { attemptId, worker: "worker-one", transfer: "chunked_v1",
      sha256: named.sha256, count: list.length, bytes: bytes.length };
    assert.deepEqual(await get(paths, "changed-paths", attemptId),
      { status: 200, body: { status: "absent" } });
    // A part whose chunks do not make the described bytes is deleted at commit.
    const wrongDigest = "f".repeat(64);
    let answer = await post(upload, "upload", { ...chunkBody(attemptId, "changed_paths",
      bytes, 0, { count: list.length }), sha256: wrongDigest });
    assert.equal(answer.status, 200);
    answer = await post(paths, "changed-paths", { ...commitBody, sha256: wrongDigest });
    assert.deepEqual(answer, { status: 409, body: { error: "upload_digest_mismatch",
      part: "changed_paths" } });
    assert.deepEqual(await stagedParts(tx, attemptId), []);
    // Nothing staged: every chunk is missing.
    answer = await post(paths, "changed-paths", commitBody);
    assert.deepEqual(answer, { status: 409, body: { error: "upload_incomplete",
      missing: { changed_paths: [0] } } });
    answer = await post(upload, "upload", chunkBody(attemptId, "changed_paths", bytes, 0,
      { count: list.length }));
    assert.equal(answer.status, 200);
    answer = await post(paths, "changed-paths", commitBody);
    assert.deepEqual(answer, { status: 200, body: { attemptId, sha256: named.sha256,
      count: list.length, duplicate: false } });
    assert.deepEqual(await stagedParts(tx, attemptId), []);
    answer = await post(paths, "changed-paths", commitBody);
    assert.equal(answer.body.duplicate, true);
    answer = await post(paths, "changed-paths", { ...commitBody, count: 2 });
    assert.deepEqual(answer, { status: 409, body: { error: "paths_conflict" } });
    assert.deepEqual(await get(paths, "changed-paths", attemptId), { status: 200,
      body: { status: "recorded", attemptId, sha256: named.sha256, count: list.length,
        bytes: bytes.length, bodyAvailable: true } });

    // Settlement names it: the recorded list, the empty list, or unrecorded.
    assert.deepEqual(await resolveAmuxV22NamedChangedPaths(attemptId, {
      changed_paths_digest: named.sha256, changed_paths_count: list.length }, tx),
    { kind: "paths", paths: list });
    assert.deepEqual(await resolveAmuxV22NamedChangedPaths(attemptId, {
      changed_paths_digest: AMUX_V22_EMPTY_SHA256, changed_paths_count: 0 }, tx),
    { kind: "paths", paths: [] });
    assert.deepEqual(await resolveAmuxV22NamedChangedPaths(attemptId, {
      changed_paths_digest: "e".repeat(64), changed_paths_count: list.length }, tx),
    { kind: "unrecorded" });
    assert.deepEqual(await resolveAmuxV22NamedChangedPaths(attemptId, {
      changed_paths_digest: named.sha256, changed_paths_count: list.length + 1 }, tx),
    { kind: "unrecorded" });
    assert.deepEqual(await resolveAmuxV22NamedChangedPaths(attemptId, {
      changed_paths_digest: named.sha256, changed_paths_count: list.length,
      changed_paths: list }, tx), { kind: "invalid" });
    assert.deepEqual(await resolveAmuxV22NamedChangedPaths(attemptId, {
      changed_paths_digest: AMUX_V22_EMPTY_SHA256, changed_paths_count: 1 }, tx),
    { kind: "invalid" });
    assert.deepEqual(await resolveAmuxV22NamedChangedPaths(attemptId, {}, tx),
      { kind: "absent" });
  });
});

test("staging no commit takes is swept and its key queued for deletion", { skip }, async () => {
  // An investigate run's patch is not kept: the commit records the result and
  // leaves the patch's staging, which the sweep removes.
  await withLiveAttempt("investigate", async ({ tx, attemptId }) => {
    const resultBytes = Buffer.from("A short report.\n", "utf8");
    const patchBytes = Buffer.from("diff --git a/x b/x\n+y\n", "utf8");
    const baseSha = "b".repeat(40);
    assert.equal((await post(upload, "upload", chunkBody(attemptId, "result",
      resultBytes, 0))).status, 200);
    assert.equal((await post(upload, "upload", chunkBody(attemptId, "patch",
      patchBytes, 0, { baseSha }))).status, 200);
    const answer = await post(result, "result", { attemptId, worker: "worker-one",
      transfer: "chunked_v1", sourceSha256: sha256(resultBytes),
      resultBytes: resultBytes.length,
      patch: { sha256: sha256(patchBytes), baseSha, bytes: patchBytes.length } });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.patchSha256, null);
    assert.equal(answer.body.patchRejected, true);
    assert.deepEqual(await stagedParts(tx, attemptId), ["patch"]);

    const swept = await sweepAmuxV22TransferStaging(prisma);
    assert.ok(swept.partsSwept >= 1 && swept.keysQueued >= 1, JSON.stringify(swept));
    assert.deepEqual(await stagedParts(tx, attemptId), []);
    const ideaId = (await tx.amuxV22TaskResult.findUnique({ where: { attemptId },
      select: { ideaId: true } })).ideaId;
    const ledger = await tx.amuxIdeaContentKeyRetirement.findMany({
      where: { subjectId: attemptId }, select: { purpose: true } });
    assert.deepEqual(ledger.map((row) => row.purpose), ["task_patch"]);
    // With no patch row and no staging, the patch key's body is purged.
    assert.equal(await readAmuxContentPurgeOutcome({ ideaId, purpose: "task_patch",
      subjectId: attemptId }), "purged");
    // The result's key is in use; nothing else of the attempt is queued.
    assert.equal(await readAmuxContentPurgeOutcome({ ideaId, purpose: "task_result",
      subjectId: attemptId }), "not_purged");
    // The committed patch part takes no chunk after the commit.
    assert.deepEqual(await post(upload, "upload", chunkBody(attemptId, "patch",
      patchBytes, 0, { baseSha })), { status: 409, body: { error: "already_recorded" } });
    // A second sweep finds nothing of this attempt.
    assert.equal((await sweepAmuxV22TransferStaging(prisma)).keysQueued, 0);
  });
});

test("the database holds a chunk to one request's bytes and the list to its counts", { skip }, async () => {
  await withLiveAttempt("investigate", async ({ tx, attemptId }) => {
    const db = prismaQueryAdapter(tx);
    const probe = async (sql, params, constraint) => {
      await db.query("SAVEPOINT probe");
      let error;
      try { await db.query(sql, params); } catch (caught) { error = caught; }
      await db.query("ROLLBACK TO SAVEPOINT probe");
      await db.query("RELEASE SAVEPOINT probe");
      assert.ok(error, `${constraint} did not refuse`);
      assert.match(String(error.message) + JSON.stringify(error.meta ?? {}), new RegExp(constraint));
    };
    const taskId = (await tx.amuxExecutionAttempt.findUnique({ where: { id: attemptId },
      select: { taskId: true } })).taskId;
    const part = (name, extra = {}) => ({ baseSha: null, pathCount: null, ...extra, name });
    for (const [row, constraint] of [
      [part("result", { totalBytes: 0 }), "AmuxV22TransferPart_check"],
      [part("patch"), "AmuxV22TransferPart_check"],
      [part("changed_paths"), "AmuxV22TransferPart_check"],
      [part("result", { baseSha: "a".repeat(40) }), "AmuxV22TransferPart_check"],
      [part("report"), "AmuxV22TransferPart_part_check"],
    ]) {
      await probe(`INSERT INTO "AmuxV22TransferPart" ("attemptId", "part", "taskId",
        "ideaId", "worker", "totalBytes", "sha256", "baseSha", "pathCount")
        VALUES ($1, $2, $3, $4, 'worker-one', $5, $6, $7, $8)`,
      [attemptId, row.name, taskId, "x", row.totalBytes ?? 1, "a".repeat(64),
        row.baseSha, row.pathCount], constraint);
    }
    await db.query(`INSERT INTO "AmuxV22TransferPart" ("attemptId", "part", "taskId",
      "ideaId", "worker", "totalBytes", "sha256") VALUES ($1, 'result', $2, 'x',
      'worker-one', 9, $3)`, [attemptId, taskId, "a".repeat(64)]);
    await probe(`INSERT INTO "AmuxV22TransferChunk" ("attemptId", "part", "index",
      "byteLength", "ciphertext", "keyId", "keyVersion", "digest", "digestKeyId")
      VALUES ($1, 'result', 0, $2, $3, 'k', 1, $4, 'd')`,
    [attemptId, AMUX_V22_TRANSFER_CHUNK_BYTES + 1, Buffer.from("x"), "a".repeat(64)],
    "AmuxV22TransferChunk_check");
    await probe(`UPDATE "AmuxV22TransferPart" SET "worker" = 'other'
      WHERE "attemptId" = $1`, [attemptId], "written once");
    const storage = await db.query(`SELECT a.attstorage::text AS "storage" FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'AmuxV22TransferChunk' AND a.attname = 'ciphertext'`);
    assert.equal(storage.rows[0].storage, "e");
    // The result and patch checks keep only a lower bound.
    const checks = await db.query(`SELECT conname AS "name",
      pg_get_constraintdef(oid) AS "definition" FROM pg_constraint
      WHERE conname IN ('AmuxV22TaskResult_digest_check', 'AmuxV22TaskPatch_digest_check')`);
    assert.equal(checks.rows.length, 2);
    for (const check of checks.rows) {
      assert.match(check.definition, /"byteLength" >= 1/, check.name);
      assert.doesNotMatch(check.definition, /BETWEEN|<=/, check.name);
    }
  });
});
