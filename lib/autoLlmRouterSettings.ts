import "server-only";

import type { Session } from "next-auth";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";

/**
 * Which model makes Auto's per-prompt choice (lib/autoLlmRouter.ts), set from
 * Admin Console › Routing.
 *
 * No row means off: Auto keeps its deterministic choice and makes no extra
 * call. Kept out of lib/appSettings.ts on purpose -- that file is inside the
 * Prompt Refiner runtime source closure, where a new import or function moves
 * a pinned inventory.
 */
export const AUTO_LLM_ROUTER_MODEL_SETTING_KEY = "auto.llmRouterModelId";

/** The configured model id, or null when off or unreadable. Never throws. */
export async function readAutoLlmRouterModelId(): Promise<string | null> {
    try {
        const row = await prisma.appSetting.findUnique({
            where: { key: AUTO_LLM_ROUTER_MODEL_SETTING_KEY },
            select: { value: true },
        });
        const value = row?.value.trim();
        return value ? value : null;
    } catch {
        // A routing aid must not fail the turn; unreadable reads as off.
        return null;
    }
}

/** Null turns the LLM pick off by removing the row. */
export async function writeAutoLlmRouterModelId(
    modelId: string | null
): Promise<void> {
    if (modelId === null) {
        await prisma.appSetting.deleteMany({
            where: { key: AUTO_LLM_ROUTER_MODEL_SETTING_KEY },
        });
        return;
    }
    await prisma.appSetting.upsert({
        where: { key: AUTO_LLM_ROUTER_MODEL_SETTING_KEY },
        create: { key: AUTO_LLM_ROUTER_MODEL_SETTING_KEY, value: modelId },
        update: { value: modelId },
    });
}

/**
 * Whether the router call also rewrites the message for the answering model
 * (docs/ui-contracts/prompt-refiner-suggestion.md, "Auto router rewrite").
 * No row is off. The stored user message is never changed either way.
 */
export const AUTO_LLM_ROUTER_REWRITE_SETTING_KEY = "auto.llmRouterRewrite";

/** True only for a stored "on"; unreadable reads as off. Never throws. */
export async function readAutoLlmRouterRewrite(): Promise<boolean> {
    try {
        const row = await prisma.appSetting.findUnique({
            where: { key: AUTO_LLM_ROUTER_REWRITE_SETTING_KEY },
            select: { value: true },
        });
        return row?.value.trim() === "on";
    } catch {
        return false;
    }
}

/**
 * Turns rewriting on or off together with its audit entry, behind the audit
 * chain lock: the answering model's input never changes kind without a record
 * of who changed it.
 */
export async function updateAutoLlmRouterRewrite(
    actor: { session: Session; request: Request },
    on: boolean
): Promise<void> {
    await prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const before =
            (await tx.appSetting.findUnique({
                where: { key: AUTO_LLM_ROUTER_REWRITE_SETTING_KEY },
                select: { value: true },
            }))?.value.trim() === "on";
        if (on) {
            await tx.appSetting.upsert({
                where: { key: AUTO_LLM_ROUTER_REWRITE_SETTING_KEY },
                create: { key: AUTO_LLM_ROUTER_REWRITE_SETTING_KEY, value: "on" },
                update: { value: "on" },
            });
        } else {
            await tx.appSetting.deleteMany({ where: { key: AUTO_LLM_ROUTER_REWRITE_SETTING_KEY } });
        }
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_rewrite.updated",
            targetType: "AppSettings",
            targetId: AUTO_LLM_ROUTER_REWRITE_SETTING_KEY,
            summary: on ? "Turned Auto router rewriting on." : "Turned Auto router rewriting off.",
            metadata: { before, after: on },
        });
    });
}
