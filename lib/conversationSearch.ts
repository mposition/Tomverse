import "server-only";

import type { Prisma } from "@prisma/client";

import { conversationSurface, type ConversationSurface } from "@/lib/continuationRoutes";
import {
    CONTINUATION_NAMING_BRIDGE_SELECT,
    continuationRowNaming,
    type ContinuationRowNaming,
} from "@/lib/continuationTitleContext";
import { resourceUnlockAccess } from "@/lib/conversationLock";
import {
    SEARCH_BRANCHES_PER_SOURCE_MESSAGE,
    SEARCH_CANDIDATE_ROW_LIMIT,
    SEARCH_CANDIDATES_PER_GROUP,
    escapeLikePattern,
    isStatementTimeout,
    rankSearchHits,
    type RankedSearchHit,
} from "@/lib/conversationSearchResults";
import { IMPORTED_MESSAGE_ID_PREFIX } from "@/lib/continuationTimelineMessages";
import { readOnlySnapshotTransaction } from "@/lib/readOnlySnapshotTransaction";
import { searchSnippet } from "@/lib/searchSnippet";

/**
 * Message search across a signed-in account's conversations, including the
 * stored imported transcripts its continuations are bridged to.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.2.
 *
 * ## One snapshot
 *
 * Which locked rows this viewer may not see, which rows match, and what those
 * rows say are read in one READ ONLY REPEATABLE READ transaction
 * (lib/readOnlySnapshotTransaction.ts). Read separately, a lock set between
 * the authorisation read and the candidate read would let a locked match take
 * a candidate slot -- and so decide which authorised hits come back and
 * whether the answer says more exist.
 *
 * ## Authorisation before every cap
 *
 * Grants are an HMAC over a cookie, so deciding them costs no query per row.
 * Native candidates exclude the conversations without a grant inside the
 * query; imported candidates are drawn only from the snapshots that are
 * authorised end to end (bridge, target conversation and source, each owned
 * by this account, both locks open). Scanning only authorised text also keeps
 * a locked transcript's size from deciding whether the imported read times
 * out.
 *
 * ## Candidates in the order of the answer
 *
 * The answer ranks by the target conversation's last activity. So candidates
 * are read in that order too, at most six per conversation (six, to know
 * whether a conversation has more than the five it may show), capped at
 * `SEARCH_CANDIDATE_ROW_LIMIT` rows: any hit outside those rows sits behind 31
 * conversations that each rank above it, so it could not reach the top 30.
 *
 * ## The imported half has its own time budget
 *
 * An account may hold up to 100,000 imported messages with no index on their
 * text. The imported read runs under a savepoint with the statement timeout
 * set, before every statement, to what is left of `SOURCE_SEARCH_TIMEOUT_MS`.
 * When the budget runs out, every imported hit is dropped -- nothing already
 * read is returned as if it were the answer -- and the response says
 * `sourceSearch: "timed_out"`. The limit is provisional until it is measured
 * on data near the account ceiling.
 */

/** Provisional; confirmed only after a near-ceiling measurement. */
export const SOURCE_SEARCH_TIMEOUT_MS = 3_000;

type NamedHitBase = {
    conversationId: string;
    conversationTitle: string;
    surface: ConversationSurface;
    snippet: string;
    snippetHighlight: { start: number; end: number } | null;
} & ContinuationRowNaming;

export type NativeSearchResult = NamedHitBase & {
    kind: "native";
    id: string;
    role: string;
    modelId: string | null;
};

export type ImportedSearchResult = NamedHitBase & {
    kind: "imported";
    /** `imported:<ExternalMessage.id>:<conversationId>`, unique per result. */
    id: string;
    externalMessageId: string;
    role: "user" | "assistant";
    sourceModelLabel: string | null;
};

export type ConversationSearchResult = NativeSearchResult | ImportedSearchResult;

