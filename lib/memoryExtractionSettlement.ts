import "server-only";

import { settleChatUsage } from "@/lib/chatSecurity";
import { prisma } from "@/lib/prisma";

/**
 * Settlement for one extraction attempt (Release B, slice 1.6b).
 *
 * docs/policy/external-conversation-import-and-memory.md §11.
 *
 * The rule this module exists to hold: **the right to commit candidates and
 * the duty to record cost are different things, bound to different
 * identities.**
 *
 * A worker that lost its lease must not write candidates or advance the run —
 * something else owns that work now. But if it already called a provider, the
 * money was really spent, and refusing to settle would leave that cost absent
 * from the user's balance and from the provider budget alike. So settlement
 * binds to the durable attempt and its reservation, which no lease change can
 * invalidate, while committing binds to the fencing token.
 *
 * Settlement itself is not reimplemented here. `settleChatUsage` reads the
 * durable reservation row and only needs its id and owner from the caller, so
 * extraction settles through exactly the same code chat does — which is the
 * point of the §9 seam.
 */

export type ExtractionSettlementReason =
    | "completed"
    | "cancelled"
    | "failed"
    | "empty";

export type ExtractionAttemptUsage = {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    /** False when the provider returned no usage metadata. */
    usageFromProvider: boolean;
};

const loadAttempt = async (attemptId: string) =>
    prisma.memoryExtractionAttempt.findUnique({
        where: { id: attemptId },
        select: {
            id: true,
            status: true,
            reservationId: true,
            providerCallIssued: true,
            settledAt: true,
            chunk: { select: { run: { select: { userId: true } } } },
        },
    });

/**
 * Releases an attempt's reservation in full, for a failure or cancellation
 * that happened **before** any provider call.
 *
 * Nothing was spent, so nothing is charged. Settled as `cancelled` with no
 * usage, which is how the shared ledger returns reserved credits and provider
 * budget.
 */
export async function releaseUnusedExtractionAttempt(input: {
    attemptId: string;
    reason: "cancelled" | "failed_before_call";
}): Promise<{ released: boolean }> {
    const attempt = await loadAttempt(input.attemptId);
    if (!attempt?.reservationId) return { released: false };
    if (attempt.providerCallIssued) {
        // A call did go out: releasing in full here would erase a real cost.
        // The caller wants settleExtractionAttempt instead.
        return { released: false };
    }

    await settleChatUsage(
        {
            reservationId: attempt.reservationId,
            userId: attempt.chunk.run.userId,
        } as Parameters<typeof settleChatUsage>[0],
        { outcome: "cancelled" },
        { reason: input.reason }
    );
    await prisma.memoryExtractionAttempt.update({
        where: { id: attempt.id },
        data: {
            status:
                input.reason === "cancelled" ? "cancelled" : "failed_before_call",
            settledAt: new Date(),
        },
    });
    return { released: true };
}

/**
 * Settles an attempt that reached a provider.
 *
 * `commitAllowed` is the caller's fencing verdict, and it changes only what
 * the attempt *becomes* — never whether it is settled. A stale worker still
 * pays for what it used; its candidates are what get thrown away, recorded as
 * `discarded_stale` so the discard is visible rather than silent.
 *
 * When the provider reported no usage, the reservation stands as the charge.
 * Settling a call that happened as if it were free would understate both the
 * user's spend and the provider budget, and the conservative direction is the
 * only safe one when the truth is unknown.
 */
export async function settleExtractionAttempt(input: {
    attemptId: string;
    usage: ExtractionAttemptUsage;
    outcome: ExtractionSettlementReason;
    /** False when the worker was fenced out after the call. */
    commitAllowed: boolean;
}): Promise<{ settled: boolean; status: string }> {
    const attempt = await loadAttempt(input.attemptId);
    if (!attempt?.reservationId) return { settled: false, status: "unknown" };
    if (attempt.settledAt) {
        // Idempotent: a replayed settlement must not charge twice.
        return { settled: false, status: attempt.status };
    }

    await settleChatUsage(
        {
            reservationId: attempt.reservationId,
            userId: attempt.chunk.run.userId,
        } as Parameters<typeof settleChatUsage>[0],
        {
            inputTokens: input.usage.inputTokens,
            cachedInputTokens: input.usage.cachedInputTokens,
            outputTokens: input.usage.outputTokens,
            reasoningTokens: input.usage.reasoningTokens,
            usageFromProvider: input.usage.usageFromProvider,
            outcome: input.outcome,
        },
        { reason: "memory_extraction_attempt" }
    );

    const status = !input.commitAllowed
        ? "discarded_stale"
        : input.outcome === "completed"
          ? "committed"
          : "failed_after_call";
    await prisma.memoryExtractionAttempt.update({
        where: { id: attempt.id },
        data: { status, usageConfirmed: input.usage.usageFromProvider, settledAt: new Date() },
    });
    return { settled: true, status };
}

/**
 * Releases every attempt of a run that never reached a provider.
 *
 * The cancellation half of §11's partial-run rule: work already done is
 * settled on its own terms and stays settled, while work that was reserved
 * and never performed gives its money back.
 */
export async function releaseUnusedExtractionAttemptsForRun(
    runId: string
): Promise<{ released: number }> {
    const pending = await prisma.memoryExtractionAttempt.findMany({
        where: {
            chunk: { runId },
            settledAt: null,
            providerCallIssued: false,
            status: { in: ["planned", "reserved"] },
        },
        select: { id: true },
    });
    let released = 0;
    for (const attempt of pending) {
        const result = await releaseUnusedExtractionAttempt({
            attemptId: attempt.id,
            reason: "cancelled",
        }).catch(() => ({ released: false }));
        if (result.released) released += 1;
    }
    return { released };
}
