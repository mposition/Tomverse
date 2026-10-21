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

/**
 * Sets the router model (null turns the LLM pick off by removing the row)
 * together with its audit entry, behind the audit chain lock: Auto never
 * starts or stops a paid call without a record of who changed it. False when
 * the stored value already was `modelId`; nothing is written then.
 */
export async function updateAutoLlmRouterModelId(
    actor: { session: Session; request: Request },
    modelId: string | null
): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const before =
            (await tx.appSetting.findUnique({
                where: { key: AUTO_LLM_ROUTER_MODEL_SETTING_KEY },
                select: { value: true },
            }))?.value.trim() || null;
        if (before === modelId) return false;
        if (modelId === null) {
            await tx.appSetting.deleteMany({ where: { key: AUTO_LLM_ROUTER_MODEL_SETTING_KEY } });
        } else {
            await tx.appSetting.upsert({
                where: { key: AUTO_LLM_ROUTER_MODEL_SETTING_KEY },
                create: { key: AUTO_LLM_ROUTER_MODEL_SETTING_KEY, value: modelId },
                update: { value: modelId },
            });
        }
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_model.updated",
            targetType: "AppSettings",
            targetId: AUTO_LLM_ROUTER_MODEL_SETTING_KEY,
            summary: modelId
                ? `Set the Auto LLM router model to ${modelId}.`
                : "Turned the Auto LLM router off.",
            metadata: { before, after: modelId },
        });
        return true;
    });
}

/**
 * Whether the router call also rewrites the message for the answering model
 * (docs/ui-contracts/prompt-refiner-suggestion.md, "Auto router rewrite").
 * No row is off. The stored user message is never changed either way.
 */
export const AUTO_LLM_ROUTER_REWRITE_SETTING_KEY = "auto.llmRouterRewrite";

/** True only for a stored "on"; unreadable reads as off. Never throws. */
async function readOnSetting(key: string): Promise<boolean> {
    try {
        const row = await prisma.appSetting.findUnique({
            where: { key },
            select: { value: true },
        });
        return row?.value.trim() === "on";
    } catch {
        return false;
    }
}

/**
 * Stores an on/off router setting (no row is off) together with its audit
 * entry, behind the audit chain lock.
 */
async function writeOnSetting(
    actor: { session: Session; request: Request },
    key: string,
    on: boolean,
    audit: { action: string; summaryOn: string; summaryOff: string }
): Promise<void> {
    await prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const before =
            (await tx.appSetting.findUnique({ where: { key }, select: { value: true } }))?.value.trim() ===
            "on";
        if (on) {
            await tx.appSetting.upsert({
                where: { key },
                create: { key, value: "on" },
                update: { value: "on" },
            });
        } else {
            await tx.appSetting.deleteMany({ where: { key } });
        }
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: audit.action,
            targetType: "AppSettings",
            targetId: key,
            summary: on ? audit.summaryOn : audit.summaryOff,
            metadata: { before, after: on },
        });
    });
}

export const readAutoLlmRouterRewrite = () => readOnSetting(AUTO_LLM_ROUTER_REWRITE_SETTING_KEY);

/**
 * Turns rewriting on or off together with its audit entry: the answering
 * model's input never changes kind without a record of who changed it.
 */
export const updateAutoLlmRouterRewrite = (
    actor: { session: Session; request: Request },
    on: boolean
) =>
    writeOnSetting(actor, AUTO_LLM_ROUTER_REWRITE_SETTING_KEY, on, {
        action: "auto.llm_router_rewrite.updated",
        summaryOn: "Turned Auto router rewriting on.",
        summaryOff: "Turned Auto router rewriting off.",
    });

/**
 * Whether the router model also triages chat image requests
 * (lib/chatImageIntent.ts): one more paid call per eligible chat send, so it
 * has its own switch beside the router model. No row is off.
 */
export const AUTO_LLM_ROUTER_IMAGE_TRIAGE_SETTING_KEY = "auto.llmRouterImageTriage";

export const readAutoLlmRouterImageTriage = () =>
    readOnSetting(AUTO_LLM_ROUTER_IMAGE_TRIAGE_SETTING_KEY);

/** Turns image triage on or off; the paid call never starts unrecorded. */
export const updateAutoLlmRouterImageTriage = (
    actor: { session: Session; request: Request },
    on: boolean
) =>
    writeOnSetting(actor, AUTO_LLM_ROUTER_IMAGE_TRIAGE_SETTING_KEY, on, {
        action: "auto.llm_router_image_triage.updated",
        summaryOn: "Turned Auto router image triage on.",
        summaryOff: "Turned Auto router image triage off.",
    });
