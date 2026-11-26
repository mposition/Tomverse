import { gapFilledModelTranscript } from "../../../lib/chatTranscriptGapFill";
import type { ChatConversation } from "./chat-contract";

export type ReviewMessage = ChatConversation["messages"][number];
export type ColumnTurn = { question: ReviewMessage; answers: ReviewMessage[] };

/**
 * One model column of a saved Review: the questions everyone was asked, the follow-ups put to this model alone,
 * and this model's answers. A question put to another model alone stays out, and an answer from a model that
 * no longer has a column is carried into the column that has none for that question (the web transcript rule).
 */
export function columnTurns(messages: readonly ReviewMessage[], modelId: string, columnIds: Iterable<string>): ColumnTurn[] {
  // The shared rule reads only id, role, modelId, status and content, which the Desktop message carries as well.
  const view = gapFilledModelTranscript(messages as unknown as Parameters<typeof gapFilledModelTranscript>[0], modelId, columnIds) as unknown as ReviewMessage[];
  const turns: ColumnTurn[] = [];
  for (const message of view) {
    if (message.role === "user") turns.push({ question: message, answers: [] });
    else if (message.role === "assistant") turns.at(-1)?.answers.push(message);
  }
  return turns;
}

/** The models in the order the user arranged them; a model the arrangement does not name follows in its own order. */
export function arrangeColumns(columnIds: readonly string[], arrangement: readonly string[]): string[] {
  const position = (id: string, index: number) => arrangement.includes(id) ? arrangement.indexOf(id) : arrangement.length + index;
  return columnIds.map((id, index) => ({ id, at: position(id, index) })).sort((a, b) => a.at - b.at).map(({ id }) => id);
}

/** `id` takes the place `target` had; the columns between them shift by one. */
export function moveColumn(columnIds: readonly string[], id: string, target: string): string[] {
  const from = columnIds.indexOf(id);
  const to = columnIds.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...columnIds];
  const next = [...columnIds];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** `id` one place earlier (-1) or later (1); at either end it stays where it is. */
export function shiftColumn(columnIds: readonly string[], id: string, direction: -1 | 1): string[] {
  const from = columnIds.indexOf(id);
  const to = from + direction;
  return from < 0 || to < 0 || to >= columnIds.length ? [...columnIds] : moveColumn(columnIds, id, columnIds[to]!);
}
