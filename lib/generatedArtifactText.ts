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
  isArchiveDocumentEntry,
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
 *
 * The backslash is escaped **first**, and the order is the whole correctness
 * of it. Escaping only the pipe leaves a cell holding `a\|b` written as
 * `a\\|b`, which a reader takes as one literal backslash followed by an
 * unescaped pipe -- so the row breaks anyway, which is the failure this
 * function exists to prevent. The same omission ate the backslash out of
 * `C:\path|x`, which reached the file as `C:path`. Found by CodeQL on the
 * release pull request.
 */
export const renderDocumentMarkdown = (spec: DocumentSpec): string => {
  const lines: string[] = [];
  if (spec.title) lines.push(`# ${spec.title}`, "");
  if (spec.subtitle) lines.push(`_${spec.subtitle}_`, "");

  const tableCell = (value: string) =>
    value
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, "<br>");

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
 * The five predefined XML entities. Everything else needs a DTD, which an SVG
 * a browser opens does not have -- `&nbsp;` in an SVG is a parse error, not a
 * space.
 */
const XML_PREDEFINED_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);

/**
 * Whether an `&` at this position starts a reference XML will accept.
 *
 * Numeric (`&#10;`, `&#x41;`) or one of the five predefined names. A bare `&`
 * -- the one a model writes in "salt & sodium" -- is a fatal error in XML and
 * is why this exists.
 */
const referenceAtIsValid = (source: string, ampersand: number): boolean => {
  const semicolon = source.indexOf(";", ampersand + 1);
  if (semicolon === -1 || semicolon - ampersand > 12) return false;
  const reference = source.slice(ampersand + 1, semicolon);
  if (!reference) return false;
  if (reference.startsWith("#")) {
    return /^#(?:\d+|[xX][0-9a-fA-F]+)$/.test(reference);
  }
  return XML_PREDEFINED_ENTITIES.has(reference);
};

/**
 * The attribute failures a tag can carry, or null.
 *
 * XML only. Walks `name="value"` pairs and reports the two that stop a parser
 * dead: the same attribute twice, and a value with no quotes. Names are
 * compared case-sensitively because XML is.
 */
