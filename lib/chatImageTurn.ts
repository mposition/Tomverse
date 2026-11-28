import "server-only";

import { Prisma } from "@prisma/client";
import { assertMessageCapacity } from "@/lib/apiSecurity";
import { chatImageTriageModelId } from "@/lib/chatImageIntent";
import {
    CHAT_IMAGE_TURN_CONTENT_PREFIX,
    IMAGE_EDIT_SOURCE_TOO_LARGE,
    chatImageTurnGroupKey,
    imageEditSourceRefusalCode,
} from "@/lib/chatImageTurnCore";
import { ChatAccessError } from "@/lib/chatSecurity";
import { isChatConversationKind } from "@/lib/conversationKindGuard";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import { isUniqueConstraintDatabaseError } from "@/lib/databaseError";
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
     * (`<group>_<i>`) in the reservation's own transaction, so an image that
     * was paid for is in the conversation even when that panel's own request
     * is refused (the image allowance's 429) or never sent. An older client
     * that does not send it keeps one answer per request.
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
     * ran (its answer write failed, or the response was lost before after()),
     * the retry is what starts them. The claim in processImageGeneration lets
     * only one runner take each.
     */
    pendingGenerationIds: string[];
};

/** What the answer's text says: read by later turns and by exports. */
export const chatImageTurnContent = (prompt: string) =>
    `${CHAT_IMAGE_TURN_CONTENT_PREFIX} ${prompt.trim().slice(0, 500)}`;

type PanelAnswer = { id: string; modelId: string };

const panelAnswerConflict = () =>
    new ChatAccessError(409, "ASSISTANT_MESSAGE_CONFLICT", "That answer id is taken.");

type HeldRow = { id: string; conversationId: string; role: string; content: string };

/** A row a panel answer may sit on: this conversation's own image answer. */
const isThisImageAnswer = (row: HeldRow, conversationId: string) =>
    row.conversationId === conversationId &&
    row.role === "assistant" &&
    row.content.startsWith(CHAT_IMAGE_TURN_CONTENT_PREFIX);

const readPanelRows = (db: Prisma.TransactionClient | typeof prisma, answers: readonly PanelAnswer[]) =>
    db.message.findMany({
        where: { id: { in: answers.map((answer) => answer.id) } },
        select: { id: true, conversationId: true, role: true, content: true },
    }) as Promise<HeldRow[]>;

/**
 * Writes every Review panel answer that is not there yet, in the caller's
 * transaction, or refuses the whole write.
 *
 * Each id must be free or already this conversation's image answer (a replay,
 * or the request that wrote them all); the conversation was checked to be
 * this user's, so its rows are too. The insert has no `skipDuplicates`: a row
 * another writer took after the read fails it, and the caller's transaction
 * -- the image reservation itself, for a new group -- rolls back with it. The
 * storage quota is checked under its own lock (assertMessageCapacity, taken
 * last, after the reservation's account and scope locks, as every other
 * writer takes it) for every row written. Returns how many rows it wrote.
 */
