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
    for (const write of [
        "applySourceDeletionToMemories(",
        "markContinuationSourcesDeleted(",
        "tx.externalImport.delete(",
    ]) {
        assert.ok(snapshotLock < indexOfOrFail(body, write, "import"), `locks precede ${write}`);
    }
});
