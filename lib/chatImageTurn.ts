import "server-only";

import { Prisma } from "@prisma/client";
import { chatImageTriageModelId } from "@/lib/chatImageIntent";
import { CHAT_IMAGE_TURN_CONTENT_PREFIX, chatImageTurnGroupKey } from "@/lib/chatImageTurnCore";
import { ChatAccessError } from "@/lib/chatSecurity";
import { isChatConversationKind } from "@/lib/conversationKindGuard";
import { isUniqueConstraintDatabaseError } from "@/lib/databaseError";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import {
    IMAGE_QUALITY_BY_PRESET,
    imageEditPricing,
    type ImagePreset,
    type ImageSize,
} from "@/lib/imageGenerationPricing";
import { findChatImageEditSource } from "@/lib/imageEditSource";
import { requestImageGeneration } from "@/lib/imageGenerationService";
import { DEFAULT_IMAGE_MODEL_ID, getImageModel } from "@/lib/imageModelRegistry";
import { prisma } from "@/lib/prisma";

/**
 * One Chat or Review turn answered with an image instead of text
 * (docs/policy/image-generation.md §13 ⑥, owner decision 2026-10-20: in
 * Chat the image appears in the conversation; Review follows it on 2026-10-23).
 *
 * The user's message is already saved by the ordinary send. This reserves
 * the image through `requestImageGeneration` -- the same gates, reservation,
 * settlement and provider budget as the image workspace -- attached to the
 * chat conversation itself, and writes the assistant message the image
 * answers with. The group's idempotency key is the assistant message id, so
 * a retry replays the same group rather than paying twice, and a transcript
 * read finds the group from the message without a new column.
 */
export type ChatImageTurnInput = {
    userId: string;
    conversationId: string;
    sourceUserMessageId: string;
    assistantMessageId: string;
    /** The panel's chat model, stored on the answer like any other. */
    modelId: string;
    imageModelIds: string[];
    imageGroupModelIds?: string[];
    /**
     * Each Review panel's chat model, in `imageGroupModelIds` order. With it,
     * the request that reserves the group writes every panel's answer
     * (`<group>_<i>`), so an image that was paid for is in the conversation
     * whether or not that panel's own request ever lands. An older client
     * that does not send it keeps the one-answer-per-request behaviour.
     */
    imageGroupPanelModelIds?: string[];
    preset: ImagePreset | null;
    /** A follow-up's rewritten prompt; the saved question otherwise. */
    prompt?: string;
    /**
     * Change the photo attached to the question instead of drawing a new
     * image. The photo is found from the saved question, never named here.
     */
    edit?: boolean;
    request?: Request;
};

export type ChatImageTurnResult = {
    groupId: string;
    /** The image models in the group, in target order. */
    imageModelIds: string[];
    content: string;
    /**
     * Generations still waiting to start; the route drives them after
     * responding. A replay included: if the first request's executor never
     * ran (the response was lost before after()), the retry is what starts
     * them. The claim in processImageGeneration lets only one runner take each.
     */
    pendingGenerationIds: string[];
};

type PanelAnswer = { id: string; modelId: string };

const panelAnswerConflict = () =>
    new ChatAccessError(409, "ASSISTANT_MESSAGE_CONFLICT", "That answer id is taken.");

const isPanelAnswerConflict = (error: unknown) =>
    error instanceof ChatAccessError && error.code === "ASSISTANT_MESSAGE_CONFLICT";

/** Whether every panel id is already this conversation's image answer. */
const panelAnswersInPlace = async (conversationId: string, answers: readonly PanelAnswer[]) => {
    const rows = await prisma.message.findMany({
        where: { id: { in: answers.map((answer) => answer.id) } },
        select: { id: true, conversationId: true, role: true, content: true },
    });
    return answers.every((answer) => rows.some((row) =>
        row.id === answer.id &&
        row.conversationId === conversationId &&
        row.role === "assistant" &&
        row.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX)));
};

