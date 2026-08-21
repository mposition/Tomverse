/**
 * The text formats: prose renderings, authored source, and the archive.
 *
 * Policy: docs/policy/generated-artifacts.md sections 3, 4 and 6.
 *
 * Two very different things live here, and the difference is the whole reason
 * the policy has a paragraph about it:
 *
 *   * **Rendered** -- Markdown and plain text are produced from the same block
 *     specification the DOCX and PDF writers read. The model described a
 *     document; this file writes one.
 *   * **Authored** -- a Python module, a YAML config, an SQL script. There is
 *     no specification for these that is not simply their text, so the model
 *     writes the content. Everything that made a specification safe is applied
 *     to the text instead: a bounded size, an extension this application chose,
 *     a structural check wherever malformed means useless, and a delivery path
 *     that downloads rather than renders.
 */

import { parse as parseYaml } from "yaml";
import { zipSync, type Zippable } from "fflate";

import {
  ARTIFACT_LIMITS,
  csvCell,
  requireArtifactFormat,
  type ArchiveSpec,
  type ArtifactCellValue,
  type DocumentSpec,
  type TextFileSpec,
} from "@/lib/generatedArtifactCore";
import { FIXED_ENTRY_TIME, stripUnwritableCharacters } from "@/lib/generatedArtifactXml";

/* ------------------------------------------------------------------------ */
/* Rendered: a document as Markdown or plain text                             */
/* ------------------------------------------------------------------------ */

const cellText = (value: ArtifactCellValue): string =>
  value === null || value === undefined ? "" : String(value);

/**
 * Markdown that survives a round trip.
 *
 * Pipes inside a table cell are escaped and newlines inside one are replaced
 * with `<br>`: a raw newline in a GFM table row ends the row, so a cell that
 * contained one would silently move the rest of the table one column left.
 * Everything else is written literally -- the block types are already the
 * things Markdown has syntax for, so nothing needs to be invented.
 */
