/**
 * Splitting a turn's messages into what the provider takes.
 *
 * `ai@7` refuses a system message inside `messages` unless
 * `allowSystemInMessages` is set, and wants the text in `instructions`
 * instead. So the array this application assembles -- which does carry system
 * blocks, because the deep research path hands the same array to Perplexity's
 * own API and the request manifest describes what was sent -- has to be split
 * before it reaches `streamText`.
 *
 * This is the second time the same failure has shipped. The first was Release
 * C, where a system message appeared only once a conversation had an assistant
 * profile, and the turn came back to the user as an empty answer
 * (trace 0dde1576-6bb8-4a19-bd8f-55f8e73d2b27). The fix then was written as a
 * conditional on the one branch that produced the block:
 *
 *     const sdkMessages = contextSystemPrompt ? messages.filter(...) : messages;
 *
 * which is correct exactly while that branch is the only source of system
 * messages. The generated-artifact feature added a second source -- every turn
 * now carries an artifact system block -- and the conditional then failed in
 * both directions at once: with no context prompt the block reached `messages`
 * and *every* turn died with `AI_InvalidPromptError`, and with one the block
 * was silently filtered away and never reached the model at all.
 *
 * So the split is unconditional and lives here: whatever system blocks the
 * array holds become `instructions`, in order, and `messages` never contains
 * one. A third source can be added without anyone having to remember this.
 */

import type { ModelMessage } from "ai";

export type ProviderPrompt = {
  /** Never contains a system message. */
  messages: ModelMessage[];
  /** Every system block, joined in order. Absent when there were none. */
  instructions?: string;
};

/**
 * The text of one system message.
 *
 * A system message's content is a string in every path this application
 * builds, but the type allows parts. Text parts are kept and anything else is
 * dropped rather than stringified -- a file in a system message is not
 * something `instructions` can carry, and `[object Object]` in a prompt is
 * worse than its absence.
 */
const systemText = (content: ModelMessage["content"]): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "type" in part && part.type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : ""
    )
    .filter(Boolean)
    .join("\n\n");
};

export const splitProviderInstructions = (
  messages: ModelMessage[]
): ProviderPrompt => {
  const blocks: string[] = [];
  const rest: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = systemText(message.content).trim();
      if (text) blocks.push(text);
      continue;
    }
    rest.push(message);
  }

  return blocks.length > 0
    ? { messages: rest, instructions: blocks.join("\n\n") }
    : { messages: rest };
};

/**
 * Providers whose chat endpoint rejects two consecutive messages of the same
 * role. Perplexity answers 400 ("user or tool message(s) should alternate with
 * assistant message(s)"); every other provider this app routes to either
 * merges adjacent turns itself or accepts them.
 *
 * Turn assembly can produce adjacent user turns on purpose: the memory
 * prelude and a continuation's untrusted-data block are separate user
 * messages in front of the real question (lib/chatTurnSystemBlocks.ts).
 */
const STRICT_ALTERNATION_PROVIDERS: ReadonlySet<string> = new Set(["perplexity"]);

export const requiresRoleAlternation = (provider: string | null | undefined) =>
  provider != null && STRICT_ALTERNATION_PROVIDERS.has(provider);

type RoleMessage = { role: string; content: unknown };

const MERGEABLE_ROLES = new Set(["system", "user", "assistant"]);
// Parts that carry no tool or reasoning state, so concatenating them cannot
// change what a turn means. Images and files are kept as parts, never dropped.
const MERGEABLE_PART_TYPES = new Set(["text", "image", "file"]);

const mergeableParts = (content: unknown): unknown[] | null => {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return null;
  return content.every(
    (part) =>
      Boolean(part) &&
      typeof part === "object" &&
      MERGEABLE_PART_TYPES.has((part as { type?: unknown }).type as string)
  )
    ? content
    : null;
};

const mergeContent = (previous: unknown, next: unknown): unknown | undefined => {
  if (typeof previous === "string" && typeof next === "string") {
    return `${previous}\n\n${next}`;
  }
  const left = mergeableParts(previous);
  const right = mergeableParts(next);
  if (!left || !right) return undefined;
  return [...left, { type: "text", text: "\n\n" }, ...right];
};

/**
 * Merge adjacent same-role messages into one. Text is joined with a blank
 * line; when either side holds image or file parts the result is a part array
 * so no attachment is lost. Turns that carry tool calls, tool results or
 * reasoning are left alone, and the input is never mutated.
 */
export const collapseConsecutiveSameRole = <T extends RoleMessage>(
  messages: readonly T[]
): T[] =>
  messages.reduce<T[]>((collapsed, message) => {
    const previous = collapsed[collapsed.length - 1];
    if (previous && previous.role === message.role && MERGEABLE_ROLES.has(message.role)) {
      const content = mergeContent(previous.content, message.content);
      if (content !== undefined) {
        collapsed[collapsed.length - 1] = { ...previous, content };
        return collapsed;
      }
    }
    collapsed.push(message);
    return collapsed;
  }, []);

/** The messages a provider will actually be sent, honouring its role rules. */
export const prepareProviderMessages = (
  messages: ModelMessage[],
  provider: string | null | undefined
): ModelMessage[] =>
  requiresRoleAlternation(provider) ? collapseConsecutiveSameRole(messages) : messages;
