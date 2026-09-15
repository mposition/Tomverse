import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * CONT-TITLE-01, step 2: both source deletions lock in one order before any
 * write -- the parent import, then the snapshots by id.
 *
 * The single-snapshot delete used to lock nothing up front and update the
 * parent import last, while the whole-import delete locked the parent first.
 * The race itself is exercised against a real database in
 * tests/integration/external-conversation-continuation.db.test.ts; this file
 * pins the order in the source, where a later edit would move it.
 */

const source = readFileSync("lib/externalImportService.ts", "utf8");

const functionBody = (name) => {
    const start = source.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, `${name} must exist`);
    const next = source.indexOf("\nexport ", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
};

const indexOfOrFail = (body, needle, label) => {
    const index = body.indexOf(needle);
    assert.ok(index >= 0, `${label}: expected ${needle}`);
    return index;
};

test("the snapshot lock helper locks the import, then the snapshot, then re-reads it", () => {
    const start = source.indexOf("async function lockSnapshotForDeletion(");
    const end = source.indexOf("async function lockImportSnapshotsForDeletion(");
    assert.ok(start > 0 && end > start);
    const helper = source.slice(start, end);

    const importLock = indexOfOrFail(helper, `FROM "ExternalImport" WHERE id = \${located.importId} FOR UPDATE`, "helper");
    const snapshotLock = indexOfOrFail(helper, `FROM "ExternalConversation" WHERE id = \${conversationId} FOR UPDATE`, "helper");
    const reread = indexOfOrFail(helper, "tx.externalConversation.findUnique(", "helper");
    assert.ok(importLock < snapshotLock, "the parent import is locked before the snapshot");
    assert.ok(snapshotLock < reread, "the snapshot is re-read after its lock");
    // Ownership is part of both the lookup and the re-read.
    assert.match(helper, /where: \{ id: conversationId, userId \}/);
    assert.match(helper, /row\.userId !== userId \|\| !row\.finalized/);
});

test("the whole-import snapshot lock is ordered by id", () => {
    assert.match(
        source,
        /SELECT id FROM "ExternalConversation" WHERE "importId" = \$\{importId\} ORDER BY id FOR UPDATE/
    );
});

