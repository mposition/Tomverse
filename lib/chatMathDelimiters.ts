/**
 * Prepares an assistant answer's Markdown for remark-math.
 *
 * remark-math is run with `singleDollarTextMath: false`, so a lone `$` is
 * always plain text ("$5 and $10" is a price list, never a formula). This
 * module is the only place that decides which dollar signs are math, and it
 * rewrites what it accepts into the `$$ ... $$` form remark-math understands:
 *
 *   - `\[ ... \]` and `\( ... \)` become `$$ ... $$`
 *   - `$ ... $` becomes `$$ ... $$` only when it passes the Pandoc rules
 *     (opening `$` is followed by a non-space, closing `$` is preceded by a
 *     non-space and is not followed by a digit) and the very next `$` is the
 *     closer -- so "costs $5, then $x$" keeps its price
 *   - a `$$` that never closes (a formula still streaming in) is escaped, so
 *     a half-written formula shows as text instead of an error
 *
 * Fenced code and inline code are never touched.
 */

const CODE_OPEN = "\u0001";
const CODE_CLOSE = "\u0002";

type Piece = { kind: "prose" | "code"; text: string };

/** Splits at fenced code blocks. An unterminated fence runs to the end. */
function splitFences(source: string): Piece[] {
  const lines = source.split("\n");
  const pieces: Piece[] = [];
  let prose: string[] = [];
  let fence: { char: string; length: number } | null = null;
  let code: string[] = [];
  const flushProse = () => {
    if (prose.length) pieces.push({ kind: "prose", text: prose.join("\n") });
    prose = [];
  };
  for (const line of lines) {
    if (fence) {
      code.push(line);
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        pieces.push({ kind: "code", text: code.join("\n") });
        code = [];
        fence = null;
      }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open && !(open[1][0] === "`" && line.slice(open[0].length).includes("`"))) {
      flushProse();
      fence = { char: open[1][0], length: open[1].length };
      code.push(line);
      continue;
    }
    prose.push(line);
  }
  if (fence) pieces.push({ kind: "code", text: code.join("\n") });
  flushProse();
  return pieces;
}

/** Swaps inline code spans for placeholders; returns the text and the spans. */
function hideInlineCode(text: string): { text: string; spans: string[] } {
  const spans: string[] = [];
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\\" && index + 1 < text.length) {
      out += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (text[index] !== "`") {
      out += text[index];
      index += 1;
      continue;
    }
    let run = 1;
    while (text[index + run] === "`") run += 1;
    let search = index + run;
    let closeAt = -1;
    while (search < text.length) {
      const next = text.indexOf("`", search);
      if (next === -1) break;
      let nextRun = 1;
      while (text[next + nextRun] === "`") nextRun += 1;
      if (nextRun === run) {
        closeAt = next;
        break;
      }
      search = next + nextRun;
    }
    if (closeAt === -1) {
      out += text.slice(index, index + run);
      index += run;
      continue;
    }
    spans.push(text.slice(index, closeAt + run));
    out += `${CODE_OPEN}${spans.length - 1}${CODE_CLOSE}`;
    index = closeAt + run;
  }
  return { text: out, spans };
}

function restoreInlineCode(text: string, spans: readonly string[]): string {
  if (spans.length === 0) return text;
  return text.replace(
    new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, "g"),
    (_match, i: string) => spans[Number(i)] ?? ""
  );
}

const isEscaped = (text: string, at: number): boolean => {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && text[i] === "\\"; i -= 1) slashes += 1;
  return slashes % 2 === 1;
};

/** `\[ \] \( \)` to `$$`, skipping a backslash that is itself escaped. */
function latexDelimitersToDollars(text: string): string {
  if (!text.includes("\\[") && !text.includes("\\]") && !text.includes("\\(") && !text.includes("\\)")) {
    return text;
  }
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && !isEscaped(text, i) && "[]()".includes(text[i + 1] ?? "x")) {
      out += "$$";
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Positions of every unescaped `$$` run of exactly two dollars. */
function doubleDollarPositions(text: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "$" || isEscaped(text, i)) continue;
    let run = 1;
    while (text[i + run] === "$") run += 1;
    if (run === 2) positions.push(i);
    i += run - 1;
  }
  return positions;
}

