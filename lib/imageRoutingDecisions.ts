import "server-only";
import type { ChatImageDecision } from "@/lib/chatImageIntentCore";
import type { ImageRoutingDecisionSource } from "@/lib/imageRoutingCore";
import { prisma } from "@/lib/prisma";

/**
 * Chat's image routing decisions, content-free (prisma ImageRoutingDecision):
 * written where the decision is made, linked to the image group it starts,
 * and read by the image routing report and optimizer. A failed write is
 * logged and never fails the turn.
 */

/** A routing decision id as the client hands it back: a cuid. */
export const IMAGE_ROUTING_DECISION_ID_PATTERN = /^[a-z0-9]{20,40}$/;

export async function recordImageRoutingDecision(input: {
    userId: string;
    conversationId: string | null;
    source: ImageRoutingDecisionSource;
    routerModelId: string;
    decision: ChatImageDecision;
    outcome: "image" | "chat" | "error";
    followUp: boolean;
    attachedPhoto: boolean;
    candidateCount: number;
    latencyMs: number | null;
}): Promise<string | null> {
    const image = input.decision.image ? input.decision : null;
    const create = (conversationId: string | null) =>
        prisma.imageRoutingDecision.create({
            data: {
                userId: input.userId,
                conversationId,
                source: input.source,
                routerModelId: input.routerModelId,
                outcome: input.outcome,
                imageModelId: image?.modelId ?? null,
                preset: image?.preset ?? null,
                edit: image?.edit ?? false,
                followUp: input.followUp,
                attachedPhoto: input.attachedPhoto,
                // The router named no usable model or preset, so the default answers.
                modelFallback: image !== null && (image.modelId === null || image.preset === null),
                candidateCount: input.candidateCount,
                latencyMs: input.latencyMs,
            },
            select: { id: true },
        });
    try {
        try {
            return (await create(input.conversationId)).id;
        } catch (error) {
            // A conversation that is gone (or not yet written) keeps the
            // decision, without the link: the foreign key sets it null on delete.
            const code = (error as { code?: unknown } | null)?.code;
            if (code !== "P2003" || input.conversationId === null) throw error;
            return (await create(null)).id;
        }
    } catch (error) {
        console.warn(JSON.stringify({ event: "image_routing_decision_record_failed", error: error instanceof Error ? error.name : "unknown" }));
        return null;
    }
}

/**
 * Links an image decision to the group it started: only the person's own
 * decision, only an image decision, and only once.
 */
export async function linkImageRoutingDecision(input: { decisionId: string; userId: string; groupId: string }): Promise<void> {
    try {
        await prisma.imageRoutingDecision.updateMany({
            where: { id: input.decisionId, userId: input.userId, outcome: "image", groupId: null },
            data: { groupId: input.groupId },
        });
    } catch (error) {
        // A group already linked to another decision (unique), or a lost row.
        console.warn(JSON.stringify({ event: "image_routing_decision_link_failed", error: error instanceof Error ? error.name : "unknown" }));
    }
}

/**
 * A recorded image decision the turn did not follow (a file request about
 * images answers as a file turn): it is a chat outcome, not an image without
 * a group. Only the person's own, unlinked image decision.
 */
export async function overrideImageRoutingDecisionAsChat(input: { decisionId: string; userId: string }): Promise<void> {
    try {
        await prisma.imageRoutingDecision.updateMany({
            where: { id: input.decisionId, userId: input.userId, outcome: "image", groupId: null },
            data: { outcome: "chat" },
        });
    } catch (error) {
        console.warn(JSON.stringify({ event: "image_routing_decision_override_failed", error: error instanceof Error ? error.name : "unknown" }));
    }
}
