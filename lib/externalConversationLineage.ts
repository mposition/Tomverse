/**
 * Lineage grouping for the external conversation viewer (policy §4.2).
 *
 * A re-import of a changed export stores a new immutable snapshot under the
 * same `externalStableId`; the viewer presents the latest snapshot of each
 * lineage first and keeps earlier ones reachable (and individually
 * deletable). Pure so the ordering rules are unit-testable.
 */

export type LineageSnapshot = {
    id: string;
    externalStableId: string;
    /** ISO 8601 — server-assigned import time. */
    importedAt: string;
};

export type LineageGroup<T extends LineageSnapshot> = {
    latest: T;
    previous: T[];
};

const bySnapshotRecency = <T extends LineageSnapshot>(left: T, right: T) => {
    const byTime = right.importedAt.localeCompare(left.importedAt);
    if (byTime !== 0) return byTime;
    // Same-instant snapshots (bulk finalize) tie-break on id so the order is
    // stable across renders and pagination reloads.
    return right.id.localeCompare(left.id);
};

/**
 * Groups snapshots by lineage, newest snapshot first inside each group,
 * groups ordered by their latest snapshot's recency. Input order does not
 * matter; pagination pages may be concatenated before grouping.
 */
export function groupConversationsByLineage<T extends LineageSnapshot>(
    rows: readonly T[]
): LineageGroup<T>[] {
    const byLineage = new Map<string, T[]>();
    for (const row of rows) {
        const group = byLineage.get(row.externalStableId);
        if (group) group.push(row);
        else byLineage.set(row.externalStableId, [row]);
    }
    const groups: LineageGroup<T>[] = [];
    for (const snapshots of byLineage.values()) {
        const ordered = [...snapshots].sort(bySnapshotRecency);
        groups.push({ latest: ordered[0], previous: ordered.slice(1) });
    }
    return groups.sort((left, right) =>
        bySnapshotRecency(left.latest, right.latest)
    );
}
