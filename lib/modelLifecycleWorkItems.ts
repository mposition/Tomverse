import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
    OPEN_WORK_ITEM_STATUSES,
    newCandidatesForQueue,
    workItemTimestampField,
    workItemTransitionRefusal,
    type WorkItemStatus,
    type WorkItemTransitionRefusal,
} from "@/lib/modelLifecycleWorkItemCore";

/**
 * The database boundary around the model lifecycle queue. The decisions live in
 * lib/modelLifecycleWorkItemCore.ts; this module does I/O and nothing else.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §9.
 */

/**
 * Creates work items for models the catalogue does not serve and the queue does
 * not already hold.
 *
 * Fed from the scan's full `candidates` set, deliberately, not from
 * `newCandidates`. That second array is empty on every run after the first --
 * it is populated only when no ProviderModelCatalogEntry row exists, and the
 * same scan writes that row -- which is why a model was named once and never
 * again. Reading the persistent set and letting the queue decide what is new is
 * the whole fix.
 *
 * Runs once for all providers rather than per provider: two providers listing
 * the same new model on the same morning is one decision, and a per-provider
 * pass would race to create two rows for it.
 */
export async function recordDiscoveredWorkItems(input: {
    observed: readonly { provider: string; apiModel: string }[];
    now?: Date;
}): Promise<{ created: number; skipped: number }> {
    if (input.observed.length === 0) return { created: 0, skipped: 0 };
    const now = input.now ?? new Date();

    const [catalogue, queued] = await Promise.all([
        prisma.modelRegistryEntry.findMany({
            where: { catalogDeleted: false },
            select: { apiModel: true },
        }),
        prisma.modelLifecycleWorkItem.findMany({ select: { apiModel: true } }),
    ]);

    const fresh = newCandidatesForQueue({
        observed: input.observed,
        catalogueApiModels: catalogue.map((row) => row.apiModel),
        queuedApiModels: queued.map((row) => row.apiModel),
    });

    let created = 0;
    for (const candidate of fresh) {
        try {
            await prisma.$transaction(async (tx) => {
                const item = await tx.modelLifecycleWorkItem.create({
                    data: {
                        provider: candidate.provider,
                        apiModel: candidate.apiModel,
                        action: "add",
                        status: "discovered",
                        severity: "normal",
                        firstSeenAt: now,
                        evidence: {
                            discoveredBy: "provider_model_catalog_monitor",
                            observedProvider: candidate.provider,
                            observedApiModel: candidate.apiModel,
                        },
                    },
                    select: { id: true },
                });
                // The creation event is the one row whose actor is null: nobody
                // decided anything, a scan saw something.
                await tx.modelLifecycleWorkItemEvent.create({
                    data: {
                        workItemId: item.id,
                        occurredAt: now,
                        actorEmail: null,
                        fromStatus: null,
                        toStatus: "discovered",
                        note: `Discovered in the ${candidate.provider} catalogue.`,
                    },
                });
            });
            created += 1;
        } catch (error) {
            // The unique key caught a concurrent creation. Losing that race is
            // not an error -- the row the winner wrote is the row we wanted --
            // and a failed scan is a worse outcome than a duplicate we avoided.
            if ((error as { code?: string }).code !== "P2002") throw error;
        }
    }
    return { created, skipped: input.observed.length - created };
}

export type WorkItemTransitionResult =
    | { ok: true; status: WorkItemStatus }
    | { ok: false; refusal: WorkItemTransitionRefusal }
    | { ok: false; refusal: { code: "not_found"; message: string } };

/**
 * Moves one item, and records who moved it.
 *
 * The item and its history are written in one transaction: a state with no
 * event explaining it is the state this table exists to replace.
 */
export async function transitionWorkItem(input: {
    workItemId: string;
    to: WorkItemStatus;
    actorEmail: string;
    note?: string;
    decision?: { decision: "approve" | "reject" | "defer"; reason: string };
    now?: Date;
}): Promise<WorkItemTransitionResult> {
    const now = input.now ?? new Date();
    const item = await prisma.modelLifecycleWorkItem.findUnique({
        where: { id: input.workItemId },
        select: {
            id: true,
            status: true,
            decision: true,
            pendingValidations: true,
            communicationRequired: true,
        },
    });
    if (!item) {
        return {
            ok: false,
            refusal: { code: "not_found", message: "No such work item." },
        };
    }

    const pending = Array.isArray(item.pendingValidations)
        ? (item.pendingValidations as unknown[]).map(String)
        : [];

    const refusal = workItemTransitionRefusal({
        from: item.status as WorkItemStatus,
        to: input.to,
        // A decision arriving with this call counts: approving and recording
        // why are one act, and splitting them would leave a window where the
        // item is approved and unexplained.
        hasDecision: Boolean(item.decision) || input.decision?.decision === "approve",
        pendingValidations: pending,
        communicationRequired: item.communicationRequired,
        actorEmail: input.actorEmail,
    });
    if (refusal) return { ok: false, refusal };

    const stamp = workItemTimestampField(input.to);
    await prisma.$transaction(async (tx) => {
        await tx.modelLifecycleWorkItem.update({
            where: { id: item.id },
            data: {
                status: input.to,
                ...(stamp ? { [stamp]: now } : {}),
                ...(input.decision
                    ? {
                          decision: input.decision.decision,
                          decisionReason: input.decision.reason,
                          decidedAt: now,
                          reviewerEmail: input.actorEmail,
                      }
                    : {}),
            },
        });
        await tx.modelLifecycleWorkItemEvent.create({
            data: {
                workItemId: item.id,
                occurredAt: now,
                actorEmail: input.actorEmail,
                fromStatus: item.status,
                toStatus: input.to,
                note: input.note ?? null,
            },
        });
    });
    return { ok: true, status: input.to };
}

export type OpenWorkItem = {
    id: string;
    provider: string;
    apiModel: string;
    action: string;
    status: string;
    severity: string;
    ownerEmail: string | null;
    dueAt: Date | null;
    firstSeenAt: Date;
};

/**
 * Everything still waiting on a person, oldest first.
 *
 * The status filter comes from the state machine rather than a literal list, so
 * a new state has to be classified as open or closed when it is added instead
 * of quietly falling out of every report.
 */
export async function listOpenWorkItems(options?: {
    limit?: number;
}): Promise<OpenWorkItem[]> {
    return prisma.modelLifecycleWorkItem.findMany({
        where: { status: { in: [...OPEN_WORK_ITEM_STATUSES] } },
        orderBy: [{ firstSeenAt: "asc" }],
        take: options?.limit ?? 200,
        select: {
            id: true,
            provider: true,
            apiModel: true,
            action: true,
            status: true,
            severity: true,
            ownerEmail: true,
            dueAt: true,
            firstSeenAt: true,
        },
    });
}

/** How many items are open, for the daily report's summary line. */
export async function countOpenWorkItems(): Promise<number> {
    return prisma.modelLifecycleWorkItem.count({
        where: { status: { in: [...OPEN_WORK_ITEM_STATUSES] } },
    });
}

export type { Prisma };
