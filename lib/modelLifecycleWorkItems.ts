import "server-only";

import { Prisma } from "@prisma/client";

import { listImageModels } from "@/lib/imageModelRegistry";
import { modelOwner } from "@/lib/modelOwner";
import { resolveModelPricing } from "@/lib/modelPricing";
import type { AiModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import {
    DOC_EVIDENCE_MAX_AGE_MS,
    docEvidenceIsFresh,
    docParseFromStored,
} from "@/lib/providerModelDocsCore";
import {
    OPEN_WORK_ITEM_STATUSES,
    createModelDecisionIdentityResolver,
    mergeObservedVia,
    observationsForExistingItems,
    selectQueueCandidates,
    trustedModelAliasEvidence,
    type ModelAliasEvidence,
    type ModelObservation,
    type SuppressedCandidate,
    ADOPTION_RECORD_STATUSES,
    workItemDecisionRecordRefusal,
    workItemDecisionTarget,
    workItemTimestampField,
    workItemTransitionRefusal,
    type WorkItemEventDecision,
    type WorkItemExclusionReason,
    type WorkItemStatus,
    type WorkItemTransitionRefusal,
} from "@/lib/modelLifecycleWorkItemCore";
import {
    assessModelLifecycleItem,
    modelStage,
    supersedingServedModel,
    type ModelCandidateEvidence,
    type ModelAvailability,
    type ModelProductSurface,
    type ModelReviewKind,
    type ModelReviewPriority,
    type ServedModelPortfolioEntry,
} from "@/lib/modelLifecycleTriage";

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
}): Promise<{
    created: number;
    skipped: number;
    /**
     * The models this run actually filed, and what it filtered out.
     *
     * Returned because the daily report used to answer "what is new today" from
     * the observation table instead -- a row appeared, therefore the model was
     * new -- and that answer is wrong the moment a second provider starts
     * serving something already decided. What is new is what the queue accepted.
     */
    createdItems: Array<{ provider: string; apiModel: string; observedVia: ModelObservation[] }>;
    suppressed: SuppressedCandidate[];
}> {
    if (input.observed.length === 0) {
        return { created: 0, skipped: 0, createdItems: [], suppressed: [] };
    }
    const now = input.now ?? new Date();

    const [catalogue, queued, catalogueEntries] = await Promise.all([
        prisma.modelRegistryEntry.findMany({
            where: { catalogDeleted: false },
            select: { apiModel: true },
        }),
        prisma.modelLifecycleWorkItem.findMany({
            select: { id: true, apiModel: true, evidence: true },
        }),
        prisma.providerModelCatalogEntry.findMany({
            select: { apiModel: true, metadata: true },
        }),
    ]);
    const aliases = providerAliasEvidence(catalogueEntries);
    const decisionIdentity = createModelDecisionIdentityResolver(aliases);

    const { fresh, suppressed } = selectQueueCandidates({
        observed: input.observed,
        catalogueApiModels: [
            ...catalogue.map((row) => row.apiModel),
            ...listImageModels().map((model) => model.apiModelId),
        ],
        queuedApiModels: queued.map((row) => row.apiModel),
        queuedDecisionKeys: queued
            .map((row) => storedDecisionKey(row.evidence))
            .filter((key): key is string => Boolean(key)),
        aliases,
    });

    // A model already in the queue, seen through a provider that had not served
    // it before, is new information about a decision somebody is already
    // making. Recording it on that row is the difference between "three reports
    // of the same model" and "one model, three providers" (ML-12).
    await recordAdditionalSightings(input.observed, queued, aliases);

    let created = 0;
    const createdItems: Array<{
        provider: string;
        apiModel: string;
        observedVia: ModelObservation[];
    }> = [];
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
                            // The key this decision is remembered under, written
                            // now rather than derived later. Normalisation rules
                            // change -- that is how a decision stopped matching
                            // the model it was about -- and a stored key keeps
                            // suppressing what it suppressed on the day it was
                            // filed.
                            decisionKey: `${decisionIdentity(candidate.apiModel)}@${modelStage(candidate.apiModel)}`,
                            // Every provider that served it, not only the first
                            // one iterated. Which providers offer a model is
                            // what somebody deciding whether to add it needs.
                            observedVia: candidate.observedVia,
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
            createdItems.push({
                provider: candidate.provider,
                apiModel: candidate.apiModel,
                observedVia: candidate.observedVia,
            });
        } catch (error) {
            // The unique key caught a concurrent creation. Losing that race is
            // not an error -- the row the winner wrote is the row we wanted --
            // and a failed scan is a worse outcome than a duplicate we avoided.
            if ((error as { code?: string }).code !== "P2002") throw error;
        }
    }
    return {
        created,
        skipped: input.observed.length - created,
        createdItems,
        suppressed,
    };
}

/**
 * The queue row an automatic disable owes.
 *
 * The monitor could already prove a provider had stopped serving a model, and
 * the reconciler could already switch it off. What neither did was leave
 * anything a person has to answer: `enabled=false` and an `operationalReason`
 * string, and the accounts holding that model found out by watching their
 * default quietly resolve to something else (ML-08).
 *
 * Created at `discovered`, not at `communication_pending`. Automation may
 * create and may never decide -- the audit's rule and the state machine's --
 * and starting a row three states along would be this scan deciding that the
 * users are owed a notice, which is a person's call. What the scan *can* say is
 * how many accounts hold the model, and that is what
 * `communicationRequired` is set from: with nobody holding it the item can
 * close without a notice, and with somebody holding it the state machine will
 * not let it.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §9.2,
 * docs/policy/default-model-luna-migration.md §4.7.
 */
