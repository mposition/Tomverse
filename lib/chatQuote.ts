/**
 * Quoting part of an answer into the composer. The quote is plain Markdown
 * (`> line`), so it reads the same in the draft, in the saved question and in
 * what the model receives.
 */

export const CHAT_QUOTE_EVENT = "tomverse:chat-quote";
export const CHAT_QUOTE_MAX_CHARACTERS = 2_000;

export function formatQuote(selection: string): string {
  const text = selection
    .replace(/\r\n?/g, "\n")
    .replace(/\p{Zs}/gu, " ")
    .trim()
    .slice(0, CHAT_QUOTE_MAX_CHARACTERS);
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">"))
    .join("\n");
}

/** Adds the quote after whatever is already typed, leaving room to reply. */
export function appendQuoteToDraft(draft: string, quote: string): string {
  if (!quote) return draft;
  const separator = draft.trim() ? (draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n") : "";
  return `${draft}${separator}${quote}\n\n`;
}

export function requestChatQuote(selection: string) {
  const quote = formatQuote(selection);
  if (!quote || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<{ quote: string }>(CHAT_QUOTE_EVENT, { detail: { quote } }));
}

export function subscribeChatQuote(listener: (quote: string) => void): () => void {
  const handler = (event: Event) => {
    const quote = (event as CustomEvent<{ quote?: unknown }>).detail?.quote;
    if (typeof quote === "string" && quote) listener(quote);
  };
  window.addEventListener(CHAT_QUOTE_EVENT, handler);
  return () => window.removeEventListener(CHAT_QUOTE_EVENT, handler);
}