test("the single-snapshot delete takes its locks before its first write", () => {
    const body = functionBody("deleteExternalConversationSnapshot");
    const lock = indexOfOrFail(body, "lockSnapshotForDeletion(tx, userId, conversationId)", "single");
    for (const write of [
        "applySourceDeletionToMemories(",
        "markContinuationSourcesDeleted(",
        "tx.externalConversation.delete(",
        "tx.externalImport.updateMany(",
    ]) {
        assert.ok(lock < indexOfOrFail(body, write, "single"), `locks precede ${write}`);
    }
    assert.doesNotMatch(body, /tx\.externalConversation\.findUnique\(/);
});

test("the whole-import delete locks the import, then its snapshots, before its first write", () => {
    const body = functionBody("deleteExternalImport");
    const importLock = indexOfOrFail(body, "forUpdate: true", "import");
    const snapshotLock = indexOfOrFail(body, "lockImportSnapshotsForDeletion(tx, row.id)", "import");
    assert.ok(importLock < snapshotLock);
    // Every write on both branches, including the open-import cancel branch.
    for (const write of [
        "tx.externalConversation.deleteMany(",
        "tx.externalImport.update(",
        "preserveContinuationTitles(",
        "applySourceDeletionToMemories(",
        "markContinuationSourcesDeleted(",
        "tx.externalImport.delete(",
    ]) {
        assert.ok(snapshotLock < indexOfOrFail(body, write, "import"), `locks precede ${write}`);
    }
    // And the lock is taken before the branch, not inside one of them.
    assert.ok(snapshotLock < indexOfOrFail(body, "isOpenImportStatus(row.status)", "import"));
    assert.equal(body.split("lockImportSnapshotsForDeletion(").length - 1, 1);
});

/* ------------------------------------------- memory lock (MEM-SOURCE-DELETE-01) */

test("both deletions take the account's memory lock after their row locks and before any memory read or write", () => {
    for (const [name, rowLock] of [
        ["deleteExternalConversationSnapshot", "lockSnapshotForDeletion(tx, userId, conversationId)"],
        ["deleteExternalImport", "lockImportSnapshotsForDeletion(tx, row.id)"],
    ]) {
        const body = functionBody(name);
        const rows = indexOfOrFail(body, rowLock, name);
        const memory = indexOfOrFail(body, "lockAccountMemoryItems(tx, userId)", name);
        assert.ok(rows < memory, `${name}: row locks before the memory lock`);
        for (const later of [
            "preserveContinuationTitles(",
            "applySourceDeletionToMemories(",
            "markContinuationSourcesDeleted(",
        ]) {
            assert.ok(memory < indexOfOrFail(body, later, name), `${name}: memory lock before ${later}`);
        }
        assert.equal(body.split("lockAccountMemoryItems(").length - 1, 1, `${name} takes it once`);
    }
    // The whole-import delete takes it before its status branch too.
    const whole = functionBody("deleteExternalImport");
    assert.ok(
        whole.indexOf("lockAccountMemoryItems(tx, userId)") <
            whole.indexOf("isOpenImportStatus(row.status)")
    );
});

/**
 * Every memory write happens under the account's memory lock, and every read a
 * write decides on happens after it.
 *
 * Checked per function, not per file: for each write to MemoryItem or
 * MemoryEvidence, the enclosing function must take the lock before that write,
 * or be a helper whose every call site takes it first. A file that merely
 * mentions the lock somewhere proves nothing -- that is how edit, reject,
 * expiry and the source-lock paths were missed before. And a lock taken after
 * the decision was read proves nothing either -- that is how bulk approval
 * validated evidence a source deletion then removed.
 */
const MEMORY_WRITER_FILES = [
  "lib/memoryService.ts",
  "lib/memoryExtractionPersistence.ts",
  "lib/externalImportService.ts",
  "lib/externalConversationLockService.ts",
  "lib/memoryExpiryService.ts",
  "scripts/backfill-memory-search-terms.mjs",
];
const WRITE_VERBS = "create|createMany|update|updateMany|upsert|delete|deleteMany";
const READ_VERBS = "findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|aggregate|groupBy";
const WRITE = new RegExp(`\\b(?:tx|client|prisma)\\.(?:memoryItem|memoryEvidence)\\.(?:${WRITE_VERBS})\\(`, "g");
const READ = new RegExp(`\\b(tx|client|prisma)\\.(?:memoryItem|memoryEvidence)\\.(?:${READ_VERBS})\\(`, "g");
const LOCK = /\b(?:lockAccountMemoryItems|acquireUserMemoryLock)\(/;

/**
 * Functions allowed an unlocked read before their lock, because that read only
 * enumerates work and the decision is made again under the lock. Each names
 * what, after the lock, re-establishes the facts.
 */
const UNLOCKED_ENUMERATIONS = new Map([
  // Ids only; the candidate and its evidence are re-read and re-validated.
  ["lib/memoryService.ts#bulkApproveMemories", /tx\.memoryItem\.findFirst\(/],
  // The update re-states status and expiry in its where clause.
  ["lib/memoryExpiryService.ts#reconcileExpiredMemories", /tx\.memoryItem\.updateMany\(\{\s*where: \{[\s\S]*?status:[\s\S]*?expiresAt:/],
  // Ids and owners only; the lock facts are re-read for those ids.
  ["lib/externalConversationLockService.ts#reconcileSourceLockedMemories", /memoryLockFacts\(tx, userId, memoryIds\)/],
  // The row is re-read before its terms are computed.
  ["scripts/backfill-memory-search-terms.mjs#main", /tx\.memoryItem\.findUnique\(/],
]);

/** Top-level function bodies, by name. Good enough for these files' style. */
const topLevelFunctions = (code) => {
  const heads = [...code.matchAll(/^(?:export )?(?:async )?function\*? (\w+)\(|^(?:export )?const (\w+) = (?:async )?\(/gm)];
  return heads.map((head, index) => ({
    name: head[1] ?? head[2],
    start: head.index,
    end: heads[index + 1]?.index ?? code.length,
  }));
};

const enclosing = (functions, index) => functions.find((fn) => fn.start <= index && index < fn.end);

test("every memory write is preceded by the account memory lock in its own function or all its callers", () => {
  const helpersNeedingLockedCallers = new Map();
  for (const path of MEMORY_WRITER_FILES) {
    const code = readFileSync(path, "utf8");
    assert.doesNotMatch(code, /"memory-items:"/, `${path} must use lockAccountMemoryItems(), not spell the key`);
    assert.doesNotMatch(
      code,
      new RegExp(`\\bprisma\\.(?:memoryItem|memoryEvidence)\\.(?:${WRITE_VERBS})\\(`),
      `${path}: a memory write outside a transaction cannot hold the lock`
    );
    const functions = topLevelFunctions(code);
    for (const write of code.matchAll(WRITE)) {
      const fn = enclosing(functions, write.index);
      assert.ok(fn, `${path}: a write outside any function`);
      if (LOCK.test(code.slice(fn.start, write.index))) continue;
      helpersNeedingLockedCallers.set(`${path}#${fn.name}`, { path, name: fn.name });
    }
  }
  const expectedHelpers = [
    "lib/externalImportService.ts#applySourceDeletionToMemories",
    "lib/externalConversationLockService.ts#applySourceLockPlan",
    "lib/memoryService.ts#assertNoActiveConflict",
  ];
  assert.deepEqual([...helpersNeedingLockedCallers.keys()].sort(), expectedHelpers.sort());
  for (const { path, name } of helpersNeedingLockedCallers.values()) {
    const code = readFileSync(path, "utf8");
    const functions = topLevelFunctions(code);
    // Every mention except the definition's own head.
    const calls = [...code.matchAll(new RegExp("\\b" + name + "\\(", "g"))].filter(
      (call) => !/function\*?\s+$/.test(code.slice(Math.max(0, call.index - 12), call.index))
    );
    let callSites = 0;
    for (const call of calls) {
      const caller = enclosing(functions, call.index);
      if (!caller || caller.name === name) continue;
      callSites += 1;
      assert.match(
        code.slice(caller.start, call.index),
        LOCK,
        `${path}: ${caller.name} calls ${name} without taking the memory lock first`
      );
    }
    assert.ok(callSites > 0, `${name} has callers`);
  }
});

test("in a function that takes the memory lock, every memory read it decides on comes after the lock", () => {
  const allowedSeen = new Set();
  for (const path of MEMORY_WRITER_FILES) {
    const code = readFileSync(path, "utf8");
    const functions = topLevelFunctions(code);
    // Same-file helpers that read memory rows count as reads where they are
    // called (loadOwnedMemory, for one).
    const readingHelpers = functions
      .filter((fn) => new RegExp(READ.source).test(code.slice(fn.start, fn.end)))
      .map((fn) => fn.name);
    const helperCall = readingHelpers.length
      ? new RegExp(`(?<![\\w.])(?:${readingHelpers.join("|")})\\(`, "g")
      : null;
    for (const fn of functions) {
      const body = code.slice(fn.start, fn.end);
      const lock = body.search(LOCK);
      if (lock < 0) continue;
      const reads = [
        ...[...body.matchAll(READ)].map((read) => ({ index: read.index, text: read[0], client: read[1] })),
        ...(helperCall ? [...body.matchAll(helperCall)] : [])
          .filter((call) => call.index > 0 && !/function\*?\s+$/.test(body.slice(Math.max(0, call.index - 12), call.index)))
          .map((call) => ({ index: call.index, text: call[0], client: "helper" })),
      ];
      const key = `${path}#${fn.name}`;
      for (const read of reads) {
        if (read.index > lock) continue;
        const reestablished = UNLOCKED_ENUMERATIONS.get(key);
        assert.ok(
          reestablished && read.client === "prisma",
          `${key}: ${read.text} is read before the memory lock, so the write decides on a stale row`
        );
        assert.match(body.slice(lock), reestablished, `${key}: the facts must be re-read under the lock`);
        allowedSeen.add(key);
      }
    }
  }
  assert.deepEqual([...allowedSeen].sort(), [...UNLOCKED_ENUMERATIONS.keys()].sort(), "every allowance is still needed");
  // The bulk enumeration reads ids and nothing a decision could use.
  const service = readFileSync("lib/memoryService.ts", "utf8");
  const bulk = service.slice(service.indexOf("export async function bulkApproveMemories("));
  assert.match(bulk.slice(0, bulk.search(LOCK)), /select: \{ id: true \}/);
});

test("no other module writes MemoryItem or MemoryEvidence rows", () => {
  // A new writer elsewhere must join the list above, and therefore the lock.
  const listed = execSync("git ls-files lib app scripts", { encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file));
  const writers = listed.filter((file) => {
    try {
      return new RegExp(`(?:memoryItem|memoryEvidence)\\.(?:${WRITE_VERBS})\\(`).test(readFileSync(file, "utf8"));
    } catch {
      return false;
    }
  });
  assert.deepEqual(writers.sort(), [...MEMORY_WRITER_FILES].sort());
});

test("delete-all takes the run rows before the memory lock, the order an extraction commit takes them", () => {
  const service = readFileSync("lib/memoryService.ts", "utf8");
  const start = service.indexOf("export async function deleteAllMemories(");
  const body = service.slice(start, service.indexOf("\nexport ", start + 1));
  const runs = body.indexOf("tx.memoryExtractionRun.updateMany(");
  const lock = body.indexOf("acquireUserMemoryLock(tx, userId)");
  assert.ok(runs > 0 && lock > runs, "run rows first, then the memory lock");

  const commit = readFileSync("lib/memoryExtractionCommit.ts", "utf8");
  assert.ok(commit.indexOf('FROM "MemoryExtractionRun"') < commit.indexOf("persistExtractionChunkDecisions("));
});

test("a source deletion transitions a lock-suspended memory instead of leaving it to be restored", () => {
  const service = readFileSync("lib/externalImportService.ts", "utf8");
  const start = service.indexOf("const SUSPENDABLE_MEMORY_STATUSES = [");
  const list = service.slice(start, service.indexOf("] as const;", start));
  assert.match(list, /SOURCE_LOCK_SUSPENDED_STATUS/);
});