export async function recordAutoDisableWorkItem(input: {
    tx: Prisma.TransactionClient;
    provider: string;
    apiModel: string;
    modelId: string;
    consecutiveMissing: number;
    usage: {
        defaultModelAccounts: number;
        newConversationAccounts: number;
        conversationAccounts: number;
        distinctAccounts: number;
    };
    now?: Date;
}): Promise<{ created: boolean }> {
    const now = input.now ?? new Date();

    // An open retirement item for this model is the item this disable would
    // have created. A second row would split one decision across two, and the
    // queue would show two things to do where there is one.
    const existing = await input.tx.modelLifecycleWorkItem.findFirst({
        where: {
            apiModel: input.apiModel,
            action: "retire",
            status: { in: [...OPEN_WORK_ITEM_STATUSES] },
        },
        select: { id: true },
    });
    if (existing) return { created: false };

    const affected = input.usage.distinctAccounts;
    const item = await input.tx.modelLifecycleWorkItem.create({
        data: {
            provider: input.provider,
            apiModel: input.apiModel,
            modelId: input.modelId,
            action: "retire",
            status: "discovered",
            // An operational disable that nobody selected is a catalogue
            // correction; the same disable under somebody's default model is
            // their next message failing to send.
            severity: affected > 0 ? "critical" : "high",
            communicationRequired: affected > 0,
            recommendation:
                affected > 0
                    ? `Choose a replacement and decide what the ${affected} account${affected === 1 ? "" : "s"} holding this model are told.`
                    : "Confirm the retirement, or restore the model if the provider's catalogue was at fault.",
            confidence: "medium",
            firstSeenAt: now,
            evidence: {
                disabledBy: "provider_model_catalog_reconciliation",
                consecutiveMissing: input.consecutiveMissing,
                storedUsage: input.usage,
            },
            unknowns: [
                "Whether the provider retired this model or the catalogue response was incomplete.",
            ],
        },
        select: { id: true },
    });

    await input.tx.modelLifecycleWorkItemEvent.create({
        data: {
            workItemId: item.id,
            occurredAt: now,
            // Null actor: a scan observed something. Nobody decided.
            actorEmail: null,
            fromStatus: null,
            toStatus: "discovered",
            note: `Disabled automatically after ${input.consecutiveMissing} consecutive scans without it. ${affected} account${affected === 1 ? "" : "s"} hold it.`,
        },
    });

    return { created: true };
}

/**
 * The decision key an item was filed under, if it has one.
 *
 * Absent on every row written before keys existed, and those rows fall back to
 * deriving one from their `apiModel`. The fallback is the weaker of the two --
 * it reads today's normalisation into yesterday's decision -- which is exactly
 * why new rows store the key instead.
 */
const storedDecisionKey = (evidence: Prisma.JsonValue | null): string | null => {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
    const value = (evidence as Record<string, unknown>).decisionKey;
    return typeof value === "string" && value.trim() ? value : null;
};

const storedObservedVia = (evidence: Prisma.JsonValue | null): ModelObservation[] => {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [];
    const value = (evidence as Record<string, unknown>).observedVia;
    if (!Array.isArray(value)) return [];
    return value.filter(
        (entry): entry is ModelObservation =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as ModelObservation).provider === "string" &&
            typeof (entry as ModelObservation).apiModel === "string"
    );
};

const providerAliasEvidence = (
    entries: readonly { apiModel: string; metadata: Prisma.JsonValue | null }[]
): ModelAliasEvidence[] =>
    entries.flatMap((entry) => {
        if (
            !entry.metadata ||
            typeof entry.metadata !== "object" ||
            Array.isArray(entry.metadata)
        ) {
            return [];
        }
        const aliasOf = (entry.metadata as Record<string, unknown>).aliasOf;
        return typeof aliasOf === "string" && aliasOf.trim()
            ? [{ aliasApiModel: entry.apiModel, canonicalApiModel: aliasOf }]
            : [];
    });

/**
 * Appends today's sightings to the items that already exist for them.
 *
 * Only writes when something was actually added, so a scan that sees the same
 * providers as yesterday touches nothing. Failures are swallowed per item: this
 * is an annotation on a decision, and losing it is a smaller loss than losing
 * the scan.
 */
const recordAdditionalSightings = async (
    observed: readonly ModelObservation[],
    queued: readonly { id: string; apiModel: string; evidence: Prisma.JsonValue | null }[],
    aliases: readonly ModelAliasEvidence[]
) => {
    const decisionIdentity = createModelDecisionIdentityResolver(aliases);
    const grouped = observationsForExistingItems({
        observed,
        queuedIdentities: queued.map((row) => decisionIdentity(row.apiModel)),
        aliases,
    });
    if (grouped.size === 0) return;

    for (const row of queued) {
        const sightings = grouped.get(decisionIdentity(row.apiModel));
        if (!sightings) continue;
        const { merged, added } = mergeObservedVia(storedObservedVia(row.evidence), sightings);
        if (added === 0) continue;
        const evidence =
            row.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence)
                ? { ...(row.evidence as Record<string, unknown>) }
                : {};
        await prisma.modelLifecycleWorkItem
            .update({
                where: { id: row.id },
                data: { evidence: { ...evidence, observedVia: merged } as Prisma.InputJsonValue },
            })
            .catch((error) =>
                console.error("Model lifecycle sighting update failed:", error)
            );
    }
};

export type WorkItemTransitionResult =
    | { ok: true; status: WorkItemStatus }
    | { ok: false; refusal: WorkItemTransitionRefusal }
    | { ok: false; refusal: { code: "not_found"; message: string } };

export type WorkItemTransitionInput = {
    workItemId: string;
    to: WorkItemStatus;
    actorEmail: string;
    note?: string;
    decision?: { decision: "approve" | "reject" | "defer"; reason: string };
    now?: Date;
};

export const MAX_BULK_WORK_ITEM_TRANSITIONS = 200;

/**
 * An operator decision written on the history event a transition creates.
 *
 * `analysisSnapshots` is per item: a bulk exclusion covers families the queue
 * described differently, and each event keeps the sentence its own row showed.
 */
export type WorkItemEventDecisionInput = {
    decision: WorkItemEventDecision;
    reasonCode?: WorkItemExclusionReason | null;
    operatorReason?: string | null;
    analysisSnapshots?: ReadonlyMap<string, string>;
};

export type WorkItemDecisionRefusal = {
    code: "reason_required" | "unknown_reason" | "decision_mismatch" | "analysis_required";
    message: string;
};

