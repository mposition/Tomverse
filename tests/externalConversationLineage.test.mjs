import assert from "node:assert/strict";
import test from "node:test";
import { groupConversationsByLineage } from "../lib/externalConversationLineage.ts";

const snapshot = (id, externalStableId, importedAt) => ({
    id,
    externalStableId,
    importedAt,
});

test("snapshots of one lineage collapse behind the latest", () => {
    const groups = groupConversationsByLineage([
        snapshot("old", "lineage-a", "2026-07-01T00:00:00.000Z"),
        snapshot("new", "lineage-a", "2026-08-01T00:00:00.000Z"),
        snapshot("only", "lineage-b", "2026-07-15T00:00:00.000Z"),
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].latest.id, "new");
    assert.deepEqual(
        groups[0].previous.map((row) => row.id),
        ["old"]
    );
    assert.equal(groups[1].latest.id, "only");
    assert.deepEqual(groups[1].previous, []);
});

test("groups are ordered by their latest snapshot, not their oldest", () => {
    // lineage-a's oldest snapshot predates lineage-b entirely, but its
    // newest is the most recent import — it must lead the list.
    const groups = groupConversationsByLineage([
        snapshot("a-old", "lineage-a", "2026-06-01T00:00:00.000Z"),
        snapshot("b-only", "lineage-b", "2026-07-01T00:00:00.000Z"),
        snapshot("a-new", "lineage-a", "2026-08-01T00:00:00.000Z"),
    ]);
    assert.deepEqual(
        groups.map((group) => group.latest.id),
        ["a-new", "b-only"]
    );
});

test("same-instant snapshots order deterministically by id", () => {
    const at = "2026-08-01T00:00:00.000Z";
    const groups = groupConversationsByLineage([
        snapshot("aaa", "lineage-a", at),
        snapshot("zzz", "lineage-a", at),
    ]);
    assert.equal(groups[0].latest.id, "zzz");
    assert.deepEqual(
        groups[0].previous.map((row) => row.id),
        ["aaa"]
    );
});

test("input order does not matter and inputs are not mutated", () => {
    const rows = [
        snapshot("new", "lineage-a", "2026-08-01T00:00:00.000Z"),
        snapshot("old", "lineage-a", "2026-07-01T00:00:00.000Z"),
    ];
    const frozen = rows.map((row) => Object.freeze({ ...row }));
    const forward = groupConversationsByLineage(frozen);
    const reversed = groupConversationsByLineage([...frozen].reverse());
    assert.deepEqual(forward, reversed);
});
