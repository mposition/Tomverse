import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { takeAuditChainLock } from "@/lib/adminAudit";
import { adminAutoRouterOptimizerMessages } from "@/lib/adminMessages/autoRouterOptimizer";
import { OPTIMIZER_LOCK } from "@/lib/autoRouterOptimizer";
import {
    AUTO_ROUTER_REC_AGENT_SETTING_KEY,
    parseRecAgentSwitch,
    REC_AGENT_CLAIM_WINDOW_CYCLES,
} from "@/lib/autoRouterRecAgentCore";
import { writeAutoRouterRecAgentSystemAudit } from "@/lib/autoRouterRecAgentSystemAudit";
import {
    actionableRecommendations,
    buildRecommendationInstruction,
    nextClaimableRecommendation,
    recommendationResultDecision,
    recommendationStatusEntries,
    reportFindings,
    REC_AGENT_LEASE_MS,
    withRecommendationStatus,
    type RecommendationResultInput,
} from "@/lib/autoRouterRecommendationsCore";
import { prisma } from "@/lib/prisma";

/**
 * The app side of the coding agent on the Ubuntu runner (tools/auto-rec-agent).
 * Owner approval 2026-10-20: the agent may open develop PRs on its own;
 * merging them stays a person's, and nothing here merges or applies a patch.
 *
 * A claim and a result each change one recommendation's status in its cycle's
 * summary JSON (lib/autoRouterRecommendationsCore.ts) and write the agent's
 * system audit entry in the same transaction, under the locks every other
 * write of that summary takes: the audit chain, then the optimizer lock.
 */

const AGENT_BY = "auto-router-rec-agent";

export async function readRecAgentEnabled(
    db: Pick<Prisma.TransactionClient, "appSetting"> = prisma
): Promise<boolean> {
    try {
        const row = await db.appSetting.findUnique({
            where: { key: AUTO_ROUTER_REC_AGENT_SETTING_KEY },
            select: { value: true },
        });
        return parseRecAgentSwitch(row?.value);
    } catch {
        return false;
    }
}

export type ClaimedRecommendation = {
    /** `<cycleId>:<index>`, what the result names. */
    id: string;
    cycleId: string;
    index: number;
    recommendation: string;
    findings: string[];
    instruction: string;
    leaseUntil: string;
    /** What the result must name: a late result of an earlier claim never lands on this one. */
    claimId: string;
};

export const recommendationId = (cycleId: string, index: number) => `${cycleId}:${index}`;

export const parseRecommendationId = (id: string): { cycleId: string; index: number } | null => {
    const match = /^([A-Za-z0-9_-]{1,64}):(\d{1,2})$/.exec(id);
    return match ? { cycleId: match[1], index: Number(match[2]) } : null;
};

/**
 * Takes the oldest open code recommendation, or answers null when the switch
 * is off or nothing is open. `origin` is where Admin is, for the link in the
 * instruction.
 */
export async function claimNextRecommendation(input: {
    origin: string;
    now?: Date;
}): Promise<ClaimedRecommendation | null> {
    const now = input.now ?? new Date();
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        if (!(await readRecAgentEnabled(tx))) return null;
        const cycles = await tx.autoRouterOptimizerCycle.findMany({
            where: { status: { not: "running" } },
            orderBy: { createdAt: "desc" },
            take: REC_AGENT_CLAIM_WINDOW_CYCLES,
            select: { id: true, createdAt: true, summary: true },
        });
        const next = nextClaimableRecommendation(
            cycles.map((cycle) => ({ ...cycle, createdAt: cycle.createdAt.toISOString() })),
            now.getTime()
        );
        if (!next) return null;
        const cycle = cycles.find((item) => item.id === next.cycleId);
        if (!cycle) return null;

        const leaseUntil = new Date(now.getTime() + REC_AGENT_LEASE_MS).toISOString();
        const claimId = randomUUID();
        await tx.autoRouterOptimizerCycle.update({
            where: { id: next.cycleId },
            data: {
                summary: withRecommendationStatus(cycle.summary, next.index, {
                    status: "claimed",
                    at: now.toISOString(),
                    by: AGENT_BY,
                    leaseUntil,
                    claimId,
                }) as Prisma.InputJsonObject,
            },
        });
        await writeAutoRouterRecAgentSystemAudit(tx, {
            action: "auto.llm_router_recommendation.claimed",
            targetId: next.cycleId,
            summary: "The coding agent took an Auto router optimizer code recommendation.",
            // Its place identifies it in the cycle; its text stays out of the chain.
            metadata: { index: next.index, leaseUntil, claimId },
        });
        const findings = reportFindings(cycle.summary);
        return {
            id: recommendationId(next.cycleId, next.index),
            cycleId: next.cycleId,
            index: next.index,
            recommendation: next.text,
            findings,
            instruction: buildRecommendationInstruction({
                labels: adminAutoRouterOptimizerMessages.en.instruction,
                recommendation: { kind: next.kind, text: next.text },
                findings,
                cycle: { id: next.cycleId, createdAt: next.createdAt },
                link: `${input.origin}/admin/routing#optimizer-cycle-${next.cycleId}`,
            }),
            leaseUntil,
            claimId,
        };
    });
}

/**
 * Stores the agent's result on its claim. A replay of the same result changes
 * nothing; a result for a recommendation that is no longer claimed is refused,
 * so an operator's reopen or close is never overwritten.
 */
export async function recordRecommendationResult(input: {
    cycleId: string;
    index: number;
    result: RecommendationResultInput;
    now?: Date;
}): Promise<{ ok: true; changed: boolean } | { refused: "not_found" | "not_claimed" }> {
    const now = input.now ?? new Date();
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const cycle = await tx.autoRouterOptimizerCycle.findUnique({
            where: { id: input.cycleId },
            select: { summary: true },
        });
        if (!cycle) return { refused: "not_found" as const };
        const recommendation = actionableRecommendations(cycle.summary, now.getTime()).find(
            (item) => item.index === input.index && item.kind === "code"
        );
        if (!recommendation) return { refused: "not_found" as const };
        const decision = recommendationResultDecision(
            recommendationStatusEntries(cycle.summary).get(input.index),
            input.result
        );
        if (decision === "not_claimed") return { refused: "not_claimed" as const };
        if (decision === "replay") return { ok: true as const, changed: false };

        await tx.autoRouterOptimizerCycle.update({
            where: { id: input.cycleId },
            data: {
                summary: withRecommendationStatus(cycle.summary, input.index, {
                    status: input.result.outcome,
                    at: now.toISOString(),
                    by: AGENT_BY,
                    claimId: input.result.claimId,
                    ...(input.result.outcome === "pr_opened"
                        ? { prUrl: input.result.prUrl }
                        : { reason: input.result.reason }),
                }) as Prisma.InputJsonObject,
            },
        });
        await writeAutoRouterRecAgentSystemAudit(tx, {
            action: "auto.llm_router_recommendation.result_recorded",
            targetId: input.cycleId,
            summary:
                input.result.outcome === "pr_opened"
                    ? "The coding agent opened a develop PR for an Auto router optimizer recommendation."
                    : "The coding agent did not open a PR for an Auto router optimizer recommendation.",
            metadata: {
                index: input.index,
                claimId: input.result.claimId,
                outcome: input.result.outcome,
                ...(input.result.outcome === "pr_opened"
                    ? { prUrl: input.result.prUrl }
                    : { reason: input.result.reason }),
            },
        });
        return { ok: true as const, changed: true };
    });
}
