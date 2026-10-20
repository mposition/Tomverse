import "server-only";

import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AUTO_ROUTER_REC_AGENT_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";

/**
 * The coding agent's own audit entries (lib/autoRouterRecAgent.ts): a claim
 * and a reported result, each in the transaction that stores it. Kept apart
 * from the modules that call the administrator writer: one file, one writer.
 */
export const writeAutoRouterRecAgentSystemAudit = (
    tx: Prisma.TransactionClient,
    entry: {
        action: "auto.llm_router_recommendation.claimed" | "auto.llm_router_recommendation.result_recorded";
        targetId: string;
        summary: string;
        metadata: Prisma.InputJsonObject;
    }
) =>
    writeSystemAuditLog({
        tx,
        systemActor: AUTO_ROUTER_REC_AGENT_AUDIT_ACTOR,
        targetType: "AutoRouterOptimizerCycle",
        ...entry,
    });