export const renderDocumentMarkdown = (spec: DocumentSpec): string => {
  const lines: string[] = [];
  if (spec.title) lines.push(`# ${spec.title}`, "");
  if (spec.subtitle) lines.push(`_${spec.subtitle}_`, "");

  const tableCell = (value: string) =>
    value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

  for (const block of spec.blocks) {
    switch (block.type) {
      case "heading":
        lines.push(`${"#".repeat(block.level)} ${block.text}`, "");
        break;
      case "paragraph":
        lines.push(block.text, "");
        break;
      case "bullets":
        lines.push(...block.items.map((item) => `- ${item}`), "");
        break;
      case "numbers":
        lines.push(
          ...block.items.map((item, index) => `${index + 1}. ${item}`),
          ""
        );
        break;
      case "quote":
        lines.push(
          ...block.text.split(/\r?\n/).map((line) => `> ${line}`),
          ""
        );
        break;
      case "code":
        lines.push(
          `\`\`\`${block.language ?? ""}`,
          block.text,
          "```",
          ""
        );
        break;
      case "table":
        lines.push(
          `| ${block.columns.map(tableCell).join(" | ")} |`,
          `| ${block.columns.map(() => "---").join(" | ")} |`,
          ...block.rows.map(
            (row) =>
              `| ${block.columns
                .map((_, index) => tableCell(cellText(row[index] ?? null)))
                .join(" | ")} |`
          ),
          ""
        );
        break;
      case "divider":
        lines.push("---", "");
        break;
      case "pageBreak":
        // Markdown has no page. A rule would be a lie about the structure, and
        // a blank line loses the author's intent, so the intent is stated.
        lines.push("<!-- page break -->", "");
        break;
    }
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
};

/**
 * The same document with no markup at all.
 *
 * Not "Markdown with the syntax stripped": a plain-text reader has no bullets
 * and no table rendering, so lists get a real bullet character and tables are
 * laid out in aligned columns. Stripping syntax would produce a file whose
 * tables are unreadable, which is the version of "supported" this domain
 * refuses.
 */
export const renderDocumentText = (spec: DocumentSpec): string => {
  const lines: string[] = [];
  if (spec.title) lines.push(spec.title, "=".repeat(Math.min(spec.title.length, 60)), "");
  if (spec.subtitle) lines.push(spec.subtitle, "");

  for (const block of spec.blocks) {
    switch (block.type) {
      case "heading":
        lines.push(
          `${"  ".repeat(block.level - 1)}${block.text}`,
          `${"  ".repeat(block.level - 1)}${"-".repeat(Math.min(block.text.length, 60))}`,
          ""
        );
        break;
      case "paragraph":
        lines.push(block.text, "");
        break;
      case "bullets":
        lines.push(...block.items.map((item) => `  • ${item}`), "");
        break;
      case "numbers":
        lines.push(
          ...block.items.map((item, index) => `  ${index + 1}. ${item}`),
          ""
        );
        break;
      case "quote":
        lines.push(...block.text.split(/\r?\n/).map((line) => `  | ${line}`), "");
        break;
      case "code":
        lines.push(...block.text.split(/\r?\n/).map((line) => `    ${line}`), "");
        break;
      case "table": {
        const rows = [
          block.columns,
          ...block.rows.map((row) =>
            block.columns.map((_, index) => cellText(row[index] ?? null))
          ),
        ];
        // Column width is measured in code points, which is as close as a
        // fixed-pitch assumption gets: a Korean syllable occupies two cells in
        // a terminal and one code point, so wide text under-pads rather than
        // over-pads. Stated because the alternative -- guessing at East Asian
        // width -- would be a rendering decision made in a text file.
        const widths = block.columns.map((_, index) =>
          Math.min(40, Math.max(...rows.map((row) => (row[index] ?? "").length)))
        );
        const line = (row: string[]) =>
          `  ${row
            .map((value, index) => (value ?? "").padEnd(widths[index]))
            .join("  ")}`.trimEnd();
        lines.push(line(rows[0]!));
        lines.push(`  ${widths.map((width) => "-".repeat(width)).join("  ")}`);
        lines.push(...rows.slice(1).map(line), "");
        break;
      }
      case "divider":
        lines.push("-".repeat(60), "");
        break;
      case "pageBreak":
        // U+000C is the page break plain text actually has.
        lines.push("\f", "");
        break;
    }
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
};

/**
 * A document as CSV, for the one block that is tabular.
 *
 * Exported so the archive can carry a table without the caller having to
 * re-derive `csvCell`'s formula guard.
 */
export const renderTableCsv = (
  columns: readonly string[],
  rows: readonly ArtifactCellValue[][]
): string =>
  [
    columns.map(csvCell).join(","),
    ...rows.map((row) =>
      columns
        .map((_, index) => {
          const value = row[index];
          return value === null || value === undefined
            ? ""
            : typeof value === "number" || typeof value === "boolean"
              ? String(value)
              : csvCell(value);
        })
        .join(",")
    ),
  ].join("\r\n");

/* ------------------------------------------------------------------------ */
/* Authored: source, markup and config                                        */
/* ------------------------------------------------------------------------ */

export class TextContentError extends Error {
  constructor(
    readonly code: "CONTENT_MALFORMED",
    message: string
  ) {
    super(message);
    this.name = "TextContentError";
  }
}

/**
 * Whether markup is well formed enough to be worth delivering.
 *
 * A scanner rather than a parser, and deliberately so: the question is not
 * "what does this document mean" but "will the thing that opens it choke". It
 * checks the failures that make a file useless -- unbalanced elements, an
 * unterminated attribute, a stray `<` -- and does not attempt DTDs, namespaces
 * or entity resolution, none of which change that answer.
 *
 * Returns the first problem, or null.
 */
export const findMarkupProblem = (source: string): string | null => {
  const stack: string[] = [];
  // Elements that are legally unclosed in HTML. In XML they must self-close,
  // and a scanner that insisted would reject every real HTML page.
  const voidElements = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
  ]);

  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open === -1) break;

    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end === -1) return "an unterminated comment";
      index = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      if (end === -1) return "an unterminated CDATA section";
      index = end + 3;
      continue;
    }
    if (source.startsWith("<!", open) || source.startsWith("<?", open)) {
      const end = source.indexOf(">", open + 2);
      if (end === -1) return "an unterminated declaration";
      index = end + 1;
      continue;
    }

    // Find the tag's end, skipping over quoted attribute values so a `>`
    // inside one does not end the tag early.
    let cursor = open + 1;
    let quote: string | null = null;
    while (cursor < source.length) {
      const character = source[cursor]!;
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
      cursor += 1;
    }
    if (cursor >= source.length) return "an unterminated tag";
    if (quote) return "an unterminated attribute value";

    const inner = source.slice(open + 1, cursor);
    const closing = inner.startsWith("/");
    const selfClosing = inner.endsWith("/");
    const name = (closing ? inner.slice(1) : inner)
      .trim()
      .split(/[\s/>]/, 1)[0]!
      .toLowerCase();

    if (!name) return "a tag with no name";
    if (closing) {
      const expected = stack.pop();
      if (expected === undefined) return `a closing </${name}> with nothing open`;
      if (expected !== name) return `</${name}> where </${expected}> was expected`;
    } else if (!selfClosing && !voidElements.has(name)) {
      stack.push(name);
    }

    index = cursor + 1;
  }

  if (stack.length > 0) return `<${stack[stack.length - 1]}> is never closed`;
  return null;
};

