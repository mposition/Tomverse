import "server-only";

import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AUTO_ROUTER_OPTIMIZER_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";

/**
 * The Auto router optimizer's own audit entries, for the steps its owner let
 * it take without a click (lib/autoRouterOptimizer.ts and
 * lib/autoRewriteOptimizer.ts automation). Kept apart from the modules that
 * call the administrator writer: one file, one writer.
 */
/** Its own setting changes (lib/autoRouterTunablesCore.ts), on the settings row. */
export const writeAutoRouterTunableSystemAudit = (
    tx: Prisma.TransactionClient,
    entry: {
        action: "auto.llm_router_tunable.applied" | "auto.llm_router_tunable.reverted";
        targetId: string;
        summary: string;
        metadata: Prisma.InputJsonObject;
    }
) =>
    writeSystemAuditLog({
        tx,
        systemActor: AUTO_ROUTER_OPTIMIZER_AUDIT_ACTOR,
        targetType: "AppSettings",
        ...entry,
    });

export const writeAutoRouterOptimizerSystemAudit = (
    tx: Prisma.TransactionClient,
    entry: {
        action:
            | "auto.llm_router_optimizer.cycle_started"
            | "auto.llm_router_guidance.promoted"
            | "auto.llm_router_rewrite_guidance.promoted";
        targetId: string;
        summary: string;
        metadata: Prisma.InputJsonObject;
    }
) =>
    writeSystemAuditLog({
        tx,
        systemActor: AUTO_ROUTER_OPTIMIZER_AUDIT_ACTOR,
        targetType: "AutoRouterOptimizerCycle",
        ...entry,
    });