export type BulkWorkItemTransitionResult =
    | { ok: true; status: WorkItemStatus; updated: number }
    | {
          ok: false;
          refusal:
              | (WorkItemTransitionRefusal & { workItemId?: string })
              | {
                    code: "not_found";
                    message: string;
                    workItemId?: string;
                }
              | { code: "duplicate_id"; message: string }
              | { code: "too_many"; message: string }
              | WorkItemDecisionRefusal;
      };

const transitionWorkItemsInTransaction = async (
    tx: Prisma.TransactionClient,
    input: {
        workItemIds: readonly string[];
        to: WorkItemStatus;
        actorEmail: string;
        note?: string;
        decision?: { decision: "approve" | "reject" | "defer"; reason: string };
        eventDecision?: WorkItemEventDecisionInput;
        now?: Date;
    }
): Promise<BulkWorkItemTransitionResult> => {
    const now = input.now ?? new Date();
    const eventDecision = input.eventDecision;
    // Exclusions and reopens are checked for their own shape before anything is
    // locked; the database refuses the same shapes, but a constraint name is not
    // an answer an operator can act on.
    if (eventDecision?.decision === "adopt") {
        return {
            ok: false,
            refusal: {
                code: "decision_mismatch",
                message: "An adoption is recorded with recordAdoptionDecision, not on a transition.",
            },
        };
    }
    if (eventDecision) {
        const record =
            eventDecision.decision === "exclude"
                ? {
                      decision: "exclude" as const,
                      reasonCode: eventDecision.reasonCode as WorkItemExclusionReason,
                      operatorReason: eventDecision.operatorReason ?? null,
                  }
                : {
                      decision: "reopen" as const,
                      operatorReason: eventDecision.operatorReason ?? "",
                  };
        const refusal = workItemDecisionRecordRefusal(record);
        if (refusal) return { ok: false, refusal };
        // An exclusion is recorded against the analysis it was made on, for
        // every item, or not at all.
        if (
            eventDecision.decision === "exclude" &&
            input.workItemIds.some(
                (id) => !eventDecision.analysisSnapshots?.get(id)?.trim()
            )
        ) {
            return {
                ok: false,
                refusal: {
                    code: "analysis_required",
                    message: "Every excluded item needs the analysis it was excluded against.",
                },
            };
        }
        if (eventDecision.decision === "reopen" && eventDecision.analysisSnapshots?.size) {
            return {
                ok: false,
                refusal: {
                    code: "decision_mismatch",
                    message: "A reopen records the operator's reason, not an analysis.",
                },
            };
        }
        if (workItemDecisionTarget(eventDecision.decision) !== input.to) {
            return {
                ok: false,
                refusal: {
                    code: "decision_mismatch",
                    message: `${eventDecision.decision} does not move an item to ${input.to}.`,
                },
            };
        }
    }
    const operatorReason = eventDecision?.operatorReason?.trim() || null;
    const uniqueIds = Array.from(new Set(input.workItemIds));
    if (uniqueIds.length === 0) {
        return {
            ok: false,
            refusal: { code: "not_found", message: "No work items were supplied." },
        };
    }
    if (uniqueIds.length !== input.workItemIds.length) {
        return {
            ok: false,
            refusal: {
                code: "duplicate_id",
                message: "The bulk request contains a duplicate work item.",
            },
        };
    }
    if (uniqueIds.length > MAX_BULK_WORK_ITEM_TRANSITIONS) {
        return {
            ok: false,
            refusal: {
                code: "too_many",
                message: `At most ${MAX_BULK_WORK_ITEM_TRANSITIONS} work items may be changed at once.`,
            },
        };
    }

    // Lock the complete batch before validating it. Without this, another
    // admin request could move one row between the read and write and make the
    // event describe a transition that was never actually valid.
    await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "ModelLifecycleWorkItem"
        WHERE "id" IN (${Prisma.join(uniqueIds)})
        ORDER BY "id"
        FOR UPDATE
    `);

    const items = await tx.modelLifecycleWorkItem.findMany({
        where: { id: { in: uniqueIds } },
        select: {
            id: true,
            status: true,
            decision: true,
            pendingValidations: true,
            communicationRequired: true,
        },
    });
    const itemById = new Map(items.map((item) => [item.id, item]));
    const missingId = uniqueIds.find((id) => !itemById.has(id));
    if (missingId) {
        return {
            ok: false,
            refusal: {
                code: "not_found",
                message: "No such work item.",
                workItemId: missingId,
            },
        };
    }

    // Validate the whole batch before the first write. A refusal leaves every
    // row where it was, rather than applying a partial bulk decision.
    for (const id of uniqueIds) {
        const item = itemById.get(id)!;
        const pending = Array.isArray(item.pendingValidations)
            ? (item.pendingValidations as unknown[]).map(String)
            : [];
        const refusal = workItemTransitionRefusal({
            from: item.status as WorkItemStatus,
            to: input.to,
            hasDecision:
                Boolean(item.decision) || input.decision?.decision === "approve",
            pendingValidations: pending,
            communicationRequired: item.communicationRequired,
            actorEmail: input.actorEmail,
        });
        if (refusal) return { ok: false, refusal: { ...refusal, workItemId: id } };
    }

    const stamp = workItemTimestampField(input.to);
    for (const id of uniqueIds) {
        const item = itemById.get(id)!;
        const reopening = eventDecision?.decision === "reopen";
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
                // The item carries the exclusion as its current decision, so a
                // row read on its own still says who excluded it and why.
                ...(eventDecision?.decision === "exclude"
                    ? {
                          decision: "reject",
                          decisionReason: operatorReason
                              ? `${eventDecision.reasonCode}: ${operatorReason}`
                              : String(eventDecision.reasonCode),
                          decidedAt: now,
                          reviewerEmail: input.actorEmail,
                      }
                    : {}),
                // A reopened item is undecided again. What it was reopened from
                // stays on the history, which is where a past decision belongs;
                // left on the row, it would describe an item that is open as one
                // somebody rejected.
                ...(reopening
                    ? {
                          closedAt: null,
                          decision: null,
                          decisionReason: null,
                          decidedAt: null,
                          reviewerEmail: null,
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
                ...(eventDecision
                    ? {
                          decision: eventDecision.decision,
                          reasonCode:
                              eventDecision.decision === "exclude"
                                  ? eventDecision.reasonCode ?? null
                                  : null,
                          operatorReason,
                          analysisSnapshot:
                              eventDecision.analysisSnapshots?.get(item.id) ?? null,
                      }
                    : {}),
            },
        });
    }
    return { ok: true, status: input.to, updated: uniqueIds.length };
};

/**
 * Records that an operator adopted an item into the registry.
 *
 * One event, after the adoption walk and in the same transaction, rather than a
 * field on whichever step happened to be first: an item that was already past
 * `approved` walks no approving step, and a record that exists only on that
 * step would be missing for exactly those items. The event moves nothing -- its
 * from and to are the state the walk ended in -- and carries the operator's
 * reason and the queue's analysis in their own columns.
 */
export async function recordAdoptionDecision(
    tx: Prisma.TransactionClient,
    input: {
        workItemId: string;
        actorEmail: string;
        status: WorkItemStatus;
        operatorReason: string;
        analysisSnapshot: string;
        note: string;
        now?: Date;
    }
): Promise<{ ok: true } | { ok: false; refusal: WorkItemDecisionRefusal }> {
    const refusal = workItemDecisionRecordRefusal({
        decision: "adopt",
        operatorReason: input.operatorReason,
    });
    if (refusal) return { ok: false, refusal };
    if (!input.actorEmail?.trim()) {
        return {
            ok: false,
            refusal: {
                code: "decision_mismatch",
                message: "An adoption needs the person who made it.",
            },
        };
    }
    if (!input.analysisSnapshot?.trim()) {
        return {
            ok: false,
            refusal: {
                code: "analysis_required",
                message: "An adoption needs the analysis it was made against.",
            },
        };
    }
    if (!ADOPTION_RECORD_STATUSES.has(input.status)) {
        return {
            ok: false,
            refusal: {
                code: "decision_mismatch",
                message: `An adoption cannot be recorded on an item in ${input.status}.`,
            },
        };
    }
    await tx.modelLifecycleWorkItemEvent.create({
        data: {
            workItemId: input.workItemId,
            occurredAt: input.now ?? new Date(),
            actorEmail: input.actorEmail,
            fromStatus: input.status,
            toStatus: input.status,
            note: input.note,
            decision: "adopt",
            operatorReason: input.operatorReason.trim(),
            analysisSnapshot: input.analysisSnapshot,
        },
    });
    return { ok: true };
}

/** Moves several items atomically, recording one event per item. */
export async function transitionWorkItems(
    input: {
        workItemIds: readonly string[];
        to: WorkItemStatus;
        actorEmail: string;
        note?: string;
        decision?: { decision: "approve" | "reject" | "defer"; reason: string };
        eventDecision?: WorkItemEventDecisionInput;
        now?: Date;
    },
    options?: { tx?: Prisma.TransactionClient }
): Promise<BulkWorkItemTransitionResult> {
    if (options?.tx) return transitionWorkItemsInTransaction(options.tx, input);
    return prisma.$transaction((tx) => transitionWorkItemsInTransaction(tx, input));
}

/**
 * Moves one item, and records who moved it.
 *
 * The item and its history are written in one transaction: a state with no
 * event explaining it is the state this table exists to replace.
 */
export async function transitionWorkItem(
    input: WorkItemTransitionInput,
    options?: { tx?: Prisma.TransactionClient }
): Promise<WorkItemTransitionResult> {
    const result = await transitionWorkItems(
        {
            workItemIds: [input.workItemId],
            to: input.to,
            actorEmail: input.actorEmail,
            note: input.note,
            decision: input.decision,
            now: input.now,
        },
        options
    );
    if (!result.ok) {
        if (
            result.refusal.code === "duplicate_id" ||
            result.refusal.code === "too_many" ||
            result.refusal.code === "reason_required" ||
            result.refusal.code === "unknown_reason" ||
            result.refusal.code === "decision_mismatch"
        ) {
            throw new Error(`Unexpected single-item refusal: ${result.refusal.code}`);
        }
        if (result.refusal.code === "not_found") {
            return {
                ok: false,
                refusal: {
                    code: "not_found",
                    message: result.refusal.message,
                },
            };
        }
        return {
            ok: false,
            refusal: result.refusal as WorkItemTransitionRefusal,
        };
    }
    return { ok: true, status: result.status };
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

export type ModelDiscoveryQueueItem = OpenWorkItem & {
    recommendation: string | null;
    observedVia: ModelObservation[];
    availability: ModelAvailability;
    lifecycle: string | null;
    servedByTomverse: boolean;
    /** The served model that is a later generation of this one's line. */
    supersededBy: string | null;
    /** Verifications still owed before this item may be rolled out. */
    pendingValidations: string[];
    familyKey: string;
    familySize: number;
    reviewPriority: ModelReviewPriority;
    reviewKind: ModelReviewKind;
    product: ModelProductSurface;
    analysisKo: string;
    /** The exclusion that closed this item; only in the excluded view. */
    exclusion: WorkItemExclusionSummary | null;
};

export type WorkItemExclusionSummary = {
    /** Null for an item closed before exclusions had reasons, or by a script. */
    reasonCode: string | null;
    operatorReason: string | null;
    analysisSnapshot: string | null;
    note: string | null;
    actorEmail: string | null;
    excludedAt: Date;
};

/**
 * `excludable` is the undecided part of the open queue -- what an exclusion
 * may close -- read in full so a family's members can be counted.
 */
export type ModelDiscoveryQueueView = "open" | "excluded" | "excludable";

export const EXCLUDABLE_WORK_ITEM_STATUSES = [
    "discovered",
    "awaiting_decision",
    "deferred",
] as const satisfies readonly WorkItemStatus[];

export type ModelDiscoveryQueue = {
    items: ModelDiscoveryQueueItem[];
    total: number;
    truncated: boolean;
};

const observationKey = (provider: string, apiModel: string) =>
    `${provider}\u0000${apiModel}`;

const metadataRecord = (value: Prisma.JsonValue | null) =>
    value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

const finiteNumber = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

const nullableBoolean = (value: unknown) =>
    typeof value === "boolean" ? value : null;

const consensus = <T>(values: readonly (T | null)[]): T | null => {
    const present = values.filter((value): value is T => value !== null);
    if (present.length === 0) return null;
    return present.every((value) => Object.is(value, present[0]))
        ? present[0]
        : null;
};

type StoredDocEvidence = {
    provider: string;
    apiModel: string;
    status: string;
    parserVersion: string;
    fields: Prisma.JsonValue | null;
    problems: Prisma.JsonValue;
    fetchedAt: Date;
};

type CandidateCatalogEntry = {
    provider: string;
    apiModel: string;
    metadata: Prisma.JsonValue | null;
};

/**
 * Collapses copied alias metadata into one conservative capability view.
 * A disagreement becomes unknown rather than whichever provider row happened
 * to be read first; this text is decision support and must not invent a fact.
 */
const candidateEvidenceForFamily = (
    familyEntries: readonly CandidateCatalogEntry[],
    docByObservation: ReadonlyMap<string, StoredDocEvidence>,
    aliases: readonly ModelAliasEvidence[],
    now: Date
): ModelCandidateEvidence | null => {
    if (familyEntries.length === 0) return null;
    const observations = familyEntries.map((entry) => {
        const metadata = metadataRecord(entry.metadata);
        const row = docByObservation.get(
            observationKey(entry.provider, entry.apiModel)
        );
        const parsed =
            row && docEvidenceIsFresh(row.fetchedAt, now)
                ? docParseFromStored(row)
                : null;
        const doc = parsed?.status === "parsed" ? parsed.fields : null;
        const apiInputPrice = finiteNumber(
            metadata?.observedPromptPriceCentsPer100MTokens
        );
        const apiOutputPrice = finiteNumber(
            metadata?.observedCompletionPriceCentsPer100MTokens
        );
        // A documented price with a parser problem or a promotion marker is
        // still visible in the adoption form beside its source, but it is not
        // sound enough to rank a model in this compact queue sentence.
        const docPriceUsable =
            parsed?.status === "parsed" &&
            parsed.problems.length === 0 &&
            doc?.promotional === null;
        return {
            contextWindowTokens:
                finiteNumber(metadata?.contextLength) ??
                finiteNumber(metadata?.inputTokenLimit) ??
                finiteNumber(doc?.contextWindowTokens),
            maxOutputTokens:
                finiteNumber(metadata?.outputTokenLimit) ??
                finiteNumber(doc?.maxOutputTokens),
            supportsImage:
                nullableBoolean(metadata?.vision) ??
                nullableBoolean(doc?.imageInput),
            supportsNativePdf: nullableBoolean(metadata?.pdfInput),
            reasoning: nullableBoolean(metadata?.thinking),
            inputPrice:
                apiInputPrice !== null
                    ? apiInputPrice / 10_000
                    : docPriceUsable
                      ? finiteNumber(doc?.inputUsdPerMillionTokens)
                      : null,
            outputPrice:
                apiOutputPrice !== null
                    ? apiOutputPrice / 10_000
                    : docPriceUsable
                      ? finiteNumber(doc?.outputUsdPerMillionTokens)
                      : null,
            priceSource:
                apiInputPrice !== null && apiOutputPrice !== null
                    ? ("provider_api" as const)
                    : docPriceUsable &&
                        doc?.inputUsdPerMillionTokens != null &&
                        doc?.outputUsdPerMillionTokens != null
                      ? ("provider_docs" as const)
                      : null,
            longContextThreshold:
                finiteNumber(metadata?.longContextThreshold) ??
                (doc?.longContext.kind === "tiered"
                    ? doc.longContext.thresholdTokens
                    : null),
        };
    });
    const canonicalIds = Array.from(
        new Set(aliases.map((alias) => alias.canonicalApiModel))
    );
    const equivalentApiModels = Array.from(
        new Set(
            aliases
                .flatMap((alias) => [alias.aliasApiModel, alias.canonicalApiModel])
        )
    );
    const contextWindowTokens = consensus(
        observations.map((item) => item.contextWindowTokens)
    );
    const inputPrice = consensus(observations.map((item) => item.inputPrice));
    const outputPrice = consensus(observations.map((item) => item.outputPrice));
    const priceSources = Array.from(
        new Set(
            observations
                .map((item) => item.priceSource)
                .filter((value): value is "provider_api" | "provider_docs" =>
                    Boolean(value)
                )
        )
    );
    return {
        canonicalApiModel: canonicalIds.length === 1 ? canonicalIds[0] : null,
        equivalentApiModels,
        contextWindowTokens,
        maxOutputTokens: consensus(
            observations.map((item) => item.maxOutputTokens)
        ),
        supportsImage: consensus(
            observations.map((item) => item.supportsImage)
        ),
        supportsNativePdf: consensus(
            observations.map((item) => item.supportsNativePdf)
        ),
        reasoning: consensus(
            observations.map((item) => item.reasoning)
        ),
        observedInputUsdPerMillionTokens: inputPrice,
        observedOutputUsdPerMillionTokens: outputPrice,
        priceEvidenceSource:
            inputPrice === null || outputPrice === null
                ? null
                : priceSources.length > 1
                  ? "mixed"
                  : priceSources[0] ?? null,
        longContextThreshold: consensus(
            observations.map((item) => item.longContextThreshold)
        ),
    };
};

/**
 * The discovery panel's evidence-enriched queue.
 *
 * "Current" means at least one provider returned the exact id in its latest
 * successful scan. A failed/skipped latest scan is unknown, never stale: a
 * network or credential failure is not evidence that the provider retired a
 * model.
 */
export async function listModelDiscoveryQueue(options?: {
    limit?: number;
    view?: ModelDiscoveryQueueView;
    /** Exactly these items, whatever their state. */
    workItemIds?: readonly string[];
}): Promise<ModelDiscoveryQueue> {
    const limit = Math.max(1, Math.min(options?.limit ?? 1_000, 1_000));
    const now = new Date();
    const view = options?.view ?? "open";
    const rowWhere: Prisma.ModelLifecycleWorkItemWhereInput = options?.workItemIds
        ? { id: { in: [...options.workItemIds] } }
        : view === "excluded"
          ? { status: "closed_no_action" }
          : view === "excludable"
            ? { status: { in: [...EXCLUDABLE_WORK_ITEM_STATUSES] } }
            : { status: { in: [...OPEN_WORK_ITEM_STATUSES] } };
    // These reads are independent. Keeping them in one parallel round avoids
    // making a remote database pay a second network latency merely to derive
    // the exact observation pairs from the work-item evidence.
    const [rows, total, registry, latestRuns, entries, docRows] = await Promise.all([
        prisma.modelLifecycleWorkItem.findMany({
            where: rowWhere,
            orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
            take: limit,
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
                recommendation: true,
                pendingValidations: true,
                evidence: true,
            },
        }),
        options?.workItemIds
            ? Promise.resolve(options.workItemIds.length)
            : view === "open"
              ? countOpenWorkItems()
              : prisma.modelLifecycleWorkItem.count({ where: rowWhere }),
        prisma.modelRegistryEntry.findMany({
            where: { catalogDeleted: false },
            select: {
                id: true,
                apiModel: true,
                provider: true,
                name: true,
                bestFor: true,
                reasoning: true,
                contextWindowTokens: true,
                supportsImage: true,
                supportsNativePdf: true,
                maxOutputTokens: true,
                reservationOutputTokens: true,
                inputUsdPerMillionTokens: true,
                outputUsdPerMillionTokens: true,
                cachedInputPriceMultiplier: true,
                usageClass: true,
                publiclyListed: true,
                enabled: true,
                status: true,
                sortOrder: true,
            },
        }),
        prisma.providerModelCatalogRun.findMany({
            distinct: ["provider"],
            orderBy: [
                { provider: "asc" },
                { startedAt: "desc" },
                { id: "desc" },
            ],
            select: { provider: true, status: true, startedAt: true },
        }),
        // ProviderModelCatalogEntry is current state, not an append-only run
        // log: one row per exact provider/id pair. Reading its compact evidence
        // projection is bounded by the providers' live catalogues and lets all
        // six database reads run concurrently.
        prisma.providerModelCatalogEntry.findMany({
            select: {
                provider: true,
                apiModel: true,
                lastSeenAt: true,
                lifecycle: true,
                metadata: true,
            },
        }),
        prisma.providerModelDocEvidence.findMany({
            // Analysis uses the same freshness boundary as adoption prefill.
            // Keeping this in SQL also prevents an evidence history that grows
            // over years from turning every panel load into an unbounded read.
            where: {
                fetchedAt: {
                    gte: new Date(now.getTime() - DOC_EVIDENCE_MAX_AGE_MS),
                },
            },
            select: {
                provider: true,
                apiModel: true,
                status: true,
                parserVersion: true,
                fields: true,
                problems: true,
                fetchedAt: true,
            },
        }),
    ]);

    const aliases = providerAliasEvidence(entries);
    const decisionIdentity = createModelDecisionIdentityResolver(aliases);
    const imageModels = listImageModels();
    const servedModels: ServedModelPortfolioEntry[] = [
        ...registry
            .filter(
                (entry) =>
                    entry.enabled &&
                    entry.publiclyListed &&
                    entry.status !== "disabled"
            )
            .map((entry) => {
                // Registry price columns are usually null by design: null
                // inherits the code profile. Compare with the same effective
                // rate live requests use instead of treating inheritance as
                // "price unknown".
                const pricing = resolveModelPricing(
                    {
                        id: entry.id,
                        apiModel: entry.apiModel,
                        provider: entry.provider as AiModel["provider"],
                        usageClass: entry.usageClass as AiModel["usageClass"],
                        maxOutputTokens: entry.maxOutputTokens ?? undefined,
                        reservationOutputTokens:
                            entry.reservationOutputTokens ?? undefined,
                        inputUsdPerMillionTokens:
                            entry.inputUsdPerMillionTokens ?? undefined,
                        outputUsdPerMillionTokens:
                            entry.outputUsdPerMillionTokens ?? undefined,
                        cachedInputPriceMultiplier:
                            entry.cachedInputPriceMultiplier ?? undefined,
                    },
                    { at: now }
                );
                return {
                    apiModel: entry.apiModel,
                    provider: entry.provider,
                    name: entry.name,
                    bestFor: entry.bestFor,
                    reasoning: entry.reasoning,
                    contextWindowTokens: entry.contextWindowTokens,
                    supportsImage: entry.supportsImage,
                    supportsNativePdf: entry.supportsNativePdf,
                    maxOutputTokens: entry.maxOutputTokens,
                    inputUsdPerMillionTokens:
                        pricing.costSource.startsWith("conservative_fallback")
                            ? null
                            : pricing.inputUsdPerMillionTokens,
                    outputUsdPerMillionTokens:
                        pricing.costSource.startsWith("conservative_fallback")
                            ? null
                            : pricing.outputUsdPerMillionTokens,
                    usageClass: entry.usageClass,
                    product: "chat" as const,
                    sortOrder: entry.sortOrder,
                };
            }),
        ...imageModels
            .filter((model) => model.disabledReason === null)
            .map((model, index) => ({
                apiModel: model.apiModelId,
                provider: model.provider,
                name: model.name,
                product: "image_generation" as const,
                sortOrder: index,
            })),
    ];
    const servedModelsByOwner = new Map<
        ReturnType<typeof modelOwner>,
        ServedModelPortfolioEntry[]
    >();
    for (const model of servedModels) {
        const owner = modelOwner(model.apiModel);
        if (owner === "unknown") continue;
        const grouped = servedModelsByOwner.get(owner);
        if (grouped) grouped.push(model);
        else servedModelsByOwner.set(owner, [model]);
    }

    const sightingsByItem = new Map(
        rows.map((row) => {
            const stored = storedObservedVia(row.evidence);
            return [
                row.id,
                stored.length
                    ? stored
                    : [{ provider: row.provider, apiModel: row.apiModel }],
            ];
        })
    );

    const latestRunByProvider = new Map(
        latestRuns.map((run) => [run.provider, run])
    );
    const currentEntries = entries.filter((entry) => {
        const run = latestRunByProvider.get(entry.provider);
        return (
            run?.status === "checked" &&
            entry.lastSeenAt !== null &&
            entry.lastSeenAt >= run.startedAt
        );
    });
    const currentEntriesByFamily = new Map<string, CandidateCatalogEntry[]>();
    for (const entry of currentEntries) {
        const family = decisionIdentity(entry.apiModel);
        const grouped = currentEntriesByFamily.get(family);
        if (grouped) grouped.push(entry);
        else currentEntriesByFamily.set(family, [entry]);
    }
    const trustedAliasesByFamily = new Map<string, ModelAliasEvidence[]>();
    for (const alias of trustedModelAliasEvidence(aliases)) {
        const family = decisionIdentity(alias.canonicalApiModel);
        const grouped = trustedAliasesByFamily.get(family);
        if (grouped) grouped.push(alias);
        else trustedAliasesByFamily.set(family, [alias]);
    }
    const docByObservation = new Map(
        docRows.map((row) => [observationKey(row.provider, row.apiModel), row])
    );
    const entryByObservation = new Map(
        entries.map((entry) => [
            observationKey(entry.provider, entry.apiModel),
            entry,
        ])
    );
    const servedApiModels = [
        ...registry.map((entry) => entry.apiModel),
        ...imageModels.map((model) => model.apiModelId),
    ];
    const servedFamilies = new Set(
        servedApiModels.map(decisionIdentity)
    );
    const familyCounts = new Map<string, number>();
    for (const row of rows) {
        const family = decisionIdentity(row.apiModel);
        familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
    }

    // The exclusion each excluded item was closed by: its latest move into
    // closed_no_action. Read only for that view; an open item has none.
    const exclusionByItem = new Map<string, WorkItemExclusionSummary>();
    if (view === "excluded" && !options?.workItemIds && rows.length > 0) {
        // One row per item, chosen in the database: an item excluded, reopened
        // and excluded again many times has many closings, and only the latest
        // is on screen. DISTINCT ON walks the (workItemId, occurredAt) index.
        const closings = await prisma.$queryRaw<
            Array<{
                workItemId: string;
                occurredAt: Date;
                actorEmail: string | null;
                note: string | null;
                reasonCode: string | null;
                operatorReason: string | null;
                analysisSnapshot: string | null;
            }>
        >(Prisma.sql`
            SELECT DISTINCT ON ("workItemId")
                "workItemId", "occurredAt", "actorEmail", "note",
                "reasonCode", "operatorReason", "analysisSnapshot"
            FROM "ModelLifecycleWorkItemEvent"
            WHERE "workItemId" IN (${Prisma.join(rows.map((row) => row.id))})
              AND "toStatus" = 'closed_no_action'
              AND "fromStatus" IS DISTINCT FROM 'closed_no_action'
            ORDER BY "workItemId", "occurredAt" DESC, "id" DESC
        `);
        for (const event of closings) {
            exclusionByItem.set(event.workItemId, {
                reasonCode: event.reasonCode,
                operatorReason: event.operatorReason,
                analysisSnapshot: event.analysisSnapshot,
                note: event.note,
                actorEmail: event.actorEmail,
                excludedAt: event.occurredAt,
            });
        }
    }

    const items = rows.map((row) => {
        const observedVia = sightingsByItem.get(row.id) ?? [];
        const observedStates = observedVia.map((observation): ModelAvailability => {
            const run = latestRunByProvider.get(observation.provider);
            if (!run || run.status !== "checked") return "unknown";
            const entry = entryByObservation.get(
                observationKey(observation.provider, observation.apiModel)
            );
            return entry?.lastSeenAt && entry.lastSeenAt >= run.startedAt
                ? "current"
                : "stale";
        });
        const availability: ModelAvailability = observedStates.includes("current")
            ? "current"
            : observedStates.includes("unknown")
              ? "unknown"
              : "stale";
        const lifecycle = observedVia
            .map((observation) =>
                entryByObservation.get(
                    observationKey(observation.provider, observation.apiModel)
                )?.lifecycle
            )
            .find((value): value is string => Boolean(value)) ?? null;
        const familyKey = decisionIdentity(row.apiModel);
        const servedByTomverse = servedFamilies.has(familyKey);
        // A retirement is about a model Tomverse serves, so its own line will
        // always contain it. Asking whether it is superseded would answer yes
        // about itself and bury the one item in this queue that is urgent.
        const supersededBy =
            row.action === "retire"
                ? null
                : supersedingServedModel(row.apiModel, servedApiModels);
        const assessment = assessModelLifecycleItem({
            action: row.action,
            apiModel: row.apiModel,
            providers: observedVia.map((item) => item.provider),
            availability,
            lifecycle,
            servedByTomverse,
            supersededBy,
            candidateEvidence: candidateEvidenceForFamily(
                currentEntriesByFamily.get(familyKey) ?? [],
                docByObservation,
                trustedAliasesByFamily.get(familyKey) ?? [],
                now
            ),
            servedModels:
                servedModelsByOwner.get(modelOwner(row.apiModel)) ?? [],
        });
        return {
            id: row.id,
            provider: row.provider,
            apiModel: row.apiModel,
            action: row.action,
            status: row.status,
            severity: row.severity,
            ownerEmail: row.ownerEmail,
            dueAt: row.dueAt,
            firstSeenAt: row.firstSeenAt,
            recommendation: row.recommendation,
            observedVia,
            availability,
            lifecycle,
            servedByTomverse,
            supersededBy,
            pendingValidations: stringList(row.pendingValidations),
            familyKey,
            familySize: familyCounts.get(familyKey) ?? 1,
            reviewPriority: assessment.priority,
            reviewKind: assessment.kind,
            product: assessment.product,
            analysisKo: assessment.analysisKo,
            exclusion: exclusionByItem.get(row.id) ?? null,
        };
    });

    return { items, total, truncated: total > items.length };
}

/**
 * The analysis sentence the queue shows for each item, as of now.
 *
 * Computed by the server rather than accepted from the request: the snapshot is
 * evidence of what the operator was shown, and a value the client supplies would
 * be evidence of whatever the client sent.
 */
/**
 * Every item a decision could apply to, with its analysis and family: the
 * undecided queue for an exclusion, the excluded items for a reopen.
 *
 * `complete` is false when there are more than one read holds: a family check
 * against a partial list could approve a decision that leaves members behind.
 */
export async function queueFamilies(view: "excludable" | "excluded"): Promise<{
    complete: boolean;
    items: Map<string, { analysisKo: string; familyKey: string }>;
}> {
    const queue = await listModelDiscoveryQueue({ view, limit: 1_000 });
    return {
        complete: !queue.truncated,
        items: new Map(
            queue.items.map((item) => [
                item.id,
                { analysisKo: item.analysisKo, familyKey: item.familyKey },
            ])
        ),
    };
}

/**
 * Whether the items in `statuses` are still the ones a family check read.
 *
 * Re-read inside the write transaction, so an item filed, reopened or excluded
 * between the family check and the write is caught in the common case. It takes
 * no table lock, deliberately: the adoption transaction holds a row lock and
 * then updates, and a table lock here waiting on that row made the two
 * deadlock. What remains is a narrow window between this read and commit, and
 * an alias change in the catalogue that regroups families without touching this
 * table. Both cost the same, reversible thing -- a family member left in the
 * view it was in, visible there and decidable on its own -- which is why this is
 * a check and not a serialisation.
 */
export async function queueStatusSetUnchanged(
    tx: Prisma.TransactionClient,
    statuses: readonly WorkItemStatus[],
    checkedIds: ReadonlySet<string>
): Promise<boolean> {
    const current = await tx.modelLifecycleWorkItem.findMany({
        where: { status: { in: [...statuses] } },
        select: { id: true },
    });
    return current.every((row) => checkedIds.has(row.id));
}

export async function analysisSnapshotsFor(
    workItemIds: readonly string[]
): Promise<Map<string, { analysisKo: string; familyKey: string }>> {
    if (workItemIds.length === 0) return new Map();
    const queue = await listModelDiscoveryQueue({
        workItemIds,
        limit: workItemIds.length,
    });
    return new Map(
        queue.items.map((item) => [
            item.id,
            { analysisKo: item.analysisKo, familyKey: item.familyKey },
        ])
    );
}

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
        orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
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

/** The queue rows the daily report reads, with the fields the report shows. */
export type LifecycleReportRow = OpenWorkItem & {
    blockers: string[];
    pendingValidations: string[];
    recommendation: string | null;
    /**
     * Every catalogue this model was seen in, which is not the same question as
     * `provider` answers (ML-13).
     *
     * `provider` is the scan that first filed the item. Reporting it as though
     * it said who made the model produced lines like "Qwen kimi-k3".
     */
    observedVia: ModelObservation[];
};

const stringList = (value: Prisma.JsonValue | null): string[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string");
};

/**
 * Everything the daily report lists: open items *and* decided ones that have
 * not shipped.
 *
 * A separate reader from `listOpenWorkItems` rather than more fields on it. The
 * admin panel's list is served to a browser and its shape is a contract; the
 * report needs blockers and pending validations, which nothing in that panel
 * displays. Widening the shared reader would have put them in a response that
 * has no use for them.
 */
export async function listLifecycleReportWorkItems(options?: {
    limit?: number;
}): Promise<LifecycleReportRow[]> {
    const rows = await prisma.modelLifecycleWorkItem.findMany({
        // Every non-terminal state, which is more than `listOpenWorkItems`
        // means by "open" in the panel: the report also shows what has been
        // decided and not yet shipped, and that is the same set.
        where: { status: { in: [...OPEN_WORK_ITEM_STATUSES] } },
        orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }],
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
            blockers: true,
            pendingValidations: true,
            recommendation: true,
            evidence: true,
        },
    });
    return rows.map(({ evidence, ...row }) => ({
        ...row,
        blockers: stringList(row.blockers),
        pendingValidations: stringList(row.pendingValidations),
        // Falls back to the filing scan when the item predates ML-12 and has no
        // recorded sightings. An empty list would make an old item look like one
        // nothing has ever seen, which is a different and wronger claim.
        observedVia: storedObservedVia(evidence).length
            ? storedObservedVia(evidence)
            : [{ provider: row.provider, apiModel: row.apiModel }],
    }));
}

/**
 * What moved in the queue since `since`, from the append-only history.
 *
 * Counted from events rather than from the items' own timestamps because an
 * item that was discovered, decided and shipped in one day would otherwise
 * appear in exactly one of those counts.
 */
export async function summariseLifecycleChanges(since: Date): Promise<{
    discovered: number;
    decided: number;
    transitions: number;
    completed: number;
}> {
    const events = await prisma.modelLifecycleWorkItemEvent.findMany({
        where: { occurredAt: { gte: since } },
        select: { fromStatus: true, toStatus: true },
    });
    let discovered = 0;
    let decided = 0;
    let completed = 0;
    let records = 0;
    for (const event of events) {
        // An adoption record moves nothing; counting it would report a
        // transition that did not happen.
        if (event.fromStatus !== null && event.fromStatus === event.toStatus) {
            records += 1;
            continue;
        }
        if (event.fromStatus === null) discovered += 1;
        if (["approved", "rejected", "deferred"].includes(event.toStatus)) decided += 1;
        if (event.toStatus === "completed" || event.toStatus === "closed_no_action") {
            completed += 1;
        }
    }
    return {
        discovered,
        decided,
        transitions: events.length - discovered - records,
        completed,
    };
}

export type { Prisma };