/**
 * Writes every Review panel's answer that is not there yet, in the caller's
 * transaction, or refuses the whole write.
 *
 * Each id must be free or already this conversation's image answer (a replay,
 * or the request that wrote them all). Nothing is skipped: the insert has no
 * `skipDuplicates`, so a row another writer took after the read fails it, and
 * the caller's transaction -- the image reservation itself, for a new group --
 * rolls back with it. A reserved group therefore always has an answer for
 * every panel. Returns how many rows it wrote.
 */
const writePanelAnswers = async (
    db: Prisma.TransactionClient,
    conversationId: string,
    answers: readonly PanelAnswer[],
    content: string
): Promise<number> => {
    const held = await db.message.findMany({
        where: { id: { in: answers.map((answer) => answer.id) } },
        select: { id: true, conversationId: true, role: true, content: true },
    });
    if (held.some((row) =>
        row.conversationId !== conversationId ||
        row.role !== "assistant" ||
        !row.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX))) {
        throw panelAnswerConflict();
    }
    const missing = answers.filter((answer) => !held.some((row) => row.id === answer.id));
    if (missing.length === 0) return 0;
    try {
        await db.message.createMany({
            data: missing.map((answer) => ({
                id: answer.id,
                conversationId,
                role: "assistant",
                content,
                modelId: answer.modelId,
            })),
        });
    } catch (error) {
        if (isUniqueConstraintDatabaseError(error)) throw panelAnswerConflict();
        throw error;
    }
    return missing.length;
};

/** What the answer's text says: read by later turns and by exports. */
export const chatImageTurnContent = (prompt: string) =>
    `${CHAT_IMAGE_TURN_CONTENT_PREFIX} ${prompt.trim().slice(0, 500)}`;

