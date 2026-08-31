/**
 * Creating and reading a continuation bridge.
 *
 * Policy: docs/policy/external-conversation-continuation.md.
 *
 * ## The one invariant everything here serves
 *
 * The imported source is immutable and stays where it is. Nothing in this
 * module copies an `ExternalMessage` into a `Message`, and nothing writes an
 * imported model label anywhere near `Message.modelId`. What a continuation
 * creates is an ordinary Tomverse `Conversation` plus one row saying which
 * snapshot it was started from.
 *
 * ## Why the conversation and the bridge are one transaction
 *
 * A conversation with no bridge is an empty Chat the user did not ask for and
 * cannot tell apart from any other. A bridge with no conversation is
 * provenance about nothing. Both are created inside the caller's transaction
 * through `createConversation`, which is what the writer-coverage check
 * requires and what makes `productKey = "chat"` unmissable.
 */

import type { Prisma } from "@prisma/client";

import { ApiSecurityError } from "@/lib/apiSecurity";
import { CHAT_PRODUCT_KEY } from "@/lib/conversationProduct";
import { createConversation } from "@/lib/conversationCreation";
import {
    ConversationLockError,
    hasResourceUnlockGrant,
} from "@/lib/conversationLock";
import {
    CONTINUATION_SEED_VERSION,
    emptyContinuationSeedPlan,
    planContinuationSeed,
    type ContinuationSeedPlan,
} from "@/lib/externalContinuationSeedCore";
import {
    buildContinuationSeedPrompt,
    type ContinuationSeedPrompt,
} from "@/lib/externalContinuationSeedPrompt";
import type { ContinuationSeedOutcome } from "@/lib/externalContinuationMetrics";
import { prisma } from "@/lib/prisma";

/**
 * How many stored messages the seed builder reads.
 *
 * A ceiling on the *query*, not on the seed: the seed's own budget is what
 * decides how many turns are carried. This exists so a source with tens of
 * thousands of messages cannot make one chat turn read the whole table — the
 * newest window is what the seed takes anyway.
 */
const SEED_SOURCE_MESSAGE_SCAN_LIMIT = 200;

/** How many external messages one timeline page returns. */
export const CONTINUATION_TIMELINE_PAGE_SIZE = 100;
const CONTINUATION_TIMELINE_MAX_PAGE_SIZE = 200;

export const clampTimelinePageSize = (value: number | null | undefined) => {
    if (!Number.isSafeInteger(value ?? NaN)) return CONTINUATION_TIMELINE_PAGE_SIZE;
    return Math.min(Math.max(value as number, 1), CONTINUATION_TIMELINE_MAX_PAGE_SIZE);
};

/**
 * The title a continuation starts with.
 *
 * Deliberately not the source's title. §3 keeps the source's own words out of
 * the bridge, and the same reasoning applies to the conversation row: a title
 * copied from an imported conversation is imported content living in a table
 * the source's deletion does not reach. The user renames it if they want to,
 * exactly as with any other conversation.
 */
export const CONTINUATION_DEFAULT_TITLE = "Continued from an imported chat";

type OwnedSnapshot = {
    id: string;
    userId: string;
    provider: string;
    importedAt: Date;
    conversationDigest: string;
    digestVersion: number;
    messageCount: number;
    password: string | null;
    finalized: boolean;
};

/**
 * Loads the snapshot the caller may act on.
 *
 * One 404 for "does not exist", "not yours" and "not finalized", exactly as
 * `getExternalConversation` answers: a cross-account probe must not learn that
 * an id is real. The lock is a separate answer (423) because its owner is
 * being asked for a password, not told the snapshot is gone.
 *
 * The unlock grant is checked against `resourceType: "external_conversation"`.
 * A native conversation grant is a different HMAC key and a different cookie
 * name, so it cannot open this and does not need a rule saying so.
 */
