import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { AUTO_LLM_ROUTER_TIMEOUT_MS } from "@/lib/autoLlmRouterCore";
import { summarizeRouterDecisions } from "@/lib/autoRouterOptimizerCore";
import { OPTIMIZER_LOCK } from "@/lib/autoRouterOptimizerLock";
import { writeAutoRouterTunableSystemAudit } from "@/lib/autoRouterOptimizerSystemAudit";
import { notifyAutoRouterTunable } from "@/lib/autoRouterTunablesAlert";
import {
    admitTunableChanges,
    applyTunableChanges,
    effectiveRouterTimeoutMs,
    revertedTimeout,
    routerOutcomeShares,
    tunableRevertDecision,
    type AdmittedTunableChange,
    type AutoRouterTunables,
    type TunableEvidence,
} from "@/lib/autoRouterTunablesCore";
import {
    AUTO_ROUTER_SETTING_AUTO_APPLY_KEY,
    AUTO_ROUTER_TUNABLES_SETTING_KEY,
    readAutoRouterTunables,
    readSettingAutoApply,
} from "@/lib/autoRouterTunablesRead";
import { prisma } from "@/lib/prisma";

/**
 * Writes of the optimizer's own setting changes (lib/autoRouterTunablesCore.ts):
 * applying what a cycle proposed, undoing a timeout that made routing worse,
 * and the operator's switch and undo in Admin › Routing. Each write commits
 * with its audit entry under the audit chain lock then the optimizer lock;
 * the operator's notice goes out after the commit (lib/autoRouterTunablesAlert.ts).
 */

const writeTunables = async (tx: Prisma.TransactionClient, value: AutoRouterTunables) => {
    // Kept while a revert's cooldown is on record, or the cooldown would be lost.
    if (!value.routerTimeoutMs && value.excluded.length === 0 && !value.timeoutRevertedAt) {
        await tx.appSetting.deleteMany({ where: { key: AUTO_ROUTER_TUNABLES_SETTING_KEY } });
        return;
    }
    const stored = JSON.stringify(value);
    await tx.appSetting.upsert({
        where: { key: AUTO_ROUTER_TUNABLES_SETTING_KEY },
        create: { key: AUTO_ROUTER_TUNABLES_SETTING_KEY, value: stored },
        update: { value: stored },
    });
};

const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Applies the changes a finished cycle proposed, when the owner's switch is
 * on and each change passes its range and evidence. The outcome -- applied,
 * refused and why, or skipped -- is kept in the cycle's summary, so Admin
 * shows it beside the report. Returns what was applied.
 */
export async function applyCycleTunableChanges(input: {
    cycleId: string;
    proposed: readonly unknown[];
    evidence: TunableEvidence;
    now?: Date;
}): Promise<AdmittedTunableChange[]> {
    if (input.proposed.length === 0) return [];
    const now = input.now ?? new Date();
    const outcome = await prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const cycle = await tx.autoRouterOptimizerCycle.findUnique({
            where: { id: input.cycleId },
            select: { summary: true },
        });
        if (!cycle) return null;
        const current = await readAutoRouterTunables(tx);
        const on = await readSettingAutoApply(tx);
        const { admitted, rejected } = on
            ? admitTunableChanges({
                  proposed: input.proposed,
                  current,
                  evidence: input.evidence,
                  codeTimeoutMs: AUTO_LLM_ROUTER_TIMEOUT_MS,
                  now: now.getTime(),
              })
            : { admitted: [], rejected: [] };
        const before = routerOutcomeShares(input.evidence.routerStats) ?? {
            decisions: 0,
            timeoutOrErrorShare: 0,
            p90LatencyMs: null,
        };
        const previousTimeoutMs = effectiveRouterTimeoutMs(current, AUTO_LLM_ROUTER_TIMEOUT_MS);
        if (admitted.length > 0) {
            await writeTunables(
                tx,
                applyTunableChanges({
                    current,
                    changes: admitted,
                    cycleId: input.cycleId,
                    now: now.getTime(),
                    codeTimeoutMs: AUTO_LLM_ROUTER_TIMEOUT_MS,
                    before,
                })
            );
            await writeAutoRouterTunableSystemAudit(tx, {
                action: "auto.llm_router_tunable.applied",
                targetId: AUTO_ROUTER_TUNABLES_SETTING_KEY,
                summary: `The Auto router optimizer changed ${admitted.length} setting(s) on its own.`,
                metadata: {
                    cycleId: input.cycleId,
                    changes: admitted.map((change) =>
                        change.setting === "routerTimeoutMs"
                            ? { setting: change.setting, from: previousTimeoutMs, to: change.value }
                            : { setting: change.setting, modelId: change.modelId, hours: change.hours }
                    ),
                },
            });
        }
        await tx.autoRouterOptimizerCycle.update({
            where: { id: input.cycleId },
            data: {
                summary: {
                    ...record(cycle.summary),
                    settingChanges: on
                        ? { applied: admitted, rejected }
                        : { applied: [], rejected: [], skipped: "auto_apply_off", proposed: input.proposed.length },
                } as Prisma.InputJsonObject,
            },
        });
        return { admitted, previousTimeoutMs };
    });
    if (!outcome) return [];
    for (const change of outcome.admitted) {
        await notifyAutoRouterTunable({
            kind: "applied",
            cycleId: input.cycleId,
            change,
            previousTimeoutMs: outcome.previousTimeoutMs,
        });
    }
    return outcome.admitted;
}

