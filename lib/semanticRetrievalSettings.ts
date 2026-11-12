import "server-only";

import type { Session } from "next-auth";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import {
    SEMANTIC_RETRIEVAL_FEATURES,
    semanticRetrievalSettingKey,
    type SemanticRetrievalFeature,
} from "@/lib/semanticRetrievalCore";

/**
 * The operator's switches for semantic retrieval, set from Admin Console.
 *
 * No row means off, and an unreadable row reads as off: retrieval then stays
 * lexical and no external call is made. Each switch starts a paid call that
 * sends account memory or knowledge text to an outside provider, so turning
 * one on or off is written with its audit entry behind the audit chain lock.
 *
 * Kept out of lib/appSettings.ts for the reason lib/autoLlmRouterSettings.ts
 * gives: that file is inside the Prompt Refiner runtime source closure.
 */

export type SemanticRetrievalSwitches = Record<SemanticRetrievalFeature, boolean>;

const ALL_OFF = (): SemanticRetrievalSwitches =>
    Object.fromEntries(
        SEMANTIC_RETRIEVAL_FEATURES.map((feature) => [feature, false])
    ) as SemanticRetrievalSwitches;

/** Every switch in one read. All off when the read fails. Never throws. */
export async function readSemanticRetrievalSwitches(): Promise<SemanticRetrievalSwitches> {
    const switches = ALL_OFF();
    try {
        const rows = await prisma.appSetting.findMany({
            where: { key: { in: SEMANTIC_RETRIEVAL_FEATURES.map(semanticRetrievalSettingKey) } },
            select: { key: true, value: true },
        });
        for (const feature of SEMANTIC_RETRIEVAL_FEATURES) {
            const key = semanticRetrievalSettingKey(feature);
            switches[feature] = rows.some((row) => row.key === key && row.value.trim() === "on");
        }
    } catch {
        return ALL_OFF();
    }
    return switches;
}

/** One switch. False when off or unreadable. Never throws. */
export async function readSemanticRetrievalSwitch(
    feature: SemanticRetrievalFeature
): Promise<boolean> {
    try {
        const row = await prisma.appSetting.findUnique({
            where: { key: semanticRetrievalSettingKey(feature) },
            select: { value: true },
        });
        return row?.value.trim() === "on";
    } catch {
        return false;
    }
}

/**
 * Applies a set of switch changes, each with its audit entry, in one
 * transaction: all of them or none. Returns the features whose stored value
 * actually changed; a switch that already had the requested value is not
 * written and not audited.
 */
export async function updateSemanticRetrievalSwitches(
    actor: { session: Session; request: Request },
    changes: Partial<Record<SemanticRetrievalFeature, boolean>>
): Promise<SemanticRetrievalFeature[]> {
    const requested = SEMANTIC_RETRIEVAL_FEATURES.filter(
        (feature) => typeof changes[feature] === "boolean"
    );
    if (requested.length === 0) return [];
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const changed: SemanticRetrievalFeature[] = [];
        for (const feature of requested) {
            const key = semanticRetrievalSettingKey(feature);
            const on = changes[feature] === true;
            const before =
                (
                    await tx.appSetting.findUnique({ where: { key }, select: { value: true } })
                )?.value.trim() === "on";
            if (before === on) continue;
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
                action: "retrieval.semantic_switch.updated",
                targetType: "AppSettings",
                targetId: key,
                summary: `Turned semantic retrieval ${feature} ${on ? "on" : "off"}.`,
                metadata: { feature, before, after: on },
            });
            changed.push(feature);
        }
        return changed;
    });
}
