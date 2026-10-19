import { looksLikeStructuredText } from "@/lib/structuredPasteDetection";

/**
 * How a user's own message is shown, split into plain text and code.
 *
 * Display only: the stored and sent text is never changed (see
 * lib/structuredPasteDetection.ts). A user message is not rendered as markdown
 * -- it was typed the way it reads -- so only code is lifted out:
 *
 *   * a ``` fence the user wrote, with its language when given;
 *   * an unfenced paragraph the composer's own paste detector already treats
 *     as structured (code, logs, tables), so a pasted function that showed in
 *     monospace while typing does not turn proportional once sent.
 *
 * Everything else stays a text segment, whitespace intact. Inline `code` spans
 * inside text are split out by `splitInlineCode`.
 */
export type UserMessageSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; code: string; language: string | null; fenced: boolean };

const FENCE_OPEN = /^[ \t]*(`{3,})[ \t]*([\w#+.-]*)[ \t]*$/;

const isBlank = (line: string) => line.trim() === "";

/** Paragraphs of an unfenced run, each classified on its own. */
const classifyUnfencedRun = (lines: string[]): UserMessageSegment[] => {
  const segments: UserMessageSegment[] = [];
  const pushText = (text: string) => {
    const last = segments.at(-1);
    if (last?.kind === "text") last.text += `\n${text}`;
    else segments.push({ kind: "text", text });
  };

  let index = 0;
  while (index < lines.length) {
    if (isBlank(lines[index])) {
      pushText(lines[index]);
      index += 1;
      continue;
    }
    const start = index;
    while (index < lines.length && !isBlank(lines[index])) index += 1;
    const paragraph = lines.slice(start, index).join("\n");
    if (!looksLikeStructuredText(paragraph)) {
      pushText(paragraph);
      continue;
    }
    // Code often has blank lines inside it. Two structured paragraphs with
    // only blank lines between them are one block, not two.
    const previous = segments.at(-1);
    const beforePrevious = segments.at(-2);
    if (
      previous?.kind === "text" &&
      previous.text.split("\n").every(isBlank) &&
      beforePrevious?.kind === "code" &&
      !beforePrevious.fenced
    ) {
      segments.pop();
      beforePrevious.code += `\n${previous.text}\n${paragraph}`;
    } else {
      segments.push({ kind: "code", code: paragraph, language: null, fenced: false });
    }
  }
  return segments;
};

export function splitUserMessageSegments(text: string): UserMessageSegment[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const segments: UserMessageSegment[] = [];
  let unfenced: string[] = [];
  const flushUnfenced = () => {
    if (unfenced.length > 0) segments.push(...classifyUnfencedRun(unfenced));
    unfenced = [];
  };

  let index = 0;
  while (index < lines.length) {
    const open = FENCE_OPEN.exec(lines[index]);
    if (!open) {
      unfenced.push(lines[index]);
      index += 1;
      continue;
    }
    // CommonMark: the closing fence is at least as long as the opening one.
    const close = new RegExp(`^[ \\t]*\`{${open[1].length},}[ \\t]*$`);
    let end = index + 1;
    while (end < lines.length && !close.test(lines[end])) end += 1;
    flushUnfenced();
    segments.push({
      kind: "code",
      code: lines.slice(index + 1, end).join("\n"),
      language: open[2] || null,
      fenced: true,
    });
    // An unclosed fence runs to the end, as it does in markdown.
    index = end + 1;
  }
  flushUnfenced();

  // A code block brings its own margin, so whole blank lines at the edges of a
  // text segment would only stack an empty line on top of it.
  return segments.flatMap((segment): UserMessageSegment[] => {
    if (segment.kind === "code") return [segment];
    const text = segment.text
      .replace(/^(?:[ \t]*\n)+/, "")
      .replace(/(?:\n[ \t]*)+$/, "");
    return text.trim() ? [{ kind: "text", text }] : [];
  });
}

export type InlineCodePart = { kind: "text" | "code"; text: string };

/** `code` spans on one line; an unmatched backtick stays plain text. */
export function splitInlineCode(text: string): InlineCodePart[] {
  const parts: InlineCodePart[] = [];
  const pattern = /`([^`\n]+)`/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ kind: "text", text: text.slice(cursor, start) });
    parts.push({ kind: "code", text: match[1] });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts;
}