const writePanelAnswers = async (
    tx: Prisma.TransactionClient,
    userId: string,
    conversationId: string,
    answers: readonly PanelAnswer[],
    content: string
): Promise<number> => {
    const held = await readPanelRows(tx, answers);
    if (held.some((row) => !isThisImageAnswer(row, conversationId))) throw panelAnswerConflict();
    const missing = answers.filter((answer) => !held.some((row) => row.id === answer.id));
    if (missing.length === 0) return 0;
    await assertMessageCapacity(
        tx, userId, conversationId, missing.length, missing.length * Buffer.byteLength(content, "utf8")
    );
    try {
        await tx.message.createMany({
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

/**
 * Every Review panel's answer, named by its image model's index in the
 * sorted group and owned by that panel's chat model, or null without a panel
 * list. The list comes from the client, so it is checked whole: one panel per
 * image model, no image model or panel twice, and this request's own panel
 * where its answer id says.
 */
const reviewPanelAnswers = (input: ChatImageTurnInput): PanelAnswer[] | null => {
    const group = input.imageGroupModelIds;
    const panels = input.imageGroupPanelModelIds;
    if (!panels) return null;
    const invalid = () =>
        new ChatAccessError(400, "IMAGE_MODEL_SELECTION_INVALID", "Invalid comparison image selection.");
    if (!group || panels.length !== group.length ||
        new Set(group).size !== group.length || new Set(panels).size !== panels.length) {
        throw invalid();
    }
    const groupKey = chatImageTurnGroupKey(input.assistantMessageId);
    const sorted = [...group].sort();
    const answers = group.map((imageModelId, position) => ({
        id: `${groupKey}_${sorted.indexOf(imageModelId)}`,
        modelId: panels[position],
    }));
    if (answers.find((answer) => answer.id === input.assistantMessageId)?.modelId !== input.modelId) {
        throw invalid();
    }
    return answers;
};

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
            archivedAt: true,
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
    const panelAnswers = reviewPanelAnswers(input);
    // A cheap early refusal before anything is held. It is not the guarantee:
    // writePanelAnswers reads again inside the reservation and inserts without
    // skipping, so a row taken in between rolls the reservation back.
    if (panelAnswers &&
        (await readPanelRows(prisma, panelAnswers)).some((row) => !isThisImageAnswer(row, input.conversationId))) {
        throw panelAnswerConflict();
    }
    const answerContent = chatImageTurnContent(prompt);
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
        }).catch((error: unknown) => {
            // A photo too large or not decodable is refused here, by name,
            // before any credit is reserved -- not as a generic failure once
            // the edit runs.
            const code = imageEditSourceRefusalCode((error as { code?: unknown } | null)?.code);
            if (code) {
                throw new ChatAccessError(
                    code === IMAGE_EDIT_SOURCE_TOO_LARGE ? 413 : 400,
                    code,
                    code === IMAGE_EDIT_SOURCE_TOO_LARGE
                        ? "The photo is too large to edit."
                        : "The photo cannot be edited: its format is not supported."
                );
            }
            throw error;
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
          answer is written in that same transaction: a conflict or a full
          message quota rolls the reservation back with it, and a group that
          exists has an answer for each panel. Each panel used to write only
          its own answer after the reservation committed, so a panel whose
          request the image allowance refused left its image charged and
          nowhere in the conversation (lib/chatImageTurnRead.ts shows a
          group's image only beside its `<group>_<i>` answer).
        */
        ...(panelAnswers
            ? {
                  onReserved: async (tx: Prisma.TransactionClient) => {
                      panelAnswersWritten = await writePanelAnswers(
                          tx, input.userId, input.conversationId, panelAnswers, answerContent
                      );
                  },
              }
            : {}),
    });

    if (result.conversationId !== input.conversationId || (input.imageGroupModelIds &&
        [...result.targets.map(target => target.modelId)].sort().join("\n") !== [...input.imageGroupModelIds].sort().join("\n"))) {
        throw new ChatAccessError(409, "ASSISTANT_MESSAGE_CONFLICT", "That image request belongs to another turn.");
    }
    const content = existing?.content ?? answerContent;
    if (panelAnswers) {
        // A group that already existed: this request reserved nothing. Write
        // only the answers it lacks (an older client's group has one per
        // request), all or none, under the same quota check.
        if (result.reused) {
            try {
                panelAnswersWritten = await prisma.$transaction((tx) =>
                    writePanelAnswers(tx, input.userId, input.conversationId, panelAnswers, answerContent)
                );
            } catch (error) {
                // Two replays racing to write the same missing answers: the
                // second insert meets the first one's rows. Read again outside
                // the aborted transaction; if every panel now has this
                // conversation's image answer, the replay has what it came for.
                const settled = error instanceof ChatAccessError && error.code === "ASSISTANT_MESSAGE_CONFLICT" &&
                    await readPanelRows(prisma, panelAnswers).then((rows) => panelAnswers.every((answer) =>
                        rows.some((row) => row.id === answer.id && isThisImageAnswer(row, input.conversationId))));
                if (!settled) throw error;
            }
        }
        if (panelAnswersWritten > 0) {
            await prisma.conversation.update({
                where: { id: input.conversationId },
                data: { updatedAt: new Date(), ...(conversation.archivedAt ? { archivedAt: null } : {}) },
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
            // A new turn brings an archived conversation back
            // (lib/conversationArchive.ts); an unarchived one is not written.
            data: { updatedAt: new Date(), ...(conversation.archivedAt ? { archivedAt: null } : {}) },
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