async function loadUnlockedSnapshot(
    tx: Prisma.TransactionClient,
    userId: string,
    externalConversationId: string,
    request: Request
): Promise<OwnedSnapshot> {
    const row = await tx.externalConversation.findUnique({
        where: { id: externalConversationId },
        select: {
            id: true,
            userId: true,
            provider: true,
            importedAt: true,
            conversationDigest: true,
            digestVersion: true,
            messageCount: true,
            password: true,
            finalized: true,
        },
    });
    if (!row || row.userId !== userId || !row.finalized) {
        throw new ApiSecurityError(404, "NOT_FOUND", "Conversation not found.");
    }
    if (
        !hasResourceUnlockGrant(
            "external_conversation",
            request,
            userId,
            row.id,
            row.password
        )
    ) {
        throw new ConversationLockError(
            423,
            "CONVERSATION_LOCKED",
            "Conversation is locked."
        );
    }
    return row;
}

async function readSeedPlan(
    tx: Prisma.TransactionClient,
    externalConversationId: string,
    sourceMessageCount: number
): Promise<ContinuationSeedPlan> {
    const rows = await tx.externalMessage.findMany({
        where: { externalConversationId },
        orderBy: { ordinal: "desc" },
        take: SEED_SOURCE_MESSAGE_SCAN_LIMIT,
        select: { role: true, ordinal: true, content: true, truncated: true },
    });
    return planContinuationSeed({ messages: rows, sourceMessageCount });
}

export type CreatedContinuation = {
    conversationId: string;
    /** True when an earlier attempt with the same key had already created it. */
    idempotentReplay: boolean;
    provider: string;
    seedMessageCount: number;
    seedTruncatedMessageCount: number;
    seedOmittedMessageCount: number;
    sourceMessageCount: number;
};

/**
 * Starts a continuation.
 *
 * The flag is checked by the caller, not here: this function is also what the
 * tests drive, and a service that reads a global setting cannot be given one.
 *
 * Idempotency is `(userId, idempotencyKey)`. A retried click resolves to the
 * conversation the first attempt created; a second, deliberate fork carries a
 * new key and is a new conversation. The key belongs to the *request* rather
 * than to the source, which is why a replay is answered even when it names a
 * different source — answering it with a second conversation would be exactly
 * the duplicate the key exists to prevent.
 */
export async function createExternalContinuation(input: {
    userId: string;
    externalConversationId: string;
    idempotencyKey: string;
    request: Request;
}): Promise<CreatedContinuation> {
    const existing = await readContinuationByKey(
        input.userId,
        input.idempotencyKey
    );
    if (existing) {
        return { ...existing, idempotentReplay: true };
    }

    try {
        return await createContinuationRows(input);
    } catch (error) {
        /*
          Two requests with the same key raced past the read above.

          The unique index stops the second conversation from existing, which
          is the half that matters -- but a 500 is not what idempotency
          promises. "The same key returns the same result" has to hold for
          concurrent attempts too, or a browser that fired the click twice gets
          one conversation and one server error, and the user is told the thing
          that worked failed.

          So the conflict is caught and the winner's row is read back. The
          loser's whole transaction has already rolled back -- its conversation
          with it -- so there is no orphan to clean up, and the row this reads
          is the one the winner committed. Anything that is not a unique
          conflict is rethrown, and so is a conflict whose row cannot then be
          found: neither is a race, and swallowing them would hide a real
          failure behind an idempotent-looking answer.
        */
        if (!isUniqueConstraintError(error)) throw error;
        const winner = await readContinuationByKey(
            input.userId,
            input.idempotencyKey
        );
        if (!winner) throw error;
        return { ...winner, idempotentReplay: true };
    }
}

/** Prisma's unique-constraint violation, without importing its error class. */
const isUniqueConstraintError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002";

const readContinuationByKey = (userId: string, idempotencyKey: string) =>
    prisma.conversationContinuationBridge.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
        select: {
            conversationId: true,
            provider: true,
            seedMessageCount: true,
            seedTruncatedMessageCount: true,
            seedOmittedMessageCount: true,
            sourceMessageCount: true,
        },
    });

