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
 * requires and what makes `productKey = "review"` unmissable.
 *
 * ## Why the product is Review
 *
 * Continuing an imported transcript is asking several models the same next
 * question with the same imported context, in one place. That is Review
 * (docs/policy/external-conversation-continuation.md §3.1). The bridge decides
 * provenance and which surface the row opens at; it does not decide the
 * product, and the product does not decide the surface -- deriving one from
 * the other would send every Review conversation to `/continuations`.
 */

import type { Prisma } from "@prisma/client";

import { APP_DEFAULTS } from "@/lib/appDefaults";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { isExternalContinuationEnabled } from "@/lib/appSettings";
import {
    effectivePlanModelLimit,
    getUserBillingPlan,
} from "@/lib/billingEntitlements";
import { REVIEW_PRODUCT_KEY } from "@/lib/conversationProduct";
import { createConversation } from "@/lib/conversationCreation";
import {
    capToPlanModelLimit,
    resolveNewConversationSelectedModels,
} from "@/lib/newConversationSelectedModels";
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
import { LEGACY_CONTINUATION_TITLE } from "@/lib/continuationDisplayTitle";
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
 * every table the source's deletion does not reach, and `Conversation.title`
 * is one of those: deleting a snapshot leaves the continuation and its
 * Tomverse messages standing, by design, so a title copied here at creation
 * would outlive the deletion request that was meant to remove it.
 *
 * Nobody sees this string. The imported conversation's name is resolved where
 * it is *displayed*, from the snapshot itself, and this constant is the
 * provenance signal that says the row has not been named by anyone --
 * `lib/continuationDisplayTitle.ts` owns both halves of that.
 */
export { LEGACY_CONTINUATION_TITLE as CONTINUATION_DEFAULT_TITLE };

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

    /*
      Resolved before the transaction opens, not inside it.

      Two reads (the account's settings and its billing plan) and a catalogue
      snapshot are not work a write transaction should be holding a row lock
      through, and none of them depend on anything the transaction does. The
      idempotent replay above returns before any of it runs, so a retried click
      does not pay for it either.
    */
    const selectedModels = await resolveInitialContinuationModels(input.userId);

    try {
        return await createContinuationRows({ ...input, selectedModels });
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

/**
 * The models a new continuation starts with.
 *
 * The account's saved new-conversation combination, exactly as a new Review
 * conversation created from `POST /api/conversations` would start
 * (docs/policy/external-conversation-continuation.md §8.3). There is no
 * continuation-specific default: a combination that means one thing on the
 * Review screen and another here is a setting the owner cannot reason about.
 *
 * The plan's ceiling truncates rather than refuses. The create route refuses a
 * body whose *explicit* model list exceeds the plan, because that request named
 * models the plan does not allow; this request names none, so refusing it would
 * make a saved combination from a since-downgraded plan block the feature
 * entirely, with nothing on this screen to change.
 */
async function resolveInitialContinuationModels(
    userId: string
): Promise<string[]> {
    const [settings, plan] = await Promise.all([
        prisma.userSettings.findUnique({
            where: { userId },
            select: { defaultModel: true, newConversationModelIds: true },
        }),
        getUserBillingPlan(userId),
    ]);
    const modelIds = await resolveNewConversationSelectedModels({
        storedNewConversationModelIds: settings?.newConversationModelIds ?? null,
        defaultModelId: settings?.defaultModel || APP_DEFAULTS.defaultModelId,
        planTier: plan.tier,
    });
    return capToPlanModelLimit(modelIds, effectivePlanModelLimit(plan));
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
    selectedModels: string[];
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
                title: LEGACY_CONTINUATION_TITLE,
                // A server constant, never a body field. Review is what the
                // user is doing here: putting the same imported context and
                // the same next question to the models they chose
                // (docs/policy/external-conversation-continuation.md §3.1).
                productKey: REVIEW_PRODUCT_KEY,
                // Not derived, and not inherited from anything. Auto is a
                // Chat-only feature (`AUTO_SELECTION_PRODUCT`), so on a Review
                // row it is absent rather than refused, and the database's
                // `Conversation_auto_only_chat_check` would refuse the pair
                // anyway.
                selectionMode: "manual",
                // The account's own new-conversation combination, resolved by
                // the same function `POST /api/conversations` uses. §8.3: no
                // continuation-specific default combination.
                selectedModels: JSON.stringify(input.selectedModels),
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
    options: {
        request: Request;
        offset?: number;
        limit?: number;
        /**
         * Read the *end* of the transcript rather than the beginning.
         *
         * The imported half is now rendered inside the conversation's own
         * timeline, so the page that has to arrive first is the one next to
         * the divider -- the turns the next answer actually follows on from.
         * Asking for it by offset is not something a client can do: the
         * offset depends on `messageTotal`, which is what this call is for.
         *
         * Ignored when `offset` is given, so paging further back stays an
         * ordinary offset walk.
         */
        fromEnd?: boolean;
    }
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

    const limit = clampTimelinePageSize(options.limit);
    const offset =
        options.offset === undefined && options.fromEnd
            ? Math.max(0, snapshot.messageCount - limit)
            : Math.max(0, options.offset ?? 0);
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

    /*
      The flag is read twice on purpose, and the second read is the one that
      decides (docs/policy/external-conversation-continuation.md §7).

      `isExternalContinuationEnabledCached()` is a per-process `Map` with a ten
      second TTL, and `invalidatePublicSnapshot` empties that Map *in the
      process that ran the admin write*. Every other instance keeps answering
      "enabled" until its own entry expires. The caller's check is therefore a
      cheap pre-filter that keeps the bridge lookup off the hot path -- it is
      not the rollback, and treating it as one meant a turn on another instance
      could still carry imported text for up to ten seconds after an operator
      turned the feature off. §2 says the source is the user's and §7 says
      switching the feature off stops the text going out; "stops it on one of
      N machines" is not that contract.

      So the row is re-read here, uncached, once we know this conversation has
      a bridge and can actually carry external text. The cost lands only on
      bridged conversations -- a small minority, already several queries deep
      into building a seed -- and never on the ordinary chat turn, which
      returned `no_bridge` above.

      The asymmetry is deliberate and is the safe one. A stale cache can delay
      turning the feature *on* by up to the TTL; it can no longer delay turning
      it *off* at all.
    */
    if (!(await isExternalContinuationEnabled())) {
        return { seed: null, outcome: "flag_off_stale_cache" };
    }

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
