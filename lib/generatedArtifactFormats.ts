/**
 * Every file format this application can produce, and what each one is.
 *
 * Policy: docs/policy/generated-artifacts.md section 4.
 *
 * One table, because a format is not one fact but five that must agree: the
 * extension on disk, the media type on the wire, which generator can build it,
 * what its content is checked as, and whether it is offered at all. Those five
 * used to be five `switch` statements waiting to disagree with each other.
 *
 * Pure: no `server-only`, no Prisma, no `ai`. The download route, the tool
 * definitions, the card in the browser and the tests all read the same table.
 */

/**
 * What kind of thing a format is, which decides which tool builds it.
 *
 * The split is by *shape of the input*, not by binary-versus-text. A workbook
 * and a CSV are one shape; a Word file and a Markdown file are another; a
 * Python module and a YAML config are a third. A model that has to pick a tool
 * picks by what it is trying to describe, which is the shape.
 */
export const ARTIFACT_KINDS = [
  "spreadsheet",
  "document",
  "presentation",
  "text",
  "archive",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * How a text format's content is checked before it is stored.
 *
 * `none` is not "unchecked": every text artifact is still bounded, stripped of
 * code points that cannot be stored, and refused if empty. This names the
 * *additional* structural check, which only exists where a malformed file is
 * silently useless -- a JSON config that will not parse is not a config.
 */
export type ArtifactTextValidation = "json" | "yaml" | "xml" | "svg" | "none";

/**
 * Which localised name and icon the download card uses.
 *
 * Coarser than the format on purpose. Fifty-eight formats would be
 * fifty-eight strings in each of seven locales, most of them a translation of
 * an extension nobody translates -- so the ones a person recognises by name
 * (an Excel workbook, a PDF) get their own, and the rest are named by their
 * group with the extension filled in: "PY source file", "PY 소스 코드".
 */
export const ARTIFACT_LABEL_GROUPS = [
  "xlsx",
  "csv",
  "docx",
  "pdf",
  "pptx",
  "markdown",
  "text",
  "data",
  "markup",
  "code",
  "archive",
] as const;

export type ArtifactLabelGroup = (typeof ARTIFACT_LABEL_GROUPS)[number];

export type ArtifactFormatDescriptor = {
  /** The format id, which is also the extension without its dot. */
  id: string;
  kind: ArtifactKind;
  /** Always lowercase and always leading-dotted. Decided here, never by a model. */
  extension: string;
  mediaType: string;
  /** Text formats only. */
  validation?: ArtifactTextValidation;
  /**
   * A short, human name for the card, in English.
   *
   * Product copy lives in `locales/*.ts`; this is the fallback the card falls
   * back to for a format whose label nobody has translated yet, and the string
   * the tool description uses when telling a model what exists.
   */
  label: string;
  /** Which localised name and icon the card uses. */
  labelGroup: ArtifactLabelGroup;
};

const text = (
  id: string,
  mediaType: string,
  label: string,
  validation: ArtifactTextValidation = "none",
  labelGroup: ArtifactLabelGroup = "code"
): ArtifactFormatDescriptor => ({
  id,
  kind: "text",
  extension: `.${id}`,
  mediaType,
  validation,
  label,
  labelGroup,
});

const SOURCE = "text/plain; charset=utf-8";

/**
 * The formats, in the order a person would think of them.
 *
 * ## What is deliberately absent
 *
 * The Windows auto-execute set: `exe`, `dll`, `com`, `bat`, `cmd`, `msi`,
 * `scr`, `vbs`, `vbe`, `jse`, `wsf`, `wsh`, `lnk`, `reg`, `cpl`, `hta`, `pif`.
 * Every other extension here opens in an editor or a viewer when it is
 * double-clicked; those open by *running*. A file the user asked for is still
 * a file the user asked for, so `.sh`, `.ps1` and `.py` are all here -- none of
 * them executes on a double-click without the user arranging it. The line is
 * "does opening it run it", not "could it run".
 *
 * The same list governs archive entries, so a zip cannot be used to deliver
 * what a direct request would be refused.
 */
export const ARTIFACT_FORMAT_TABLE: readonly ArtifactFormatDescriptor[] = [
  // --- Office and print --------------------------------------------------
  {
    id: "xlsx",
    kind: "spreadsheet",
    extension: ".xlsx",
    mediaType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "Excel workbook",
    labelGroup: "xlsx",
  },
  {
    id: "docx",
    kind: "document",
    extension: ".docx",
    mediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word document",
    labelGroup: "docx",
  },
  {
    id: "pptx",
    kind: "presentation",
    extension: ".pptx",
    mediaType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "PowerPoint presentation",
    labelGroup: "pptx",
  },
  {
    id: "pdf",
    kind: "document",
    extension: ".pdf",
    mediaType: "application/pdf",
    label: "PDF document",
    labelGroup: "pdf",
  },

  // --- Tabular and prose -------------------------------------------------
  {
    id: "csv",
    kind: "spreadsheet",
    extension: ".csv",
    mediaType: "text/csv; charset=utf-8",
    label: "CSV file",
    labelGroup: "csv",
  },
  {
    id: "md",
    kind: "document",
    extension: ".md",
    mediaType: "text/markdown; charset=utf-8",
    label: "Markdown document",
    labelGroup: "markdown",
  },
  {
    id: "txt",
    kind: "document",
    extension: ".txt",
    mediaType: "text/plain; charset=utf-8",
    label: "Text document",
    labelGroup: "text",
  },

  // --- Structured data ---------------------------------------------------
  text("json", "application/json; charset=utf-8", "JSON file", "json", "data"),
  text("yaml", "application/yaml; charset=utf-8", "YAML file", "yaml", "data"),
  text("yml", "application/yaml; charset=utf-8", "YAML file", "yaml", "data"),
  text("xml", "application/xml; charset=utf-8", "XML file", "xml", "data"),
  text("toml", SOURCE, "TOML file", "none", "data"),
  text("ini", SOURCE, "INI file", "none", "data"),
  text("tsv", "text/tab-separated-values; charset=utf-8", "TSV file", "none", "data"),

  // --- Markup ------------------------------------------------------------
  text("html", "text/html; charset=utf-8", "HTML page", "xml", "markup"),
  text("htm", "text/html; charset=utf-8", "HTML page", "xml", "markup"),
  text("svg", "image/svg+xml; charset=utf-8", "SVG image", "svg", "markup"),
  text("css", "text/css; charset=utf-8", "CSS stylesheet", "none", "markup"),
  text("scss", SOURCE, "SCSS stylesheet", "none", "markup"),
  text("less", SOURCE, "LESS stylesheet", "none", "markup"),

  // --- Query and schema --------------------------------------------------
  text("sql", "application/sql; charset=utf-8", "SQL script"),
  text("graphql", SOURCE, "GraphQL document"),
  text("proto", SOURCE, "Protocol Buffers schema"),

  // --- Source code -------------------------------------------------------
  text("ts", SOURCE, "TypeScript source"),
  text("tsx", SOURCE, "TypeScript JSX source"),
  text("js", "text/javascript; charset=utf-8", "JavaScript source"),
  text("jsx", SOURCE, "JavaScript JSX source"),
  text("mjs", "text/javascript; charset=utf-8", "JavaScript module"),
  text("cjs", "text/javascript; charset=utf-8", "CommonJS module"),
  text("py", SOURCE, "Python source"),
  text("rb", SOURCE, "Ruby source"),
  text("go", SOURCE, "Go source"),
  text("rs", SOURCE, "Rust source"),
  text("java", SOURCE, "Java source"),
  text("kt", SOURCE, "Kotlin source"),
  text("swift", SOURCE, "Swift source"),
  text("c", SOURCE, "C source"),
  text("h", SOURCE, "C header"),
  text("cpp", SOURCE, "C++ source"),
  text("hpp", SOURCE, "C++ header"),
  text("cs", SOURCE, "C# source"),
  text("php", SOURCE, "PHP source"),
  text("sh", "application/x-sh; charset=utf-8", "Shell script"),
  text("bash", "application/x-sh; charset=utf-8", "Bash script"),
  text("ps1", SOURCE, "PowerShell script"),
  text("r", SOURCE, "R source"),
  text("scala", SOURCE, "Scala source"),
  text("lua", SOURCE, "Lua source"),
  text("pl", SOURCE, "Perl source"),
  text("dart", SOURCE, "Dart source"),
  text("ex", SOURCE, "Elixir source"),
  text("exs", SOURCE, "Elixir script"),
  text("hs", SOURCE, "Haskell source"),
  text("vue", SOURCE, "Vue component"),
  text("svelte", SOURCE, "Svelte component"),
  text("dockerfile", SOURCE, "Dockerfile"),
  text("env", SOURCE, "Environment file", "none", "data"),

  // --- Container ---------------------------------------------------------
  {
    id: "zip",
    kind: "archive",
    extension: ".zip",
    mediaType: "application/zip",
    label: "ZIP archive",
    labelGroup: "archive",
  },
];

const BY_ID = new Map(
  ARTIFACT_FORMAT_TABLE.map((format) => [format.id, format])
);

export const SUPPORTED_ARTIFACT_FORMATS: readonly string[] =
  ARTIFACT_FORMAT_TABLE.map((format) => format.id);

export const isSupportedArtifactFormat = (value: string): boolean =>
  BY_ID.has(value);

export const artifactFormat = (
  id: string
): ArtifactFormatDescriptor | undefined => BY_ID.get(id);

/** Throws for an unknown id, so a caller past admission cannot get `undefined`. */
export const requireArtifactFormat = (id: string): ArtifactFormatDescriptor => {
  const format = BY_ID.get(id);
  if (!format) throw new Error(`Unknown artifact format: ${id}`);
  return format;
};

export const formatsOfKind = (kind: ArtifactKind): ArtifactFormatDescriptor[] =>
  ARTIFACT_FORMAT_TABLE.filter((format) => format.kind === kind);

export const formatIdsOfKind = (kind: ArtifactKind): string[] =>
  formatsOfKind(kind).map((format) => format.id);

/**
 * The formats an archive entry may hold.
 *
 * Every `text` format, plus the three whose bytes are simply their text even
 * though a generator also builds them from a specification -- a project zip
 * without a `README.md` or a `data.csv` in it is not a project zip. The
 * structured formats (xlsx, docx, pptx, pdf) and zip itself are deliberately
 * absent: their bytes come from a specification, and an archive entry carries
 * a string.
 */
export const ARCHIVE_ENTRY_FORMATS: readonly string[] = [
  ...formatIdsOfKind("text"),
  "md",
  "txt",
  "csv",
];

/**
 * Extensions a request may name that this application will not produce.
 *
 * Listed rather than merely absent, because "we do not make .exe" is a
 * sentence the product can say, and silence about it is how a model ends up
 * inventing a download link instead (policy section 4). The set is the one
 * whose members run when they are opened, plus the archive formats that would
 * carry them.
 */
export const REFUSED_ARTIFACT_EXTENSIONS: readonly string[] = [
  "exe",
  "dll",
  "com",
  "bat",
  "cmd",
  "msi",
  "scr",
  "vbs",
  "vbe",
  "jse",
  "wsf",
  "wsh",
  "lnk",
  "reg",
  "cpl",
  "hta",
  "pif",
  "app",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "jar",
  "apk",
];

const REFUSED = new Set(REFUSED_ARTIFACT_EXTENSIONS);

export const isRefusedArtifactExtension = (value: string): boolean =>
  REFUSED.has(value.replace(/^\./, "").toLowerCase());