const lineStart = (text: string, at: number) => text.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (text: string, at: number) => {
  const end = text.indexOf("\n", at);
  return end === -1 ? text.length : end;
};

/**
 * Converts valid single-dollar spans in prose that holds no `$$`. A `$` that
 * does not qualify is left alone: with single-dollar math off it is text.
 */
function singleDollarsToMath(text: string): string {
  if (!text.includes("$")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "$" || isEscaped(text, i)) {
      out += ch;
      i += 1;
      continue;
    }
    const after = text[i + 1];
    // Only a lone dollar can open: "$$" or "$$$" never reaches here as math.
    if (after === undefined || after === "$" || /\s/.test(after)) {
      out += ch;
      i += 1;
      continue;
    }
    // The very next unescaped `$` must be a valid closer on the same line.
    let close = -1;
    for (let j = i + 1; j < text.length; j += 1) {
      if (text[j] === "\n") break;
      if (text[j] === "$" && !isEscaped(text, j)) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      out += ch;
      i += 1;
      continue;
    }
    const before = text[close - 1];
    const next = text[close + 1];
    const closable =
      close > i + 1 &&
      !/\s/.test(before) &&
      !(next !== undefined && /[0-9]/.test(next)) &&
      next !== "$" &&
      close - i <= 400;
    if (!closable) {
      out += ch;
      i += 1;
      continue;
    }
    out += `$$${text.slice(i + 1, close)}$$`;
    i = close + 1;
  }
  return out;
}

function prepareProse(prose: string): string {
  const hidden = hideInlineCode(prose);
  const text = latexDelimitersToDollars(hidden.text);
  if (!text.includes("$")) return restoreInlineCode(text, hidden.spans);

  const positions = doubleDollarPositions(text);
  let out = "";
  let cursor = 0;
  for (let p = 0; p < positions.length; p += 1) {
    const open = positions[p];
    if (open < cursor) continue;
    out += singleDollarsToMath(text.slice(cursor, open));
    const close = positions[p + 1];
    const opensLine = text.slice(lineStart(text, open), open).trim() === "";
    const content = close === undefined ? "" : text.slice(open + 2, close);
    // A formula that is still streaming has no closer yet. An inline one may
    // not cross a paragraph break either: that is two unrelated `$$`.
    const unusable =
      close === undefined || (!opensLine && /\n[ \t]*\n/.test(content));
    if (unusable) {
      out += "\\$\\$";
      cursor = open + 2;
      continue;
    }
    const closeLineEnd = lineEnd(text, close);
    const wholeLine =
      opensLine &&
      !content.includes("\n") &&
      text.slice(close + 2, closeLineEnd).trim() === "" &&
      content.trim() !== "";
    if (wholeLine) {
      // "$$ x $$" alone on a line is a display formula; remark-math reads it
      // as one only when the delimiters have lines of their own.
      const indent = text.slice(lineStart(text, open), open);
      out += `$$\n${indent}${content.trim()}\n${indent}$$`;
    } else {
      out += text.slice(open, close + 2);
    }
    cursor = close + 2;
    p += 1;
  }
  out += singleDollarsToMath(text.slice(cursor));
  return restoreInlineCode(out, hidden.spans);
}

/** Entry point: the Markdown to hand to `AnswerMarkdown` when math is on. */
export function prepareMathMarkdown(source: string): string {
  if (!source.includes("$") && !source.includes("\\[") && !source.includes("\\(")) {
    return source;
  }
  return splitFences(source)
    .map((piece) => (piece.kind === "code" ? piece.text : prepareProse(piece.text)))
    .join("\n");
}
