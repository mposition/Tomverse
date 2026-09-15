import assert from "node:assert/strict";
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

test("every memory writer uses the one lock function, never its own key string", () => {
    const helper = readFileSync("lib/memoryItemLock.ts", "utf8");
    assert.match(helper, /hashtext\(\$\{"memory-items:" \+ userId\}\)/);
    for (const path of [
        "lib/memoryService.ts",
        "lib/memoryExtractionPersistence.ts",
        "lib/externalImportService.ts",
    ]) {
        const code = readFileSync(path, "utf8");
        assert.match(code, /lockAccountMemoryItems\(/, path);
        assert.doesNotMatch(code, /"memory-items:"/, `${path} must not spell the key itself`);
    }
    // The persistence step still takes it before its first memory read.
    const persistence = readFileSync("lib/memoryExtractionPersistence.ts", "utf8");
    assert.ok(
        persistence.indexOf("await lockAccountMemoryItems(tx, input.userId)") <
            persistence.indexOf("tx.memoryItem.deleteMany(")
    );
});
