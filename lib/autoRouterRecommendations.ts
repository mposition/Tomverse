import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { OPTIMIZER_LOCK } from "@/lib/autoRouterOptimizer";
import {
    actionableRecommendations,
    withRecommendationStatus,
    type RecommendationStatus,
} from "@/lib/autoRouterRecommendationsCore";
import { readRecAgentEnabled } from "@/lib/autoRouterRecAgent";
import { AUTO_ROUTER_REC_AGENT_SETTING_KEY } from "@/lib/autoRouterRecAgentCore";
import { prisma } from "@/lib/prisma";

/**
 * Sets the status of one of a cycle's code or setting recommendations (Admin ›
 * Routing). The status is stored in the cycle's summary JSON, and the change
 * and its audit entry commit together, so a status never changes without a
 * record of who changed it. Nothing is sent anywhere.
 *
 * Locks in the order the optimizer's other writes take them: the audit chain,
 * then the optimizer lock, which also keeps this read-modify-write of the
 * summary apart from a cycle finishing.
 */
export async function setRecommendationStatus(
    actor: { session: Session; request: Request },
    input: { cycleId: string; index: number; status: RecommendationStatus }
): Promise<
    | { ok: true; changed: boolean }
    | { refused: "not_found" | "no_such_recommendation" }
> {
    const by = actor.session.user?.id;
    if (!by) return { refused: "not_found" };
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const cycle = await tx.autoRouterOptimizerCycle.findUnique({
            where: { id: input.cycleId },
            select: { status: true, summary: true },
        });
        // A running cycle has not written its report yet, and a rewrite cycle
        // never writes one, so neither has a recommendation to mark.
        if (!cycle || cycle.status === "running") {
            return { refused: "not_found" as const };
        }
        const recommendation = actionableRecommendations(cycle.summary).find((item) => item.index === input.index);
        if (!recommendation) return { refused: "no_such_recommendation" as const };
        // The same status again changes nothing and leaves no audit entry.
        if (recommendation.status === input.status) return { ok: true as const, changed: false };

        const at = new Date().toISOString();
        await tx.autoRouterOptimizerCycle.update({
            where: { id: input.cycleId },
            data: {
                summary: withRecommendationStatus(cycle.summary, input.index, {
                    status: input.status,
                    at,
                    by,
                }) as Prisma.InputJsonObject,
            },
        });
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_recommendation.status_changed",
            targetType: "AutoRouterOptimizerCycle",
            targetId: input.cycleId,
            summary: `Marked an Auto router optimizer recommendation ${input.status}.`,
            // The recommendation's text stays out of the audit chain: its place
            // and kind identify it in the cycle.
            metadata: {
                index: input.index,
                kind: recommendation.kind,
                before: recommendation.status,
                after: input.status,
            },
        });
        return { ok: true as const, changed: true };
    });
}

/**
 * The owner's switch for the coding agent on the Ubuntu runner (Admin ›
 * Routing). Off removes the row, so the agent's claim answers 204. The change
 * and its audit entry commit together.
 */
export async function updateRecAgentSwitch(actor: { session: Session; request: Request }, enabled: boolean) {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const before = await readRecAgentEnabled(tx);
        if (enabled) {
            const value = JSON.stringify({ enabled: true });
            await tx.appSetting.upsert({
                where: { key: AUTO_ROUTER_REC_AGENT_SETTING_KEY },
                create: { key: AUTO_ROUTER_REC_AGENT_SETTING_KEY, value },
                update: { value },
            });
        } else {
            await tx.appSetting.deleteMany({ where: { key: AUTO_ROUTER_REC_AGENT_SETTING_KEY } });
        }
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_rec_agent.updated",
            targetType: "AppSettings",
            targetId: AUTO_ROUTER_REC_AGENT_SETTING_KEY,
            summary: `Turned the Auto router coding agent ${enabled ? "on" : "off"}.`,
            metadata: { before, after: enabled },
        });
    });
}
