/**
 * Which messages of a chat request are copies of replaced turns, when the
 * request does not say by id (the id is optional in the chat API).
 *
 * Text alone cannot tell: a regenerate asks the same question again, and a
 * conversation may hold the same question asked earlier in the ordinary way.
 * Position can. A request transcript is the stored conversation in order, with
 * some turns possibly already left out by the client, so the request is
 * aligned to the stored rows as a sequence (a longest common subsequence):
 *
 *  - a message with an id matches only its own row; one without matches a row
 *    of the same role and text;
 *  - the alignment keeps as many matches as possible and, among those, places
 *    as many messages as possible on rows that stand. A message lands on a
 *    replaced row only when nothing else lines up.
 *
 * The last message is the one being answered and is never aligned or left out.
 * Pure: no database, no clock.
 */

export type AlignmentRow = { id: string; role: string; content: string; replaced: boolean };
export type AlignmentMessage = { id?: string; role?: string; content?: unknown };

/** Above this many cells the alignment is skipped and only ids are used. */
export const MAX_ALIGNMENT_CELLS = 4_000_000;

export function replacedMessageIndexes(
  messages: readonly AlignmentMessage[],
  rows: readonly AlignmentRow[],
  sameId: (messageId: string, rowId: string) => boolean,
  maxCells: number = MAX_ALIGNMENT_CELLS
): Set<number> {
  const n = Math.max(0, messages.length - 1);
  const m = rows.length;
  const replaced = new Set<number>();
  if (n === 0 || m === 0) return replaced;

  const matches = (i: number, j: number) => {
    const message = messages[i]!;
    const row = rows[j]!;
    if (message.id) return sameId(message.id, row.id);
    return message.role === row.role && typeof message.content === "string" && message.content === row.content;
  };

  // A message named by id is its row's, wherever the alignment puts it.
  for (let i = 0; i < n; i += 1) {
    const id = messages[i]!.id;
    if (id && rows.some((row) => row.replaced && sameId(id, row.id))) replaced.add(i);
  }
  if ((n + 1) * (m + 1) > maxCells) return replaced;

  // Weights make the order lexicographic: more matches first, then more of
  // them on standing rows (a standing match is worth one more than a replaced one).
  const replacedWeight = n + 1;
  const standingWeight = n + 2;
  const width = m + 1;
  const score = new Int32Array((n + 1) * width);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      let best = Math.max(score[(i - 1) * width + j]!, score[i * width + j - 1]!);
      if (matches(i - 1, j - 1)) {
        const weight = rows[j - 1]!.replaced ? replacedWeight : standingWeight;
        best = Math.max(best, score[(i - 1) * width + j - 1]! + weight);
      }
      score[i * width + j] = best;
    }
  }

  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const here = score[i * width + j]!;
    if (matches(i - 1, j - 1)) {
      const weight = rows[j - 1]!.replaced ? replacedWeight : standingWeight;
      if (here === score[(i - 1) * width + j - 1]! + weight) {
        if (rows[j - 1]!.replaced) replaced.add(i - 1);
        i -= 1;
        j -= 1;
        continue;
      }
    }
    if (here === score[(i - 1) * width + j]!) i -= 1;
    else j -= 1;
  }
  return replaced;
}