async function createContinuationRows(input: {
    userId: string;
    externalConversationId: string;
    idempotencyKey: string;
    request: Request;
}): Promise<CreatedContinuation> {
    return prisma.$transaction(async (tx) => {
        const snapshot = await loadUnlockedSnapshot(
            tx,
            input.userId,
            input.externalConversationId,
            input.request
        );
        const plan = await readSeedPlan(
            tx,
            snapshot.id,
            snapshot.messageCount
        );

        // The shared creation service, not `conversation.create`. It is what
        // writes `productKey` in the same statement as the row, so a
        // continuation can never be a conversation with no product — and it is
        // what `npm run check:conversation-writers` enforces.
        const conversation = await createConversation(
            tx,
            {
                userId: input.userId,
                title: CONTINUATION_DEFAULT_TITLE,
                // A server constant. Chat is what the user is doing here:
                // continuing one conversation with one assistant. Recording it
                // as `review` to reach a screen that exists today would make
                // the column a lie about the product, which is the one thing
                // the product-key policy forbids outright.
                productKey: CHAT_PRODUCT_KEY,
                // Not derived, and not inherited from anything: `manual` is the
                // default and Auto is a separate opt-in whose availability this
                // feature does not decide.
                selectionMode: "manual",
            },
            { id: true }
        );

        await tx.conversationContinuationBridge.create({
            data: {
                userId: input.userId,
                conversationId: conversation.id,
                externalConversationId: snapshot.id,
                provider: snapshot.provider,
                sourceImportedAt: snapshot.importedAt,
                sourceConversationDigest: snapshot.conversationDigest,
                sourceDigestVersion: snapshot.digestVersion,
                sourceMessageCount: plan.sourceMessageCount,
                seedFromOrdinal: plan.fromOrdinal,
                seedToOrdinal: plan.toOrdinal,
                seedMessageCount: plan.turns.length,
                seedTruncatedMessageCount: plan.truncatedCount,
                seedOmittedMessageCount: plan.omittedByBudgetCount,
                contextSeedVersion: plan.seedVersion,
                idempotencyKey: input.idempotencyKey,
            },
        });

        return {
            conversationId: conversation.id,
            idempotentReplay: false,
            provider: snapshot.provider,
            seedMessageCount: plan.turns.length,
            seedTruncatedMessageCount: plan.truncatedCount,
            seedOmittedMessageCount: plan.omittedByBudgetCount,
            sourceMessageCount: plan.sourceMessageCount,
        };
    });
}

/**
 * The bridge a conversation has, if any — server-scoped by `userId`.
 *
 * `userId` goes in the `where`, not into a comparison afterwards: somebody
 * else's bridge is "none", and there is no branch that could report the
 * difference.
 */
export async function getContinuationBridge(
    userId: string,
    conversationId: string
) {
    return prisma.conversationContinuationBridge.findFirst({
        where: { conversationId, userId },
        select: {
            id: true,
            conversationId: true,
            externalConversationId: true,
            provider: true,
            sourceImportedAt: true,
            sourceMessageCount: true,
            seedFromOrdinal: true,
            seedToOrdinal: true,
            seedMessageCount: true,
            seedTruncatedMessageCount: true,
            seedOmittedMessageCount: true,
            contextSeedVersion: true,
            sourceDeletedAt: true,
            createdAt: true,
        },
    });
}

export type ContinuationTimelineSourceMessage = {
    id: string;
    role: string;
    ordinal: number;
    content: string;
    sourceModelLabel: string | null;
    sourceTimestamp: string | null;
    truncated: boolean;
};