export async function startChatImageTurn(
    input: ChatImageTurnInput
): Promise<ChatImageTurnResult> {
    const conversation = await prisma.conversation.findFirst({
        where: { id: input.conversationId, userId: input.userId },
        select: {
            kind: true,
            productKey: true,
            password: true, passwordVersion: true,
            continuationBridge: { select: { id: true } },
        },
    });
    if (!conversation) {
        throw new ChatAccessError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    }
    // Only explicit product identities grant the in-conversation image host.
    // Continued conversations and image-workspace rows are still excluded.
    if (
        !isChatConversationKind(conversation.kind) ||
        !["chat", "review"].includes(conversation.productKey ?? "") ||
        conversation.continuationBridge !== null
    ) {
        throw new ChatAccessError(
            409,
            "CONVERSATION_KIND_NOT_SUPPORTED",
            "This conversation does not support chat image turns."
        );
    }
    if (conversation.productKey === "chat" && !(await chatImageTriageModelId())) {
        throw new ChatAccessError(403, "CHAT_IMAGE_TURN_DISABLED", "Images in chat are not enabled.");
    }
    if (conversation.password &&
        (!input.request || !hasConversationUnlockGrant(input.request, input.userId, input.conversationId, conversation.password == null ? null : conversation.passwordVersion))) {
        throw new ChatAccessError(403, "CONVERSATION_LOCKED", "Unlock this conversation before generating images.");
    }

    const source = await prisma.message.findFirst({
        where: {
            id: input.sourceUserMessageId,
            conversationId: input.conversationId,
            role: "user",
        },
        select: { content: true },
    });
    // The question is the saved one, never text the request carries; a
    // follow-up's rewrite (input.prompt) only changes what the image is made
    // from, not what the answer says was asked.
    const prompt = source?.content.trim() ?? "";
    if (!prompt) {
        throw new ChatAccessError(404, "SOURCE_MESSAGE_NOT_FOUND", "The question was not found.");
    }

    const existing = await prisma.message.findUnique({
        where: { id: input.assistantMessageId },
        select: { conversationId: true, role: true, content: true },
    });
    // A replay is only of an image answer: reusing a text answer's id would
    // reserve an image the transcript can never show.
    if (
        existing &&
        (existing.conversationId !== input.conversationId ||
            existing.role !== "assistant" ||
            !existing.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX))
    ) {
        throw new ChatAccessError(409, "ASSISTANT_MESSAGE_CONFLICT", "That answer id is taken.");
    }

    const isReview = conversation.productKey === "review";
    if (input.imageGroupModelIds && (!isReview || input.imageModelIds.length !== 1 ||
        [...input.imageGroupModelIds].sort()[Number(input.assistantMessageId.split("_").at(-1))] !== input.imageModelIds[0] ||
        chatImageTurnGroupKey(input.assistantMessageId) === input.assistantMessageId)) {
        throw new ChatAccessError(400, "IMAGE_MODEL_SELECTION_INVALID", "Invalid comparison image selection.");
    }
    // Every panel's answer, named by its index in the sorted group and owned
    // by that panel's chat model. Checked whole: one image model per panel,
    // one panel per image model, and this request's own panel where it says.
    const groupKey = chatImageTurnGroupKey(input.assistantMessageId);
    const sortedGroup = input.imageGroupModelIds ? [...input.imageGroupModelIds].sort() : null;
    const panelAnswers = input.imageGroupModelIds && input.imageGroupPanelModelIds
        ? input.imageGroupModelIds.map((imageModelId, position) => ({
              id: `${groupKey}_${sortedGroup!.indexOf(imageModelId)}`,
              modelId: input.imageGroupPanelModelIds![position],
          }))
        : null;
    if (input.imageGroupPanelModelIds && (!panelAnswers ||
        input.imageGroupPanelModelIds.length !== input.imageGroupModelIds!.length ||
        new Set(input.imageGroupModelIds).size !== input.imageGroupModelIds!.length ||
        new Set(input.imageGroupPanelModelIds).size !== input.imageGroupPanelModelIds!.length ||
        panelAnswers.find((answer) => answer.id === input.assistantMessageId)?.modelId !== input.modelId)) {
        throw new ChatAccessError(400, "IMAGE_MODEL_SELECTION_INVALID", "Invalid comparison image selection.");
    }
    // Every panel's answer id has to be free, or already this conversation's
    // image answer, before anything is held: an early refusal for the ordinary
    // case. It is not the guarantee -- `writePanelAnswers` re-reads inside the
    // reservation transaction and inserts without skipping, so a row taken in
    // between rolls the reservation back. The conversation is this user's
    // (checked at the top), so its rows are too.
    if (panelAnswers) {
        const held = await prisma.message.findMany({
            where: { id: { in: panelAnswers.map((answer) => answer.id) } },
            select: { id: true, conversationId: true, role: true, content: true },
        });
        if (held.some((row) =>
            row.conversationId !== input.conversationId ||
            row.role !== "assistant" ||
            !row.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX))) {
            throw panelAnswerConflict();
        }
    }
    let panelAnswersWritten = 0;
    // An edit starts from the question's own photo, looked up from the saved
    // message so a request can never point an edit at another file.
    let editSource: { attachmentId: string } | undefined;
    const selectedImages = input.imageGroupModelIds ?? input.imageModelIds;
    const singleModel = selectedImages.length === 1 ? getImageModel(selectedImages[0]) : null;
    let size: ImageSize = singleModel?.sizes.length === 1 ? singleModel.sizes[0] : "1024x1024";
    if (input.edit) {
        if (isReview) {
            throw new ChatAccessError(400, "IMAGE_EDIT_NOT_SUPPORTED", "Review does not edit photos.");
        }
        const source = await findChatImageEditSource({
            userId: input.userId,
            conversationId: input.conversationId,
            sourceUserMessageId: input.sourceUserMessageId,
        });
        if (!source) {
            throw new ChatAccessError(400, "IMAGE_EDIT_SOURCE_MISSING", "Attach the photo to edit.");
        }
        editSource = { attachmentId: source.attachmentId };
        // Keep the photo's shape when all targets sell it. A single target
        // with a fixed edit size uses that native option.
        const editModelIds = input.imageModelIds.length > 0 ? input.imageModelIds : [DEFAULT_IMAGE_MODEL_ID];
        const onlyEditSize = editModelIds.length === 1 ? imageEditPricing(editModelIds[0])?.option?.size : undefined;
        size = editModelIds.every((modelId) => {
            const editSize = imageEditPricing(modelId)?.option?.size;
            return (!editSize || editSize === source.size) && getImageModel(modelId)?.sizes.includes(source.size);
        }) ? source.size : onlyEditSize ?? "1024x1024";
    }
    const result = await requestImageGeneration({
        userId: input.userId,
        // The answer's text still names the question that was asked.
        prompt: input.prompt?.trim() || prompt,
        size,
        quality: IMAGE_QUALITY_BY_PRESET[input.preset ?? "standard"],
        conversationId: input.conversationId,
        idempotencyKey: input.imageGroupModelIds ? chatImageTurnGroupKey(input.assistantMessageId) : input.assistantMessageId,
        modelIds: input.imageGroupModelIds ?? (input.imageModelIds.length > 0 ? input.imageModelIds : undefined),
        chatTurnHost: true,
        ...(editSource ? { editSource } : {}),
        /*
          The group is reserved for every panel at once, so every panel's
          answer is written in that same transaction: a conflict rolls the
          reservation back with it, and a group that exists has an answer for
          each panel. Before this, each panel wrote only its own answer after
          the reservation committed, and a panel whose request was refused (a
          rate limit) or never sent -- or whose id another row took -- left its
          image charged and nowhere in the conversation (lib/chatImageTurnRead.ts
          shows a group's image only beside its `<group>_<i>` answer). Runs
          after the reservation's account and scope locks and takes none of its
          own.
        */
        ...(panelAnswers
            ? {
                  onReserved: async (tx: Prisma.TransactionClient) => {
                      panelAnswersWritten = await writePanelAnswers(
                          tx, input.conversationId, panelAnswers, chatImageTurnContent(prompt)
                      );
                  },
              }
            : {}),
    });

    if (result.conversationId !== input.conversationId || (input.imageGroupModelIds &&
        [...result.targets.map(target => target.modelId)].sort().join("\n") !== [...input.imageGroupModelIds].sort().join("\n"))) {
        throw new ChatAccessError(409, "ASSISTANT_MESSAGE_CONFLICT", "That image request belongs to another turn.");
    }
    const content = existing?.content ?? chatImageTurnContent(prompt);
    if (panelAnswers) {
        // A replay of a group that already existed: this request reserved
        // nothing, and writes only answers an older client's group never got,
        // all or none.
        if (result.reused) {
            try {
                panelAnswersWritten = await prisma.$transaction((tx) =>
                    writePanelAnswers(tx, input.conversationId, panelAnswers, chatImageTurnContent(prompt))
                );
            } catch (error) {
                // Two replays of an older client's group, both writing the
                // answers it lacked: the second one's insert meets the
                // first one's rows. Read again, outside the aborted
                // transaction; if every panel now has this conversation's
                // image answer, the replay has what it came for.
                if (!(isPanelAnswerConflict(error) &&
                    await panelAnswersInPlace(input.conversationId, panelAnswers))) {
                    throw error;
                }
            }
        }
        if (panelAnswersWritten > 0) {
            await prisma.conversation.update({
                where: { id: input.conversationId },
                data: { updatedAt: new Date() },
            });
        }
    } else if (!existing) {
        try {
            await prisma.message.create({
                data: {
                    id: input.assistantMessageId,
                    conversationId: input.conversationId,
                    role: "assistant",
                    content,
                    modelId: input.modelId,
                },
            });
        } catch (error) {
            // A concurrent replay wrote it first; the group is the same one.
            if (
                !(error instanceof Prisma.PrismaClientKnownRequestError) ||
                error.code !== "P2002"
            ) {
                throw error;
            }
        }
        await prisma.conversation.update({
            where: { id: input.conversationId },
            data: { updatedAt: new Date() },
        });
    }

    return {
        groupId: result.groupId,
        imageModelIds: result.targets.map((target) => target.modelId)
            .filter(id => !input.imageGroupModelIds || input.imageModelIds.includes(id)),
        content,
        pendingGenerationIds: result.targets
            .filter((target) => target.status === "pending")
            .map((target) => target.generationId),
    };
}