const findAttributeProblem = (tagInner: string, tagName: string): string | null => {
  // Past the element name; the rest is attributes.
  const attributes = tagInner.slice(tagInner.indexOf(tagName) + tagName.length);
  const seen = new Set<string>();
  const pattern = /([^\s=/>"']+)\s*(=)?\s*("[^"]*"|'[^']*'|[^\s/>]+)?/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(attributes)) !== null) {
    const [, name, equals, value] = match;
    if (!name || name === "/" || name === "?") continue;
    if (seen.has(name)) return `the attribute "${name}" twice on <${tagName}>`;
    seen.add(name);
    if (!equals) continue;
    if (value === undefined) return `no value for "${name}" on <${tagName}>`;
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (!quoted) {
      return `an unquoted value for "${name}" on <${tagName}>`;
    }
  }
  return null;
};

/**
 * Whether markup is well formed enough to be worth delivering.
 *
 * A scanner rather than a parser, and deliberately so: the question is not
 * "what does this document mean" but "will the thing that opens it choke". It
 * checks the failures that make a file useless and does not attempt DTDs,
 * namespaces or entity resolution, none of which change that answer.
 *
 * ## Why there are two strictnesses
 *
 * HTML forgives what XML refuses. A browser reading a `.html` page happily
 * takes `<BODY>` closed by `</body>`, `width=100` without quotes, and a bare
 * `&` in a sentence. The same three in an SVG are **fatal**: the browser
 * refuses to render and prints its parse error instead.
 *
 * That is not hypothetical. A generated `.svg` carrying `text-anchor` twice on
 * one element was accepted here, written, and offered to the user as a
 * finished picture -- and it opened as "Attribute text-anchor redefined". The
 * scanner passed it because it never looked at attributes at all. Delivering a
 * file that cannot be opened is the same failure as claiming a file that was
 * never made (docs/policy/generated-artifacts.md section 1).
 *
 * So `strict` is on for `.svg` and `.xml`, and off for `.html`/`.htm` -- where
 * turning it on would reject ordinary, working pages.
 *
 * Returns the first problem, or null.
 */
export const findMarkupProblem = (
  source: string,
  options: { strict?: boolean } = {}
): string | null => {
  const strict = options.strict ?? false;
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

    // Text between the previous tag and this one. In XML a bare `&` here is
    // fatal, so it is checked on the way past rather than in a second scan.
    if (strict) {
      const between = source.slice(index, open);
      const ampersand = between.indexOf("&");
      if (ampersand !== -1 && !referenceAtIsValid(between, ampersand)) {
        return "an unescaped & in the text";
      }
    }

    const inner = source.slice(open + 1, cursor);
    const closing = inner.startsWith("/");
    const selfClosing = inner.endsWith("/");
    const rawName = (closing ? inner.slice(1) : inner)
      .trim()
      .split(/[\s/>]/, 1)[0]!;
    // XML is case-sensitive, HTML is not: `<Text>` closed by `</text>` is a
    // working page in one and a parse error in the other.
    const name = strict ? rawName : rawName.toLowerCase();

    if (!name) return "a tag with no name";
    if (closing) {
      const expected = stack.pop();
      if (expected === undefined) return `a closing </${name}> with nothing open`;
      if (expected !== name) return `</${name}> where </${expected}> was expected`;
    } else {
      if (strict) {
        const attributeProblem = findAttributeProblem(inner, name);
        if (attributeProblem) return attributeProblem;
        const ampersand = inner.indexOf("&");
        if (ampersand !== -1 && !referenceAtIsValid(inner, ampersand)) {
          return `an unescaped & in an attribute on <${name}>`;
        }
      }
      // Void elements are an HTML rule. In XML every element closes, so the
      // exemption would let `<img>` leave the stack unbalanced unnoticed.
      if (!selfClosing && (strict || !voidElements.has(name))) {
        stack.push(name);
      }
    }

    index = cursor + 1;
  }

  if (strict) {
    const trailing = source.slice(index);
    const ampersand = trailing.indexOf("&");
    if (ampersand !== -1 && !referenceAtIsValid(trailing, ampersand)) {
      return "an unescaped & in the text";
    }
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
      // Strict: an SVG is parsed as XML by whatever opens it, and the errors
      // XML calls fatal are the ones that make the picture never appear.
      const problem = findMarkupProblem(normalized, { strict: true });
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
      // `.xml` is strict for the same reason `.svg` is; `.html`/`.htm` share
      // this branch and must not be, so they are separated by extension.
      const problem = findMarkupProblem(normalized, {
        strict: descriptor.id === "xml",
      });
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
export const renderArchive = (spec: ArchiveSpec): Uint8Array =>
  zipArchiveEntries(
    spec.entries.map((entry) => {
      if (isArchiveDocumentEntry(entry)) {
        // Rendering a document needs the Word and PDF writers, which this
        // module deliberately does not import: it is the *text* half of the
        // domain. `renderArchiveArtifact` in lib/generatedArtifactRenderers.ts
        // is the caller that has every writer in hand, and it is the one the
        // tool actually goes through -- so reaching here means an archive with
        // a rendered entry was zipped by the wrong path.
        throw new TextContentError(
          "CONTENT_MALFORMED",
          "A rendered document entry must be built by the artifact renderer."
        );
      }
      return {
        path: entry.path,
        bytes: archiveTextEntryBytes(entry),
      };
    })
  );

/** One authored entry's bytes, with the same checks a direct request gets. */
export const archiveTextEntryBytes = (entry: {
  path: string;
  format: string;
  content: string;
}): Uint8Array =>
  new TextEncoder().encode(
    admitTextContent({
      filename: entry.path,
      format: entry.format,
      content: entry.content,
    })
  );

/**
 * Zips entries whose bytes are already decided.
 *
 * The single place a `.zip` is written, so the fixed timestamp and the
 * compression level cannot drift between the authored-text archive and the
 * batch-rendered one -- two archives built from the same inputs are the same
 * bytes.
 */
export const zipArchiveEntries = (
  entries: Array<{ path: string; bytes: Uint8Array }>
): Uint8Array => {
  const files: Zippable = {};
  for (const entry of entries) {
    files[entry.path] = entry.bytes;
  }
  return zipSync(files, { level: 6, mtime: FIXED_ENTRY_TIME });
};

/** The archive ceilings, restated where a test can reach them. */
export const ARCHIVE_LIMITS = {
  maxEntries: ARTIFACT_LIMITS.maxArchiveEntries,
  maxCharacters: ARTIFACT_LIMITS.maxArchiveCharacters,
} as const;
