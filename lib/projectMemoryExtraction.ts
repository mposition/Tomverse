import "server-only";

import type { Prisma } from "@prisma/client";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { isMemoryExtractionEnabled } from "@/lib/appSettings";
import { ChatAccessError } from "@/lib/chatSecurity";
import { resolveConversationMemoryMode } from "@/lib/conversationMemoryMode";
import { automaticExtractionPair } from "@/lib/memoryExtractionAuto";
import { MEMORY_EXTRACTION_EVAL_REGISTER, type MemoryExtractionEvalEntry } from "@/lib/memoryExtractionEvalRegister";
import type { ExtractionSourceConversationInput } from "@/lib/memoryExtractionPrompt";
import { createNativeMemoryExtractionRun } from "@/lib/memoryExtractionService";
import { getMemorySettings } from "@/lib/memoryService";
import { nativeMessageDigest } from "@/lib/nativeMemoryEvidence";
import { prisma } from "@/lib/prisma";
import {
    isNativeExtractionSelection,
    nativeExtractionAllowed,
    nativeExtractionSourceKey,
    type NativeExtractionSelection,
} from "@/lib/projectWorkspaceCore";
import { resolveConversationProjectScope } from "@/lib/projectWorkspaceService";

/**
 * Automatic project memory from Tomverse conversations (the native source
 * adapter for the existing extraction pipeline).
 *
 * After an answer is stored, the conversation's new messages since the last
 * snapshot are queued as one extraction run: the same model pair, structured
 * output, validator, fenced commit and provider-cost reservation that import
 * extraction uses, with the window fixed at enqueue time (a cursor, not "the
 * whole project on every send"). The answer is never held for it.
 *
 * The provider spend is new, so the operator switch
 * `TOMVERSE_PROJECT_AUTO_MEMORY_ENABLED` is off by default; with it off every
 * enqueue is a recorded skip and nothing is called.
 */

export const projectAutoMemoryOperatorEnabled = (environment: Record<string, string | undefined> = process.env) =>
    environment.TOMVERSE_PROJECT_AUTO_MEMORY_ENABLED === "true";

/** Retry a failed snapshot after this long, at most this many times. */
const NATIVE_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const NATIVE_MAX_FAILED_RUNS = 3;

export type NativeExtractionEnqueue =
    | { outcome: "started"; runId: string }
    | { outcome: "skipped"; reason: string };

