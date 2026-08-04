import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
    bundleConsumptionKey,
    issueContextBundle,
    verifyContextBundle,
    type ContextBundleVerification,
} from "@/lib/chatContextBundleCore";
import type { ChatMemoryContext } from "@/lib/chatMemoryContext";
import { ChatAccessError } from "@/lib/chatSecurity";
import { prisma } from "@/lib/prisma";

/**
 * The durable half of the §10 nonce contract.
 *
 * `bundleConsumptionKey()` decided what is counted; this is where the count
 * is actually enforced, and it has to be durable rather than in-process: a
 * bundle replayed against a second instance must be refused there too, and
 * the database is the only thing the instances share.
 *
 * The insert IS the check. A read-then-write would let two concurrent
 * requests presenting the same (bundle, model) both pass the SELECT and both
 * proceed — which is the exact double-spend the nonce exists to stop. Here
 * one INSERT wins and the other violates the unique index, so the loser is
 * identified by the database rather than by timing.
 *
 * Consumption is deliberately NOT rolled back when the request that claimed
 * it then fails. A bundle attests a context snapshot that was priced; a
 * failed request does not make that snapshot re-usable, and a retry is
 * supposed to re-preflight (§10) rather than replay. Handing the nonce back
 * would turn every provider error into a replay window.
 */

/**
 * How long a priced context stays valid.
 *
 * The gap this has to cover is one round trip — the client preflights and
 * sends — so anything longer only widens the window in which the priced
 * context can drift from the sent one. Long enough that a slow network or a
 * user who hesitates over the send button is not punished; short enough that
 * a captured bundle is worthless by the time it could be replayed, on top of
 * the nonce that already refuses the replay outright.
 */
export const CONTEXT_BUNDLE_TTL_MS = 5 * 60 * 1000;

/**
 * The same secret that signs admission tokens, under a different domain
 * (§10). Sharing the secret is fine and separating the domains is what makes
 * it fine: `chatContextBundleCore` prefixes its own, so neither token can
 * ever verify as the other.
 */
const bundleSecret = () => {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
        throw new ChatAccessError(
            503,
            "SECURITY_NOT_CONFIGURED",
            "Chat security is not configured."
        );
    }
    return secret;
};

export type IssuedContextBundle = {
    token: string;
    bundleId: string;
    expiresAt: string;
    /** Server-computed, for the §13.4 disclosure. Never a client claim. */
    memoryUsedCount: number;
    memoryTokens: number;
};

/**
 * Issued by whichever path priced the request — the comparison preflight or
 * the single-model context preparation. Both hand the same shape back, so the
 * chat route has one thing to verify however the request was prepared.
 *
 * A comparison's panels share one bundle: `modelIds` carries the whole set,
 * and consumption is per (bundle, model) so each panel still spends its own.
 */
export function issueChatContextBundle(input: {
    subjectKey: string;
    conversationId: string | null;
    modelIds: string[];
    context: ChatMemoryContext;
    now?: Date;
}): IssuedContextBundle {
    const now = input.now ?? new Date();
    const expiresAtMs = now.getTime() + CONTEXT_BUNDLE_TTL_MS;
    const bundleId = randomUUID();
    const token = issueContextBundle(
        {
            version: 1,
            bundleId,
            subjectKey: input.subjectKey,
            conversationId: input.conversationId,
            modelIds: input.modelIds,
            memoryTokens: input.context.memoryTokens,
            expiresAtMs,
            ...input.context.fingerprintInput,
        },
        bundleSecret()
    );
    return {
        token,
        bundleId,
        expiresAt: new Date(expiresAtMs).toISOString(),
        memoryUsedCount: input.context.prompt.usedCount,
        memoryTokens: input.context.memoryTokens,
    };
}

/**
 * Verification against the context the request is *about to* build, which is
 * the whole point: passing `currentFingerprint` turns a signature check into
 * a freshness check (§10).
 */
export function verifyChatContextBundle(
    token: string,
    options: {
        subjectKey: string;
        conversationId: string | null;
        modelId: string;
        currentFingerprint: string;
        now?: Date;
    }
): ContextBundleVerification {
    return verifyContextBundle(token, {
        secret: bundleSecret(),
        subjectKey: options.subjectKey,
        conversationId: options.conversationId,
        modelId: options.modelId,
        currentFingerprint: options.currentFingerprint,
        now: options.now,
    });
}

export type ContextBundleConsumption =
    | { consumed: true }
    | { consumed: false; reason: "already_consumed" };

export async function consumeContextBundle(input: {
    bundleId: string;
    modelId: string;
    userId: string;
    /** The bundle's own expiry, so cleanup never decodes a token. */
    expiresAt: Date;
}): Promise<ContextBundleConsumption> {
    try {
        await prisma.chatContextBundleConsumption.create({
            data: {
                consumptionKey: bundleConsumptionKey(
                    input.bundleId,
                    input.modelId
                ),
                bundleId: input.bundleId,
                modelId: input.modelId,
                userId: input.userId,
                expiresAt: input.expiresAt,
            },
        });
        return { consumed: true };
    } catch (error) {
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
        ) {
            return { consumed: false, reason: "already_consumed" };
        }
        throw error;
    }
}

/**
 * Rows outlive their usefulness the moment the bundle they name expires: a
 * bundle past its expiry is refused by `verifyContextBundle` before
 * consumption is ever consulted, so keeping the row proves nothing.
 *
 * Run from the maintenance job rather than opportunistically on the request
 * path — a chat request should not pay for housekeeping, and a delete racing
 * a claim is exactly the kind of thing that makes a nonce table flaky.
 */
export async function deleteExpiredContextBundleConsumptions(
    now: Date = new Date()
): Promise<number> {
    const result = await prisma.chatContextBundleConsumption.deleteMany({
        where: { expiresAt: { lt: now } },
    });
    return result.count;
}