export type ContinuationTimeline = {
    conversationId: string;
    provider: string;
    importedAt: string;
    contextSeedVersion: string;
    /** Counts the screen states. Never the digest, never the storage key. */
    seed: {
        messageCount: number;
        truncatedMessageCount: number;
        omittedMessageCount: number;
        fromOrdinal: number;
        toOrdinal: number;
    };
    source:
        | {
              status: "available";
              externalConversationId: string;
              title: string;
              messageTotal: number;
              offset: number;
              limit: number;
              messages: ContinuationTimelineSourceMessage[];
          }
        // The source is gone, or is locked and this browser holds no grant.
        // Both keep the conversation readable and its own messages intact;
        // they differ only in what the screen says and in whether a password
        // brings the transcript back.
        | { status: "deleted"; deletedAt: string | null }
        | { status: "locked" };
};

/**
 * The source-backed timeline for one bridged conversation.
 *
 * Deliberately NOT merged with the conversation's `Message` rows. The two
 * halves come from different tables with different lifetimes, different
 * deletion contracts and different provenance, and a single serialised array
 * would make an imported answer indistinguishable from one Tomverse produced
 * — which is the exact confusion the whole feature is built to avoid. The
 * client renders them as two sections and the divider between them is the
 * point.
 */
export async function getContinuationTimeline(
    userId: string,
    conversationId: string,
    options: { request: Request; offset?: number; limit?: number }
): Promise<ContinuationTimeline | null> {
    const bridge = await getContinuationBridge(userId, conversationId);
    if (!bridge) return null;

    const base = {
        conversationId: bridge.conversationId,
        provider: bridge.provider,
        importedAt: bridge.sourceImportedAt.toISOString(),
        contextSeedVersion: bridge.contextSeedVersion,
        seed: {
            messageCount: bridge.seedMessageCount,
            truncatedMessageCount: bridge.seedTruncatedMessageCount,
            omittedMessageCount: bridge.seedOmittedMessageCount,
            fromOrdinal: bridge.seedFromOrdinal,
            toOrdinal: bridge.seedToOrdinal,
        },
    } as const;

    if (!bridge.externalConversationId) {
        return {
            ...base,
            source: {
                status: "deleted",
                deletedAt: bridge.sourceDeletedAt?.toISOString() ?? null,
            },
        };
    }

    const snapshot = await prisma.externalConversation.findFirst({
        where: { id: bridge.externalConversationId, userId, finalized: true },
        select: {
            id: true,
            title: true,
            messageCount: true,
            password: true,
        },
    });
    if (!snapshot) {
        // The FK still names a row this account cannot read. Treated as gone
        // rather than as an error: the owner's screen owes them the same
        // sentence either way, and the alternative is a 500 on a page whose
        // own messages are perfectly readable.
        return {
            ...base,
            source: {
                status: "deleted",
                deletedAt: bridge.sourceDeletedAt?.toISOString() ?? null,
            },
        };
    }

    if (
        !hasResourceUnlockGrant(
            "external_conversation",
            options.request,
            userId,
            snapshot.id,
            snapshot.password
        )
    ) {
        return { ...base, source: { status: "locked" } };
    }

    const offset = Math.max(0, options.offset ?? 0);
    const limit = clampTimelinePageSize(options.limit);
    const messages = await prisma.externalMessage.findMany({
        where: { externalConversationId: snapshot.id },
        orderBy: { ordinal: "asc" },
        skip: offset,
        take: limit,
        select: {
            id: true,
            role: true,
            ordinal: true,
            content: true,
            sourceModelLabel: true,
            sourceTimestamp: true,
            truncated: true,
        },
    });

    return {
        ...base,
        source: {
            status: "available",
            externalConversationId: snapshot.id,
            title: snapshot.title,
            messageTotal: snapshot.messageCount,
            offset,
            limit,
            messages: messages.map((message) => ({
                id: message.id,
                role: message.role,
                ordinal: message.ordinal,
                content: message.content,
                sourceModelLabel: message.sourceModelLabel,
                sourceTimestamp: message.sourceTimestamp?.toISOString() ?? null,
                truncated: message.truncated,
            })),
        },
    };
}