export type ConversationSearchAnswer = {
    results: ConversationSearchResult[];
    truncated: boolean;
    sourceSearch: "ok" | "timed_out";
    /**
     * The earliest moment any unlock grant the answer rested on lapses, ISO
     * 8601; `null` when it rested on none. That covers every grant presented
     * for a locked conversation or source this account owns -- they decide
     * the hits, the caps and the imported read's time, not only the quoted
     * text -- so the screen stops showing the answer then and asks again.
     */
    validUntil: string | null;
};

/*
  The naming columns, plus the owner of each row they come from. Nothing in the
  schema makes a bridge, its conversation and its source belong to one account,
  so a malformed bridge could otherwise carry another account's source title
  into this one's results. A target whose chain is not all this account's is
  dropped, not renamed.
*/
const TARGET_SELECT = {
    id: true,
    title: true,
    continuationBridge: {
        select: {
            ...CONTINUATION_NAMING_BRIDGE_SELECT,
            userId: true,
            externalConversation: { select: { title: true, password: true, userId: true } },
        },
    },
} satisfies Prisma.ConversationSelect;

type Target = Prisma.ConversationGetPayload<{ select: typeof TARGET_SELECT }>;

type NativeDetail = {
    id: string;
    conversationId: string;
    content: string;
    role: string;
    modelId: string | null;
};

type ImportedDetail = {
    id: string;
    content: string;
    role: string;
    sourceModelLabel: string | null;
};

type Pending =
    | { kind: "native"; message: NativeDetail }
    | { kind: "imported"; message: ImportedDetail; conversationId: string };

type CandidateRow = {
    id: string;
    groupId: string;
    rank: number;
};

class SourceSearchBudgetExceeded extends Error {}

