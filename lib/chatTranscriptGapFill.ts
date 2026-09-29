import type { Message } from "@/components/chat/types";

/**
 * One panel's view of a conversation, with no question left unanswered that
 * some other model did answer.
 *
 * A panel shows every shared question and only its own model's answers. That
 * is right while the panel keeps its model, and wrong the moment it changes:
 * swap GPT-5.6 Luna for GPT-5.4 mini and every earlier turn shows a question
 * with nothing under it, because mini never answered any of them. The answers
 * still exist -- they belong to a model no panel shows any more -- and the
 * next send carried the bare questions to mini, images and all, with none of
 * the answers they had received.
 *
 * So a turn this model never answered borrows the answer from the model that
 * did, and that answer goes to the provider as part of the conversation too.
 * Three limits keep this honest:
 *
 * - Only a turn with no answer from this model is filled. A turn this model
 *   answered, failed or was stopped on is left exactly as it was.
 * - Only an answer that no other panel shows is borrowed. A comparison's
 *   other columns already display theirs, and copying them in would make the
 *   columns stop being independent answers to the same question.
 * - The borrowed answer keeps its own `modelId`, so it is drawn under its own
 *   model's name and logo, and it is marked `carriedAnswer` so it is never
 *   persisted as this model's.
 */
export function gapFilledModelTranscript(
  messages: readonly Message[],
  modelId: string,
  otherPanelModelIds: Iterable<string> = []
): Message[] {
  const shownElsewhere = new Set(otherPanelModelIds);
  shownElsewhere.delete(modelId);
  const seen = new Set<string>();
  const view: Message[] = [];
  let answeredByThisModel = true;
  let borrowable: Message | null = null;
  // A follow-up asked of one other model only. Its answers belong to it, and
  // must not be mistaken for answers to the shared question before it.
  let inOtherModelsTurn = false;

  const closeTurn = () => {
    if (!answeredByThisModel && borrowable) {
      view.push({ ...borrowable, carriedAnswer: true });
    }
    answeredByThisModel = true;
    borrowable = null;
  };

  for (const message of messages) {
    if (seen.has(message.id)) continue;
    if (message.role === "user") {
      if (message.modelId && message.modelId !== modelId) {
        inOtherModelsTurn = true;
        continue;
      }
      seen.add(message.id);
      closeTurn();
      view.push(message);
      answeredByThisModel = false;
      inOtherModelsTurn = false;
      continue;
    }
    if (message.role !== "assistant" || !message.modelId) continue;
    if (message.modelId === modelId) {
      seen.add(message.id);
      view.push(message);
      answeredByThisModel = true;
      continue;
    }
    if (inOtherModelsTurn) continue;
    if (
      !shownElsewhere.has(message.modelId) &&
      isCompletedAnswer(message)
    ) {
      seen.add(message.id);
      borrowable = message;
    }
  }
  closeTurn();
  return view;
}

const isCompletedAnswer = (message: Message) =>
  message.status !== "error" &&
  message.status !== "cancelled" &&
  message.status !== "pending" &&
  (message.content.trim().length > 0 ||
    (message.attachments?.length ?? 0) > 0 ||
    (message.artifacts?.length ?? 0) > 0);

/**
 * Every guest transcript of one conversation, merged into one ordered list.
 *
 * A guest's history lives per model in localStorage, so the model a panel was
 * switched to starts with nothing at all -- not even the questions. Merging
 * the other models' transcripts gives `gapFilledModelTranscript` the same
 * input a signed-in panel gets from the server: the shared questions, in
 * order, each followed by the answers every model gave it.
 *
 * Order is taken from the transcripts themselves rather than from
 * timestamps, which older guest messages do not carry: a question first seen
 * in one transcript is placed after the last question that transcript shared
 * with what has been merged so far.
 */
export function mergeGuestTranscripts(
  transcripts: ReadonlyArray<readonly Message[]>
): Message[] {
  type Turn = { question: Message | null; answers: Message[] };
  const turns: Turn[] = [{ question: null, answers: [] }];
  const turnIndexByQuestionId = new Map<string, number>();
  const answerIds = new Set<string>();

  for (const transcript of transcripts) {
    let current = 0;
    for (const message of transcript) {
      if (message.role === "user") {
        const known = turnIndexByQuestionId.get(message.id);
        if (known !== undefined) {
          current = known;
          continue;
        }
        const index = current + 1;
        turns.splice(index, 0, { question: message, answers: [] });
        for (const [id, at] of turnIndexByQuestionId) {
          if (at >= index) turnIndexByQuestionId.set(id, at + 1);
        }
        turnIndexByQuestionId.set(message.id, index);
        current = index;
        continue;
      }
      if (answerIds.has(message.id)) continue;
      answerIds.add(message.id);
      turns[current].answers.push(message);
    }
  }

  return turns.flatMap((turn) =>
    turn.question ? [turn.question, ...turn.answers] : turn.answers
  );
}
