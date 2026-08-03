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
 * When B5 generalises conversation locks (§7, §7.1), a locked source must be
 * reduced to existence metadata here — `sourceType` and nothing that
 * identifies or reaches the locked conversation. There is no lock column to
 * read yet, so this release exports the reference unconditionally; adding the
 * lock is what adds the branch, and no placeholder is pre-added (§1).
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