export async function searchConversationMessages(input: {
    request: Request;
    userId: string;
    query: string;
    displayTimeZone: string;
    sourceTimeoutMs?: number;
}): Promise<ConversationSearchAnswer> {
    const { request, userId, query, displayTimeZone } = input;
    const sourceTimeoutMs = input.sourceTimeoutMs ?? SOURCE_SEARCH_TIMEOUT_MS;
    const pattern = escapeLikePattern(query);

    const read = await readOnlySnapshotTransaction(
        async (tx) => {
            /* ---- 1. authorisation ------------------------------------ */
            const lockedConversations = await tx.conversation.findMany({
                where: { userId, password: { not: null } },
                select: { id: true, password: true },
            });
            /*
              Every grant this answer rests on, and the earliest of their
              expiries. Not only the grants behind the hits that are returned:
              an opened conversation or source also decides which hits made
              the cut, whether the answer says more exist, and how long the
              imported read took. When the first of them lapses, the whole
              answer stops being one this viewer may see.
            */
            let validUntilSeconds: number | null = null;
            const noteGrant = (access: { granted: boolean; expiresAt: number | null }) => {
                if (
                    access.granted &&
                    access.expiresAt !== null &&
                    (validUntilSeconds === null || access.expiresAt < validUntilSeconds)
                ) {
                    validUntilSeconds = access.expiresAt;
                }
                return access.granted;
            };
            const deniedConversationIds = lockedConversations
                .filter(
                    (row) =>
                        !noteGrant(resourceUnlockAccess("conversation", request, userId, row.id, row.password))
                )
                .map((row) => row.id);
            const denied = new Set(deniedConversationIds);

            const bridges = await tx.conversationContinuationBridge.findMany({
                where: {
                    userId,
                    externalConversationId: { not: null },
                    conversation: { userId },
                    externalConversation: { userId, finalized: true },
                },
                select: {
                    conversationId: true,
                    externalConversationId: true,
                    conversation: { select: { updatedAt: true } },
                    externalConversation: { select: { password: true } },
                },
            });
            const branchesBySnapshot = new Map<string, Array<{ conversationId: string; updatedAt: Date }>>();
            const snapshotGrant = new Map<string, boolean>();
            for (const bridge of bridges) {
                const snapshotId = bridge.externalConversationId;
                if (!snapshotId || !bridge.externalConversation) continue;
                if (denied.has(bridge.conversationId)) continue;
                if (!snapshotGrant.has(snapshotId)) {
                    snapshotGrant.set(
                        snapshotId,
                        noteGrant(
                            resourceUnlockAccess(
                                "external_conversation",
                                request,
                                userId,
                                snapshotId,
                                bridge.externalConversation.password
                            )
                        )
                    );
                }
                if (!snapshotGrant.get(snapshotId)) continue;
                const branches = branchesBySnapshot.get(snapshotId) ?? [];
                branches.push({
                    conversationId: bridge.conversationId,
                    updatedAt: bridge.conversation.updatedAt,
                });
                branchesBySnapshot.set(snapshotId, branches);
            }
            const snapshotBranches = new Map<
                string,
                { branches: Array<{ conversationId: string; updatedAt: Date }>; capped: boolean }
            >();
            for (const [snapshotId, branches] of branchesBySnapshot) {
                branches.sort(
                    (a, b) =>
                        b.updatedAt.getTime() - a.updatedAt.getTime() ||
                        (a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0)
                );
                snapshotBranches.set(snapshotId, {
                    branches: branches.slice(0, SEARCH_BRANCHES_PER_SOURCE_MESSAGE),
                    capped: branches.length > SEARCH_BRANCHES_PER_SOURCE_MESSAGE,
                });
            }
            // In the order of each snapshot's highest-ranked branch.
            const authorizedSnapshotIds = [...snapshotBranches.entries()]
                .sort(([aId, a], [bId, b]) => {
                    const top = b.branches[0].updatedAt.getTime() - a.branches[0].updatedAt.getTime();
                    if (top !== 0) return top;
                    const conv = a.branches[0].conversationId < b.branches[0].conversationId ? -1 : 1;
                    return a.branches[0].conversationId === b.branches[0].conversationId
                        ? aId < bId ? -1 : 1
                        : conv;
                })
                .map(([id]) => id);

            /* ---- 2. native candidates, then their text ---------------- */
            const nativeCandidates = await tx.$queryRaw<CandidateRow[]>`
                SELECT ranked.id, ranked."conversationId" AS "groupId", ranked.rn::int AS rank
                FROM (
                    SELECT m.id, m."conversationId", c."updatedAt" AS "conversationUpdatedAt",
                           row_number() OVER (
                               PARTITION BY m."conversationId"
                               ORDER BY m."createdAt" DESC, m.id COLLATE "C" DESC
                           ) AS rn
                    FROM "Message" m
                    JOIN "Conversation" c ON c.id = m."conversationId"
                    LEFT JOIN "ConversationContinuationBridge" b ON b."conversationId" = c.id
                    LEFT JOIN "ExternalConversation" e ON e.id = b."externalConversationId"
                    WHERE c."userId" = ${userId}
                      AND NOT (c.id = ANY(${deniedConversationIds}::text[]))
                      -- A conversation whose bridge or source is not this
                      -- account's is dropped here, before the window and the
                      -- limit, so it can neither be named nor take a slot an
                      -- authorised hit needed.
                      AND (b.id IS NULL OR (b."userId" = ${userId}
                           AND (b."externalConversationId" IS NULL OR e."userId" = ${userId})))
                      AND m.content ILIKE ${`%${pattern}%`}
                ) ranked
                WHERE ranked.rn <= ${SEARCH_CANDIDATES_PER_GROUP}
                ORDER BY ranked."conversationUpdatedAt" DESC, ranked."conversationId" COLLATE "C" ASC, ranked.rn ASC
                LIMIT ${SEARCH_CANDIDATE_ROW_LIMIT}
            `;
            const nativeMessages = nativeCandidates.length
                ? await tx.message.findMany({
                      where: {
                          id: { in: nativeCandidates.map((row) => row.id) },
                          conversation: { userId },
                      },
                      select: {
                          id: true,
                          conversationId: true,
                          content: true,
                          role: true,
                          modelId: true,
                          createdAt: true,
                      },
                  })
                : [];

            /* ---- 3. imported candidates, under the source budget ------ */
            let imported:
                | { status: "ok"; candidates: CandidateRow[]; messages: ImportedDetail[]; ordinals: Map<string, number> }
                | { status: "timed_out" } = {
                status: "ok",
                candidates: [],
                messages: [],
                ordinals: new Map(),
            };
            if (authorizedSnapshotIds.length > 0) {
                const startedAt = Date.now();
                const remaining = () => {
                    const left = sourceTimeoutMs - (Date.now() - startedAt);
                    if (left <= 0) throw new SourceSearchBudgetExceeded();
                    return left;
                };
                await tx.$executeRaw`SAVEPOINT conversation_search_source`;
                try {
                    await tx.$queryRaw`SELECT set_config('statement_timeout', ${`${remaining()}ms`}, true)`;
                    const candidates = await tx.$queryRaw<Array<CandidateRow & { ordinal: number }>>`
                        SELECT ranked.id, ranked."externalConversationId" AS "groupId",
                               ranked.rn::int AS rank, ranked.ordinal
                        FROM (
                            SELECT m.id, m."externalConversationId", m.ordinal,
                                   row_number() OVER (
                                       PARTITION BY m."externalConversationId"
                                       ORDER BY m.ordinal DESC
                                   ) AS rn
                            FROM "ExternalMessage" m
                            WHERE m."userId" = ${userId}
                              AND m."externalConversationId" = ANY(${authorizedSnapshotIds}::text[])
                              AND m.content ILIKE ${`%${pattern}%`}
                        ) ranked
                        WHERE ranked.rn <= ${SEARCH_CANDIDATES_PER_GROUP}
                        ORDER BY array_position(${authorizedSnapshotIds}::text[], ranked."externalConversationId"),
                                 ranked.rn ASC
                        LIMIT ${SEARCH_CANDIDATE_ROW_LIMIT}
                    `;
                    remaining();
                    let messages: ImportedDetail[] = [];
                    if (candidates.length > 0) {
                        await tx.$queryRaw`SELECT set_config('statement_timeout', ${`${remaining()}ms`}, true)`;
                        messages = await tx.externalMessage.findMany({
                            where: { id: { in: candidates.map((row) => row.id) }, userId },
                            select: { id: true, content: true, role: true, sourceModelLabel: true },
                        });
                        remaining();
                    }
                    // Rolled back even on success: `RELEASE` would keep the
                    // lowered statement timeout for the reads after this one,
                    // and nothing in this savepoint wrote anything to keep.
                    await tx.$executeRaw`ROLLBACK TO SAVEPOINT conversation_search_source`;
                    await tx.$executeRaw`RELEASE SAVEPOINT conversation_search_source`;
                    imported = {
                        status: "ok",
                        candidates,
                        messages,
                        ordinals: new Map(candidates.map((row) => [row.id, row.ordinal])),
                    };
                } catch (error) {
                    if (!(error instanceof SourceSearchBudgetExceeded) && !isStatementTimeout(error)) {
                        throw error;
                    }
                    // Back to before the imported read, which also restores the
                    // statement timeout, so the transaction stays usable.
                    await tx.$executeRaw`ROLLBACK TO SAVEPOINT conversation_search_source`;
                    console.warn(
                        JSON.stringify({
                            event: "conversation_search_source_timeout",
                            // Duration only: no query, id, title or count.
                            elapsedMs: Date.now() - startedAt,
                            limitMs: sourceTimeoutMs,
                        })
                    );
                    imported = { status: "timed_out" };
                }
            }

            /* ---- 4. names of every conversation a hit may open --------- */
            const targetIds = new Set<string>(nativeMessages.map((row) => row.conversationId));
            if (imported.status === "ok") {
                for (const row of imported.candidates) {
                    for (const branch of snapshotBranches.get(row.groupId)?.branches ?? []) {
                        targetIds.add(branch.conversationId);
                    }
                }
            }
            const targets = targetIds.size
                ? await tx.conversation.findMany({
                      where: { id: { in: [...targetIds] }, userId },
                      select: { ...TARGET_SELECT, updatedAt: true },
                  })
                : [];

            return {
                nativeCandidates,
                nativeMessages,
                imported,
                snapshotBranches,
                targets,
                validUntilSeconds: validUntilSeconds as number | null,
            };
        },
        { timeout: 15_000, maxWait: 5_000 }
    );

    const targets = new Map(
        read.targets
            .filter((row) => {
                const naming = row.continuationBridge;
                return (
                    !naming ||
                    (naming.userId === userId &&
                        (naming.externalConversation === null ||
                            naming.externalConversation.userId === userId))
                );
            })
            .map((row) => [row.id, row])
    );
    const hits: RankedSearchHit<Pending>[] = [];
    let droppedByCandidateCap = read.nativeCandidates.length >= SEARCH_CANDIDATE_ROW_LIMIT;

    const nativeById = new Map(read.nativeMessages.map((row) => [row.id, row]));
    for (const candidate of read.nativeCandidates) {
        const message = nativeById.get(candidate.id);
        const target = message && targets.get(message.conversationId);
        if (!message || !target) continue;
        hits.push({
            conversationId: message.conversationId,
            conversationUpdatedAt: target.updatedAt,
            kind: "native",
            recency: message.createdAt.getTime(),
            key: `native:${message.id}`,
            value: { kind: "native", message },
        });
    }

    if (read.imported.status === "ok") {
        if (read.imported.candidates.length >= SEARCH_CANDIDATE_ROW_LIMIT) droppedByCandidateCap = true;
        const importedById = new Map(read.imported.messages.map((row) => [row.id, row]));
        for (const candidate of read.imported.candidates) {
            const message = importedById.get(candidate.id);
            const snapshot = read.snapshotBranches.get(candidate.groupId);
            if (!message || !snapshot) continue;
            if (snapshot.capped) droppedByCandidateCap = true;
            for (const branch of snapshot.branches) {
                const target = targets.get(branch.conversationId);
                if (!target) continue;
                hits.push({
                    conversationId: branch.conversationId,
                    conversationUpdatedAt: target.updatedAt,
                    kind: "imported",
                    recency: read.imported.ordinals.get(message.id) ?? 0,
                    key: `imported:${message.id}:${branch.conversationId}`,
                    value: { kind: "imported", message, conversationId: branch.conversationId },
                });
            }
        }
    }

    const { results, truncated } = rankSearchHits(hits, {
        candidatesExhausted: !droppedByCandidateCap,
    });

    return {
        validUntil:
            read.validUntilSeconds === null
                ? null
                : new Date(read.validUntilSeconds * 1000).toISOString(),
        // Snippets only for what is returned: an imported turn can be long,
        // and the ranking needs none of its text.
        results: results.map((pending) => {
            const conversationId =
                pending.kind === "native" ? pending.message.conversationId : pending.conversationId;
            return toResult(pending, targets.get(conversationId) as Target, query, displayTimeZone);
        }),
        truncated,
        sourceSearch: read.imported.status,
    };
}

function toResult(
    pending: Pending,
    target: Target,
    query: string,
    displayTimeZone: string
): ConversationSearchResult {
    const snippet = searchSnippet(pending.message.content, query);
    const base = {
        conversationTitle: target.title,
        ...continuationRowNaming(target.continuationBridge, displayTimeZone),
        surface: conversationSurface({
            hasContinuationBridge: target.continuationBridge !== null,
        }),
        snippet: snippet.text,
        snippetHighlight: snippet.highlight,
    };
    if (pending.kind === "native") {
        return {
            kind: "native",
            id: pending.message.id,
            conversationId: pending.message.conversationId,
            role: pending.message.role,
            modelId: pending.message.modelId,
            ...base,
        };
    }
    return {
        kind: "imported",
        id: `${IMPORTED_MESSAGE_ID_PREFIX}${pending.message.id}:${pending.conversationId}`,
        externalMessageId: pending.message.id,
        conversationId: pending.conversationId,
        // The renderer has two shapes; anything that is not the user is the
        // other side, as in lib/continuationTimelineMessages.ts.
        role: pending.message.role === "user" ? "user" : "assistant",
        sourceModelLabel: pending.message.sourceModelLabel,
        ...base,
    };
}