export type ContinuationTurnSeed = {
    prompt: ContinuationSeedPrompt;
    plan: ContinuationSeedPlan;
};

export type ContinuationTurnSeedResult = {
    /**
     * The excerpt, or null. One shape for every way it can be absent — no
     * bridge, source deleted, source unreadable, source locked, nothing
     * selected — because §5 is explicit that a caller must not branch on why:
     * five shapes would invite four of them to be handled and one forgotten.
     */
    seed: ContinuationTurnSeed | null;
    /**
     * Why, for observation only (§12).
     *
     * Beside the answer rather than inside it. The first version returned a
     * bare `null` and recorded nothing, which made the staging checklist's C-3
     * — re-lock the source and confirm the refusal reads `locked` —
     * unanswerable, because there was nowhere the answer existed. Control flow
     * still sees one shape; an operator sees which of the five it was.
     */
    outcome: ContinuationSeedOutcome;
};

/**
 * The seed one chat turn carries.
 *
 * The flag is the caller's check, and the caller reports `flag_off` itself:
 * this function is also what the tests drive, and a service that read a global
 * setting could not be given one.
 */
export async function loadContinuationTurnSeed(input: {
    userId: string;
    conversationId: string;
    request: Request;
}): Promise<ContinuationTurnSeedResult> {
    const bridge = await prisma.conversationContinuationBridge.findFirst({
        where: { conversationId: input.conversationId, userId: input.userId },
        select: {
            externalConversationId: true,
            provider: true,
            sourceImportedAt: true,
            sourceDeletedAt: true,
        },
    });
    if (!bridge) return { seed: null, outcome: "no_bridge" };
    if (!bridge.externalConversationId) {
        return { seed: null, outcome: "source_deleted" };
    }

    const snapshot = await prisma.externalConversation.findFirst({
        where: {
            id: bridge.externalConversationId,
            userId: input.userId,
            finalized: true,
        },
        select: { id: true, messageCount: true, password: true },
    });
    // The foreign key still names a row this account cannot read. Reported as
    // deleted rather than as its own reason: to the owner it is the same fact,
    // and a sixth outcome nobody could act on differently would only dilute
    // the four that carry a decision.
    if (!snapshot) return { seed: null, outcome: "source_deleted" };
    if (
        !hasResourceUnlockGrant(
            "external_conversation",
            input.request,
            input.userId,
            snapshot.id,
            snapshot.password
        )
    ) {
        return { seed: null, outcome: "locked" };
    }

    const plan = await readSeedPlan(prisma, snapshot.id, snapshot.messageCount);
    if (plan.turns.length === 0) {
        return { seed: null, outcome: "empty_selection" };
    }

    return {
        outcome: "seeded",
        seed: {
            plan,
            prompt: buildContinuationSeedPrompt({
                provider: bridge.provider,
                importedAt: bridge.sourceImportedAt,
                plan,
            }),
        },
    };
}

/**
 * Marks every bridge that points at these snapshots as having lost its source.
 *
 * Called by the two external deletion paths *inside their own transaction* and
 * *before* the delete, for the same reason the memory classification runs
 * there: afterwards the foreign key is already NULL and nothing records which
 * bridges were affected.
 *
 * It writes only the timestamp. `externalConversationId` is left to the
 * database's `ON DELETE SET NULL`, so the row that says "the source is gone"
 * and the row that no longer points at one can never disagree.
 */
export async function markContinuationSourcesDeleted(
    tx: Prisma.TransactionClient,
    userId: string,
    externalConversationIds: readonly string[],
    now = new Date()
): Promise<number> {
    if (externalConversationIds.length === 0) return 0;
    const result = await tx.conversationContinuationBridge.updateMany({
        where: {
            userId,
            externalConversationId: { in: [...externalConversationIds] },
            sourceDeletedAt: null,
        },
        data: { sourceDeletedAt: now },
    });
    return result.count;
}

export { CONTINUATION_SEED_VERSION, emptyContinuationSeedPlan };