async function lastSnapshot(userId: string, conversationId: string) {
    const runs = await prisma.memoryExtractionRun.findMany({
        where: { userId, sourceKind: "native", sourceConversationId: conversationId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 10,
        select: { id: true, status: true, createdAt: true, sourceSelection: true },
    });
    return runs;
}

export async function enqueueNativeProjectExtraction(input: {
    userId: string;
    conversationId: string;
    now?: Date;
    register?: readonly MemoryExtractionEvalEntry[];
    environment?: Record<string, string | undefined>;
    /** Tests inject this; production kicks the existing worker. */
    kick?: (runId: string) => Promise<void> | void;
}): Promise<NativeExtractionEnqueue> {
    const now = input.now ?? new Date();
    const environment = input.environment ?? process.env;
    const project = await resolveConversationProjectScope(input.userId, input.conversationId);
    const [settings, conversation, featureEnabled] = await Promise.all([
        getMemorySettings(input.userId),
        prisma.conversation.findFirst({
            where: { id: input.conversationId, userId: input.userId },
            select: { password: true, memoryMode: true, kind: true },
        }),
        isMemoryExtractionEnabled(),
    ]);
    if (!conversation || conversation.kind !== "chat") return { outcome: "skipped", reason: "not_chat" };
    const gate = nativeExtractionAllowed({
        operatorEnabled: projectAutoMemoryOperatorEnabled(environment) && featureEnabled,
        accountMemoryEnabled: settings.masterEnabled,
        conversationMemoryOn: resolveConversationMemoryMode(conversation.memoryMode, settings.defaultConversationMode) === "on",
        project,
        conversationLocked: conversation.password !== null,
    });
    if (!gate.allowed) return { outcome: "skipped", reason: gate.reason };

    const runs = await lastSnapshot(input.userId, input.conversationId);
    if (runs.some((run) => run.status === "pending" || run.status === "running")) {
        return { outcome: "skipped", reason: "snapshot_in_progress" };
    }
    // The cursor is the newest snapshot that did not fail; a failed one is
    // retried (as a new snapshot covering the same window) after a pause.
    const settled = runs.find((run) => run.status !== "failed" && isNativeExtractionSelection(run.sourceSelection));
    const recentFailures = runs.filter((run) => run.status === "failed" &&
        now.getTime() - run.createdAt.getTime() < NATIVE_RETRY_AFTER_MS * NATIVE_MAX_FAILED_RUNS);
    if (recentFailures.length >= NATIVE_MAX_FAILED_RUNS) return { outcome: "skipped", reason: "too_many_failures" };
    if (recentFailures[0] && now.getTime() - recentFailures[0].createdAt.getTime() < NATIVE_RETRY_AFTER_MS &&
        (!settled || recentFailures[0].createdAt > settled.createdAt)) {
        return { outcome: "skipped", reason: "retry_later" };
    }
    const cursor = settled && isNativeExtractionSelection(settled.sourceSelection) ? settled.sourceSelection : null;
    const afterWhere: Prisma.MessageWhereInput = cursor
        ? {
              OR: [
                  { createdAt: { gt: new Date(cursor.throughMessageCreatedAt) } },
                  { createdAt: new Date(cursor.throughMessageCreatedAt), id: { gt: cursor.throughMessageId } },
              ],
          }
        : {};
    const window = await prisma.message.findMany({
        where: {
            conversationId: input.conversationId,
            conversation: { userId: input.userId },
            role: { in: ["user", "assistant"] },
            ...afterWhere,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, role: true, content: true, createdAt: true },
    });
    // Only the user's own words can ground a memory; a window of answers only
    // has nothing to extract.
    if (!window.some((message) => message.role === "user")) {
        return { outcome: "skipped", reason: "nothing_new" };
    }
    const through = window[window.length - 1];
    const selection: NativeExtractionSelection = {
        kind: "native",
        projectId: project!.projectId,
        conversationId: input.conversationId,
        afterMessageCreatedAt: cursor?.throughMessageCreatedAt ?? null,
        afterMessageId: cursor?.throughMessageId ?? null,
        throughMessageCreatedAt: through.createdAt.toISOString(),
        throughMessageId: through.id,
    };
    const register = input.register ?? MEMORY_EXTRACTION_EVAL_REGISTER;
    const pair = await automaticExtractionPair(register);
    if (!pair) return { outcome: "skipped", reason: "no_approved_pair" };
    try {
        const run = await createNativeMemoryExtractionRun({
            userId: input.userId,
            projectId: project!.projectId,
            conversationId: input.conversationId,
            sourceKey: nativeExtractionSourceKey(input.conversationId, through.id) +
                (recentFailures.length ? `:retry${recentFailures.length}` : ""),
            sourceSelection: selection as unknown as Prisma.InputJsonValue,
            contentBytes: window.reduce((total, message) => total + Buffer.byteLength(message.content, "utf8"), 0),
            ...pair,
            register,
            now,
            environment,
        });
        if (input.kick) await input.kick(run.id);
        else {
            const { kickMemoryExtractionRun } = await import("@/lib/memoryExtractionWorker");
            void kickMemoryExtractionRun(run.id).catch(() => undefined);
        }
        return { outcome: "started", runId: run.id };
    } catch (error) {
        if (error instanceof ApiSecurityError || error instanceof ChatAccessError) {
            return { outcome: "skipped", reason: error.code };
        }
        throw error;
    }
}

/**
 * The worker's read of a native run's window. Re-checked at read time: the
 * conversation must still be this account's, in the run's project and
 * unlocked; a conversation that moved or was locked returns nothing, and the
 * chunk is skipped (not charged).
 */
export async function loadNativeChunkConversation(input: {
    userId: string;
    projectId: string | null;
    selection: unknown;
}): Promise<{ conversations: ExtractionSourceConversationInput[]; contentBytes: number }> {
    if (!input.projectId || !isNativeExtractionSelection(input.selection) || input.selection.projectId !== input.projectId) {
        return { conversations: [], contentBytes: 0 };
    }
    const selection = input.selection;
    const conversation = await prisma.conversation.findFirst({
        where: { id: selection.conversationId, userId: input.userId, projectId: input.projectId, password: null },
        select: { id: true, title: true },
    });
    if (!conversation) return { conversations: [], contentBytes: 0 };
    const after = selection.afterMessageCreatedAt && selection.afterMessageId
        ? {
              OR: [
                  { createdAt: { gt: new Date(selection.afterMessageCreatedAt) } },
                  { createdAt: new Date(selection.afterMessageCreatedAt), id: { gt: selection.afterMessageId } },
              ],
          }
        : {};
    const through = new Date(selection.throughMessageCreatedAt);
    const messages = await prisma.message.findMany({
        where: {
            conversationId: conversation.id,
            role: { in: ["user", "assistant"] },
            AND: [
                after,
                { OR: [{ createdAt: { lt: through } }, { createdAt: through, id: { lte: selection.throughMessageId } }] },
            ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, role: true, content: true },
    });
    if (!messages.some((message) => message.role === "user")) return { conversations: [], contentBytes: 0 };
    return {
        conversations: [{
            externalConversationId: conversation.id,
            title: conversation.title,
            messages: messages.map((message) => ({
                externalMessageId: message.id,
                role: message.role as "user" | "assistant",
                content: message.content,
                contentDigest: nativeMessageDigest(message.content),
                sourceType: "tomverse_message" as const,
            })),
        }],
        contentBytes: messages.reduce((total, message) => total + Buffer.byteLength(message.content, "utf8"), 0),
    };
}

/** The last-moment lock and membership check before a native call leaves. */
export async function nativeSourceStillReadable(input: { userId: string; projectId: string | null; conversationIds: readonly string[] }) {
    if (!input.projectId) return false;
    const readable = await prisma.conversation.count({
        where: { id: { in: [...input.conversationIds] }, userId: input.userId, projectId: input.projectId, password: null },
    });
    return readable === input.conversationIds.length;
}