/**
 * Script and event handlers, which an SVG must not carry.
 *
 * An SVG is expected to be a picture. A downloaded one is opened from `file://`,
 * where a `<script>` inside it runs with no origin to constrain it -- so a
 * "chart" that carries JavaScript is the classic smuggling shape, and nobody
 * asking for a chart wants it.
 *
 * HTML is deliberately not held to this. A page with script is what a request
 * for a web page means, and refusing it would be refusing the format rather
 * than securing it. Both are delivered as attachments with `nosniff`, so
 * neither can run in this application's origin either way.
 */
export const findSvgScript = (source: string): string | null => {
  if (/<\s*script[\s>]/i.test(source)) return "a <script> element";
  if (/<\s*foreignObject[\s>]/i.test(source)) return "a <foreignObject> element";
  if (/\son[a-z]+\s*=/i.test(source)) return "an inline event handler";
  if (/(?:href|xlink:href|src)\s*=\s*["']?\s*(?:javascript|data:text\/html)/i.test(source)) {
    return "a javascript: or data:text/html reference";
  }
  return null;
};

/**
 * The content a text artifact is stored with.
 *
 * Normalisation before validation, in this order and not the other: line
 * endings become `\n` and a trailing newline is guaranteed, because a source
 * file without one is a file every diff tool complains about, and because a
 * validator should be judging the bytes that will actually be written.
 */
export const admitTextContent = (spec: TextFileSpec): string => {
  const descriptor = requireArtifactFormat(spec.format);
  const normalized = `${stripUnwritableCharacters(spec.content)
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")}\n`;

  if (!normalized.trim()) {
    throw new TextContentError("CONTENT_MALFORMED", "The file would be empty.");
  }

  switch (descriptor.validation) {
    case "json":
      try {
        JSON.parse(normalized);
      } catch (error) {
        throw new TextContentError(
          "CONTENT_MALFORMED",
          `The JSON does not parse: ${
            error instanceof Error ? error.message.slice(0, 160) : "unknown"
          }`
        );
      }
      break;
    case "yaml":
      try {
        parseYaml(normalized);
      } catch (error) {
        throw new TextContentError(
          "CONTENT_MALFORMED",
          `The YAML does not parse: ${
            error instanceof Error ? error.message.slice(0, 160) : "unknown"
          }`
        );
      }
      break;
    case "svg": {
      const script = findSvgScript(normalized);
      if (script) {
        throw new TextContentError(
          "CONTENT_MALFORMED",
          `An SVG may not contain ${script}.`
        );
      }
      const problem = findMarkupProblem(normalized);
      if (problem) {
        throw new TextContentError(
          "CONTENT_MALFORMED",
          `The SVG is not well formed: ${problem}.`
        );
      }
      if (!/<\s*svg[\s>]/i.test(normalized)) {
        throw new TextContentError(
          "CONTENT_MALFORMED",
          "The file has no <svg> element."
        );
      }
      break;
    }
    case "xml": {
      const problem = findMarkupProblem(normalized);
      if (problem) {
        throw new TextContentError(
          "CONTENT_MALFORMED",
          `The markup is not well formed: ${problem}.`
        );
      }
      break;
    }
    default:
      break;
  }

  return normalized;
};

export const renderTextFile = (spec: TextFileSpec): Uint8Array =>
  new TextEncoder().encode(admitTextContent(spec));

/* ------------------------------------------------------------------------ */
/* Archive                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * A zip of text entries.
 *
 * Every entry goes through `admitTextContent`, which is what stops an archive
 * being the way to deliver what a direct request would refuse: the same
 * extension table, the same validation, the same size ceiling. The path was
 * already refused-not-sanitised at admission (`isSafeArchivePath`), so nothing
 * here has to decide what `../` meant.
 */
export const renderArchive = (spec: ArchiveSpec): Uint8Array => {
  const files: Zippable = {};
  const encoder = new TextEncoder();

  for (const entry of spec.entries) {
    const content = admitTextContent({
      filename: entry.path,
      format: entry.format,
      content: entry.content,
    });
    files[entry.path] = encoder.encode(content);
  }

  return zipSync(files, { level: 6, mtime: FIXED_ENTRY_TIME });
};

/** The archive ceilings, restated where a test can reach them. */
export const ARCHIVE_LIMITS = {
  maxEntries: ARTIFACT_LIMITS.maxArchiveEntries,
  maxCharacters: ARTIFACT_LIMITS.maxArchiveCharacters,
} as const;
