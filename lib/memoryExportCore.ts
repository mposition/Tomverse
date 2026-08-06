/**
 * Full memory export document shape (Release B, §13.2 as settled by the
 * 2026-08-03 amendment).
 *
 * docs/policy/external-conversation-import-and-memory.md §13.2.
 *
 * Pure and dependency-free so the field allowlist is unit-testable without a
 * database: what leaves the account is decided here, in one place, by
 * construction rather than by remembering to omit things at the call site.
 *
 * Deliberately NOT exported, per §13.2:
 *   - `searchTerms` — retrieval-internal lexical terms (§9)
 *   - `importance` and any other internal score
 *   - context bundle identifiers (§10)
 *   - the *content* of an evidence source. External evidence carries a
 *     reference (which conversation, which turn) so the user can find it in
 *     their Release A export; the message text belongs to that export, not
 *     this one. Manual evidence is the exception the policy draws (§8.5):
 *     the grounds text the user typed *is* the evidence body, and returning
 *     a user their own words is the point of a data export.
 *
 * A locked source is reduced to existence metadata: `sourceType`, a flag
 * saying it is locked, and nothing that identifies or reaches the
 * conversation (§13.2). The export is a document that leaves the account, so
 * unlike the review screen — where the id only leads to a page the lock
 * itself refuses — a reference here survives outside the lock entirely. The
 * memory is still listed: the user is entitled to know a statement rests on
 * something, and that is exactly what "existence metadata" means.
 */

export const MEMORY_EXPORT_FORMAT = "tomverse.memories.v1";

export type MemoryExportEvidence =
    | { sourceType: "manual"; grounds: string }
    | {
          sourceType: "external_message";
          externalConversationId: string | null;
          ordinal: number | null;
          role: string | null;
      }
    /**
     * §13.2: a locked source, described only as existing. No conversation id,
     * no position, no role — each of those describes the thing the lock is
     * hiding, and the last two would still narrow it down for anyone holding
     * the account's Release A export.
     */
    | { sourceType: "external_message"; locked: true }
    | { sourceType: string };

export type MemoryExportItem = {
    kind: string;
    statement: string;
    status: string;
    sensitivity: string;
    confidence: number;
    pinned: boolean;
    expiresAt: string | null;
    retrievalVersion: number;
    revision: number;
    createdAt: string;
    approvedAt: string | null;
    /**
     * Null for user-authored memories. Present for extracted ones so the
     * export records which approved (model, promptVersion) pair produced the
     * statement (§12.1) — provenance, not a score.
     */
    extraction: { modelId: string; promptVersion: string } | null;
    evidence: MemoryExportEvidence[];
};

/** The row shape the serializer needs — a structural subset of MemoryItem. */
export type MemoryExportSource = {
    kind: string;
    statement: string;
    status: string;
    sensitivity: string;
    confidence: number;
    pinned: boolean;
    expiresAt: Date | null;
    retrievalVersion: number;
    revision: number;
    createdAt: Date;
    approvedAt: Date | null;
    extractionModelId: string | null;
    promptVersion: string | null;
    evidences: Array<{
        sourceType: string;
        manualContent: string | null;
        externalMessage: {
            externalConversationId: string;
            ordinal: number;
            role: string;
            /** True when the snapshot carries a lock password (§7). */
            sourceLocked: boolean;
        } | null;
    }>;
};

const serializeEvidence = (
    evidence: MemoryExportSource["evidences"][number]
): MemoryExportEvidence => {
    if (evidence.sourceType === "manual") {
        return { sourceType: "manual", grounds: evidence.manualContent ?? "" };
    }
    if (evidence.sourceType === "external_message") {
        if (evidence.externalMessage?.sourceLocked) {
            return { sourceType: "external_message", locked: true };
        }
        return {
            sourceType: "external_message",
            externalConversationId:
                evidence.externalMessage?.externalConversationId ?? null,
            ordinal: evidence.externalMessage?.ordinal ?? null,
            role: evidence.externalMessage?.role ?? null,
        };
    }
    // An unexpected source type still gets an entry: the user should see that
    // a memory rests on something, even if this release cannot describe it.
    return { sourceType: evidence.sourceType };
};

export function serializeMemoryExportItem(
    row: MemoryExportSource
): MemoryExportItem {
    return {
        kind: row.kind,
        statement: row.statement,
        status: row.status,
        sensitivity: row.sensitivity,
        confidence: row.confidence,
        pinned: row.pinned,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        retrievalVersion: row.retrievalVersion,
        revision: row.revision,
        createdAt: row.createdAt.toISOString(),
        approvedAt: row.approvedAt?.toISOString() ?? null,
        extraction:
            row.extractionModelId && row.promptVersion
                ? {
                      modelId: row.extractionModelId,
                      promptVersion: row.promptVersion,
                  }
                : null,
        evidence: row.evidences.map(serializeEvidence),
    };
}