/** How many router decisions after a change the revert check reads at most. */
const REVERT_CHECK_MAX_ROWS = 2_000;

/**
 * Undoes a tuned router timeout that made routing worse since it was set
 * (tunableRevertDecision). Runs at the start of each cycle; does nothing when
 * no timeout is tuned or too few decisions came after it.
 */
export async function revertTunedTimeoutIfWorse(): Promise<"kept" | "reverted" | "waiting"> {
    const tuned = (await readAutoRouterTunables()).routerTimeoutMs;
    if (!tuned) return "kept";
    const rows = await prisma.autoRouterDecision.findMany({
        where: { createdAt: { gte: new Date(tuned.setAt) } },
        orderBy: { createdAt: "desc" },
        take: REVERT_CHECK_MAX_ROWS,
        select: { outcome: true, pickedModelId: true, ruleModelId: true, latencyMs: true },
    });
    const after = routerOutcomeShares(summarizeRouterDecisions(rows, tuned.value));
    const decision = tunableRevertDecision(tuned, after);
    if (decision !== "revert") return decision === "wait" ? "waiting" : "kept";

    const reverted = await prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const current = await readAutoRouterTunables(tx);
        // Changed meanwhile (an operator's undo, or another change): leave it.
        if (!current.routerTimeoutMs || current.routerTimeoutMs.setAt !== tuned.setAt) return false;
        await writeTunables(tx, revertedTimeout(current, Date.now()));
        await writeAutoRouterTunableSystemAudit(tx, {
            action: "auto.llm_router_tunable.reverted",
            targetId: AUTO_ROUTER_TUNABLES_SETTING_KEY,
            summary: "The Auto router optimizer undid its router timeout change: routing got worse.",
            metadata: {
                cycleId: tuned.cycleId,
                setting: "routerTimeoutMs",
                from: tuned.value,
                to: AUTO_LLM_ROUTER_TIMEOUT_MS,
                before: tuned.before,
                after,
            },
        });
        return true;
    });
    if (!reverted) return "kept";
    await notifyAutoRouterTunable({
        kind: "reverted",
        cycleId: tuned.cycleId,
        setting: "routerTimeoutMs",
        from: tuned.value,
        to: AUTO_LLM_ROUTER_TIMEOUT_MS,
        reason: `timeouts and errors rose from ${Math.round(tuned.before.timeoutOrErrorShare * 100)}% to ${Math.round((after?.timeoutOrErrorShare ?? 0) * 100)}%`,
    });
    return "reverted";
}

type AdminActor = { session: Session; request: Request };

/** The owner's switch (Admin › Routing). Off removes the row: nothing is applied. */
export async function updateSettingAutoApply(actor: AdminActor, enabled: boolean) {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const before = await readSettingAutoApply(tx);
        if (enabled) {
            const value = JSON.stringify({ enabled: true });
            await tx.appSetting.upsert({
                where: { key: AUTO_ROUTER_SETTING_AUTO_APPLY_KEY },
                create: { key: AUTO_ROUTER_SETTING_AUTO_APPLY_KEY, value },
                update: { value },
            });
        } else {
            await tx.appSetting.deleteMany({ where: { key: AUTO_ROUTER_SETTING_AUTO_APPLY_KEY } });
        }
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_setting_auto_apply.updated",
            targetType: "AppSettings",
            targetId: AUTO_ROUTER_SETTING_AUTO_APPLY_KEY,
            summary: `Turned the Auto router optimizer's setting changes ${enabled ? "on" : "off"}.`,
            metadata: { before, after: enabled },
        });
    });
}

/** An operator undoes one applied setting: the tuned timeout, or one model's exclusion. */
export async function undoTunableByOperator(
    actor: AdminActor,
    target: { setting: "routerTimeoutMs" } | { setting: "excludeModel"; modelId: string }
): Promise<{ ok: true } | { refused: "not_set" }> {
    return prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
        const current = await readAutoRouterTunables(tx);
        let next: AutoRouterTunables;
        if (target.setting === "routerTimeoutMs") {
            if (!current.routerTimeoutMs) return { refused: "not_set" as const };
            // A person's undo also starts the cooldown: they did not want it.
            next = revertedTimeout(current, Date.now());
        } else {
            if (!current.excluded.some((item) => item.modelId === target.modelId)) {
                return { refused: "not_set" as const };
            }
            next = { ...current, excluded: current.excluded.filter((item) => item.modelId !== target.modelId) };
        }
        await writeTunables(tx, next);
        await writeAdminAuditLog({
            ...actor,
            tx,
            action: "auto.llm_router_tunable.undone",
            targetType: "AppSettings",
            targetId: AUTO_ROUTER_TUNABLES_SETTING_KEY,
            summary:
                target.setting === "routerTimeoutMs"
                    ? "Undid the Auto router optimizer's router timeout change."
                    : `Put ${target.modelId} back among Auto's choices.`,
            metadata: target,
        });
        return { ok: true as const };
    });
}
