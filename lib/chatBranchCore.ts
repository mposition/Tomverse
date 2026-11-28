/**
 * "Branch from this answer": the pure rules of which turns a branch copies and
 * how its words are written. The database work is lib/chatConversationBranch.ts.
 *
 * A branch is a new Chat conversation holding the text turns up to and
 * including one answer. The source conversation is never touched.
 */

/** A copied turn: the stored fields a plain text turn needs, nothing else. */
export type BranchSourceMessage = {
  id: string;
  role: string;
  content: string;
  status: string;
  modelId: string | null;
  supersededAt: Date | null;
  researchRunId: string | null;
  createdAt: Date;
};

/** The answer a branch can start from: a finished, standing, plain-text answer. */
export const isBranchableAnswer = (message: BranchSourceMessage): boolean =>
  message.role === "assistant" &&
  message.status === "normal" &&
  message.supersededAt === null &&
  message.researchRunId === null &&
  message.content.trim().length > 0;

/**
 * The messages a branch copies: every standing, finished message up to and
 * including `targetId`, in the order given. Replaced turns (Regenerate / edit)
 * and failed or stopped answers are left out, as they are from the model's own
 * context. Null when `targetId` is not in the list.
 */
export function messagesToCopy<T extends BranchSourceMessage>(
  ordered: readonly T[],
  targetId: string
): T[] | null {
  const index = ordered.findIndex((message) => message.id === targetId);
  if (index < 0) return null;
  return ordered
    .slice(0, index + 1)
    .filter((message) => message.status === "normal" && message.supersededAt === null);
}

/**
 * Creation times that keep the copied order under the read order
 * (createdAt, id): the source times, nudged by a millisecond where two would
 * tie, because the new ids carry no order of their own.
 */
export function orderedCreatedAt(times: readonly Date[]): Date[] {
  const result: Date[] = [];
  for (const time of times) {
    const previous = result.at(-1);
    result.push(previous && time.getTime() <= previous.getTime() ? new Date(previous.getTime() + 1) : time);
  }
  return result;
}

export const BRANCH_TEMPLATE_MAX_CHARACTERS = 160;
const DEFAULT_TITLE_TEMPLATE = "Branch: {title}";
const DEFAULT_FILES_TEMPLATE = "[Files not copied to this conversation: {names}]";
export const BRANCH_TITLE_MAX_CHARACTERS = 120;

/** A client-supplied template is used only if it is short, plain text with its placeholder. */
export function validBranchTemplate(value: unknown, placeholder: "{title}" | "{names}"): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > BRANCH_TEMPLATE_MAX_CHARACTERS || !text.includes(placeholder)) return null;
  return /[\u0000-\u001f\u007f]/.test(text) ? null : text;
}

export function branchTitle(original: string, template: string | null): string {
  const base = original.trim() || "New chat";
  const pattern = template ?? DEFAULT_TITLE_TEMPLATE;
  const room = Math.max(1, BRANCH_TITLE_MAX_CHARACTERS - (pattern.length - "{title}".length));
  const cut = base.length > room ? `${base.slice(0, Math.max(1, room - 1))}…` : base;
  return pattern.replace("{title}", () => cut).slice(0, BRANCH_TITLE_MAX_CHARACTERS);
}

/** The note appended to a copied turn whose files were not copied. */
export function omittedFilesNote(names: readonly string[], template: string | null): string {
  const shown = names.slice(0, 5).join(", ");
  const rest = names.length > 5 ? `, +${names.length - 5}` : "";
  return (template ?? DEFAULT_FILES_TEMPLATE).replace("{names}", () => `${shown}${rest}`);
}
