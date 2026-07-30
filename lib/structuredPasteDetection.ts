// Heuristic used only to decide whether a pasted chunk of text looks like
// structured content (code, tables, logs, diagrams) worth rendering in a
// monospace, non-wrapping view instead of the normal proportional-font
// composer. It never touches the text itself - detection only, no mutation -
// since the same content is sent to every compared model and must stay
// byte-for-byte identical to what the user pasted.
const CODE_FENCE_PATTERN = /```/;
const JSON_OR_XML_SHAPE_PATTERN = /^\s*[{[<]/;
const TABLE_OR_DIAGRAM_CHAR_PATTERN = /[│┌┐└┘├┤┬┴┼─╔╗╚╝╠╣╦╩╬]/;
const MARKDOWN_TABLE_ROW_PATTERN = /^\s*\|.*\|\s*$/m;
const LOG_LINE_PATTERN = /^(\s*(\[[^\]]+\]|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|[$#>])\s)/m;
const INDENTED_LINE_PATTERN = /^[ \t]{2,}\S/m;

const countIndentedLines = (lines: string[]) =>
  lines.filter((line) => INDENTED_LINE_PATTERN.test(line)).length;

const countPipeRows = (lines: string[]) =>
  lines.filter((line) => MARKDOWN_TABLE_ROW_PATTERN.test(line)).length;

export function looksLikeStructuredText(text: string): boolean {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return false;

  const lines = trimmed.split("\n");
  if (lines.length < 3) return false;

  if (CODE_FENCE_PATTERN.test(trimmed)) return true;
  if (JSON_OR_XML_SHAPE_PATTERN.test(trimmed)) return true;
  if (TABLE_OR_DIAGRAM_CHAR_PATTERN.test(trimmed)) return true;
  if (countPipeRows(lines) >= 2) return true;
  if (LOG_LINE_PATTERN.test(trimmed)) return true;
  if (countIndentedLines(lines) >= 2) return true;

  return false;
}
