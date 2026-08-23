/**
 * The one table that says what a chat message may carry.
 *
 * Contract: docs/policy/chat-attachment-formats.md.
 *
 * Before this module the answer was written down four times -- in the
 * composer's `accept` attribute, in the composer's own client-side guard, in
 * `app/api/chat/route.ts`'s `ALLOWED_ATTACHMENT_TYPES`, and in
 * `lib/guestAttachments.ts`'s `GUEST_ATTACHMENT_TYPES` -- and the four lists
 * only agreed because someone kept them in step by hand. They had already
 * drifted in one visible way: the composer repaired a missing media type for
 * the six Office extensions and for nothing else, so a `.txt`, `.md`, `.csv`
 * or `.json` whose browser-reported type came back empty (which happens, and
 * happens more on Windows and on Android pickers) was refused by the client
 * before the server ever saw a byte.
 *
 * So the list lives here once, as data, and every surface derives from it:
 *
 *   * the file picker's `accept` string,
 *   * the client's extension -> canonical media type repair,
 *   * the upload-preparation and finalize allowlists,
 *   * the per-message processing branch (image / PDF / Office / text /
 *     archive),
 *   * the guest subset,
 *   * and the copy that tells a person what they may attach.
 *
 * Pure and isomorphic on purpose: no `server-only`, no Node builtins, no
 * Prisma. The browser needs the same table the server enforces, and a table
 * only one of them can read is how the four lists happened.
 *
 * What this module is NOT:
 *
 *   * It is not `lib/generatedArtifactFormats.ts`. That table says what this
 *     product may *write*; this one says what it may *read*. They share
 *     nothing but a shape, and "we can generate it" is not a reason to accept
 *     an upload of it.
 *   * It is not the assistant-knowledge, external-import or image-generation
 *     allowlist. Each of those is a separate capability with its own limits
 *     and its own policy document, and widening this table must not widen
 *     them.
 *   * It is not a security boundary by itself. An entry here says "this
 *     product knows how to read this"; the bytes are still checked against
 *     the format's signature and parser server-side
 *     (`lib/chatAttachmentValidation.ts`).
 */

export type ChatAttachmentCategory =
    | "image"
    | "pdf"
    /** OOXML and OpenDocument: a ZIP with XML in it. */
    | "office"
    /**
     * Word/Excel/PowerPoint 97-2003 and RTF. A separate category from
     * `office` because nothing is shared: these are compound-file or
     * plain-text containers, they never see `assertSafeOfficeArchive`, and
     * they are read by this repository's own parsers rather than by
     * `officeparser`.
     */
    | "legacy-office"
    | "text"
    | "archive";

/**
 * Which parser owns the format once the bytes are on the server. The category
 * above is what the format *is*; this is who reads it, and the two are only
 * incidentally the same today.
 */
export type ChatAttachmentParser =
    | "image-normalizer"
    | "pdf-extractor"
    | "office-extractor"
    | "legacy-office-extractor"
    | "utf-text-decoder"
    | "archive-expander";

/**
 * How the first bytes are proven to match the claim. `utf-text` has no magic
 * number of its own, which is exactly why it gets the strictest content check
 * (no NUL, no known binary signature, strict UTF decoding).
 */
export type ChatAttachmentSignature =
    | "png"
    | "jpeg"
    | "webp"
    | "gif"
    | "pdf"
    | "zip"
    /** The compound-file magic a `.doc`, `.xls` or `.ppt` opens with. */
    | "cfbf"
    | "rtf"
    | "utf-text";

/** How the format is grouped when a person is told what they may attach. */
export type ChatAttachmentUiGroup =
    | "image"
    | "document"
    | "data"
    | "markup"
    | "code"
    | "archive";

export type ChatAttachmentFormat = {
    /** Stable identifier. Used in tests and diagnostics, never shown to a user. */
    readonly id: string;
    /** Lowercase, no leading dot. First entry is the canonical extension. */
    readonly extensions: readonly string[];
    /**
     * Extensionless or dot-leading names that are this format regardless of
     * suffix. Kept deliberately short: these exist because a source archive
     * is full of them, not as a place to grow the table sideways.
     */
    readonly filenames?: readonly string[];
    /** The type stored on the object, sent to the server and re-checked there. */
    readonly mediaType: string;
    /**
     * Types a browser, an operating system or another product is known to
     * report for this format. Accepted on input, never stored: the canonical
     * type above is what gets written.
     */
    readonly mediaTypeAliases: readonly string[];
    readonly category: ChatAttachmentCategory;
    readonly parser: ChatAttachmentParser;
    readonly signature: ChatAttachmentSignature;
    /** May this format appear inside an uploaded archive and be read from it? */
    readonly allowedInArchive: boolean;
    /** May a guest attach it directly? */
    readonly guestAllowed: boolean;
    /** Does sending it require a model that accepts image input? */
    readonly requiresImageInput: boolean;
    readonly uiGroup: ChatAttachmentUiGroup;
    /**
     * The noun used in the prompt header for this file
     * (`lib/attachmentContextPrompt.ts`). The three that existed before this
     * module keep their exact wording so `attach-context-v1` still means the
     * same bytes for the same upload.
     */
    readonly promptKind: string;
};

const OOXML = "application/vnd.openxmlformats-officedocument";
const ODF = "application/vnd.oasis.opendocument";

const image = (
    id: string,
    extensions: readonly string[],
    mediaType: string,
    signature: ChatAttachmentSignature,
    mediaTypeAliases: readonly string[] = []
): ChatAttachmentFormat => ({
    id,
    extensions,
    mediaType,
    mediaTypeAliases,
    category: "image",
    parser: "image-normalizer",
    signature,
    allowedInArchive: true,
    guestAllowed: true,
    requiresImageInput: true,
    uiGroup: "image",
    promptKind: "image file",
});

const office = (
    id: string,
    extension: string,
    mediaType: string
): ChatAttachmentFormat => ({
    id,
    extensions: [extension],
    mediaType,
    mediaTypeAliases: [],
    category: "office",
    parser: "office-extractor",
    signature: "zip",
    allowedInArchive: true,
    guestAllowed: true,
    requiresImageInput: false,
    uiGroup: "document",
    // Unchanged wording: `attach-context-v1` already ships this string.
    promptKind: "office file",
});

const legacyOffice = (
    id: string,
    extensions: readonly string[],
    mediaType: string,
    signature: ChatAttachmentSignature,
    mediaTypeAliases: readonly string[] = []
): ChatAttachmentFormat => ({
    id,
    extensions,
    mediaType,
    mediaTypeAliases,
    category: "legacy-office",
    parser: "legacy-office-extractor",
    signature,
    allowedInArchive: true,
    guestAllowed: true,
    requiresImageInput: false,
    uiGroup: "document",
    promptKind: "office file",
});

const text = (
    id: string,
    extensions: readonly string[],
    mediaType: string,
    uiGroup: ChatAttachmentUiGroup,
    promptKind: string,
    mediaTypeAliases: readonly string[] = [],
    filenames?: readonly string[]
): ChatAttachmentFormat => ({
    id,
    extensions,
    ...(filenames ? { filenames } : {}),
    mediaType,
    mediaTypeAliases,
    category: "text",
    parser: "utf-text-decoder",
    signature: "utf-text",
    allowedInArchive: true,
    guestAllowed: true,
    requiresImageInput: false,
    uiGroup,
    promptKind,
});

/**
 * Every format a chat message may carry, in the order a person should be
 * shown them.
 *
 * Adding a row is the whole change for a text format. Anything that needs a
 * parser needs a branch in `lib/chatAttachmentValidation.ts` as well, and
 * nothing anywhere else.
 */
export const CHAT_ATTACHMENT_FORMATS: readonly ChatAttachmentFormat[] = [
    // -- Images -------------------------------------------------------------
    image("png", ["png"], "image/png", "png"),
    image("jpeg", ["jpg", "jpeg"], "image/jpeg", "jpeg", ["image/jpg"]),
    image("webp", ["webp"], "image/webp", "webp"),
    // Still frames only. An animated GIF is refused by name rather than
    // silently reduced to its first frame -- see `lib/mediaSecurity.ts`.
    image("gif", ["gif"], "image/gif", "gif"),

    // -- PDF ----------------------------------------------------------------
    {
        id: "pdf",
        extensions: ["pdf"],
        mediaType: "application/pdf",
        mediaTypeAliases: ["application/x-pdf"],
        category: "pdf",
        parser: "pdf-extractor",
        signature: "pdf",
        allowedInArchive: true,
        guestAllowed: true,
        requiresImageInput: false,
        uiGroup: "document",
        // Unchanged wording: `attach-context-v1` already ships this string.
        promptKind: "PDF file",
    },

    // -- Office -------------------------------------------------------------
    office("docx", "docx", `${OOXML}.wordprocessingml.document`),
    office("xlsx", "xlsx", `${OOXML}.spreadsheetml.sheet`),
    office("pptx", "pptx", `${OOXML}.presentationml.presentation`),
    office("odt", "odt", `${ODF}.text`),
    office("ods", "ods", `${ODF}.spreadsheet`),
    office("odp", "odp", `${ODF}.presentation`),

    // -- Office 97-2003 and RTF ---------------------------------------------
    // Read by this repository's own parsers (lib/legacyOffice/**), never
    // decrypted, and never opened past the streams that hold text.
    legacyOffice("doc", ["doc"], "application/msword", "cfbf", [
        "application/vnd.ms-word",
        "application/doc",
        "application/winword",
    ]),
    legacyOffice("xls", ["xls"], "application/vnd.ms-excel", "cfbf", [
        "application/msexcel",
        "application/x-excel",
        "application/x-msexcel",
    ]),
    legacyOffice("ppt", ["ppt"], "application/vnd.ms-powerpoint", "cfbf", [
        "application/mspowerpoint",
        "application/powerpoint",
        "application/x-mspowerpoint",
    ]),
    legacyOffice("rtf", ["rtf"], "application/rtf", "rtf", [
        "text/rtf",
        "text/richtext",
        "application/x-rtf",
        // Windows answers with whichever application owns the extension, not
        // with what the bytes are, so an installed Word makes every `.rtf`
        // arrive as `application/msword`. See ASSOCIATION_OWNER_MEDIA_TYPES.
        "application/msword",
    ]),

    // -- Archive ------------------------------------------------------------
    {
        id: "zip",
        extensions: ["zip"],
        mediaType: "application/zip",
        mediaTypeAliases: [
            "application/x-zip-compressed",
            "application/x-zip",
            "multipart/x-zip",
        ],
        category: "archive",
        parser: "archive-expander",
        signature: "zip",
        // Depth 0: an archive inside an archive is refused, not unpacked.
        allowedInArchive: false,
        guestAllowed: true,
        requiresImageInput: false,
        uiGroup: "archive",
        promptKind: "file from archive",
    },

    // -- Plain text and data ------------------------------------------------
    text(
        "plain-text",
        ["txt", "text", "log"],
        "text/plain",
        "document",
        // Unchanged wording: `attach-context-v1` already ships this string.
        "file",
        [],
        // Extensionless names a source tree is full of. Plain text, read as
        // plain text; this list is not a growth area.
        [
            "dockerfile",
            "makefile",
            ".gitignore",
            ".gitattributes",
            ".dockerignore",
            ".editorconfig",
        ]
    ),
    text("markdown", ["md", "markdown"], "text/markdown", "document", "Markdown file", [
        "text/x-markdown",
    ]),
    text("restructured-text", ["rst"], "text/x-rst", "document", "reStructuredText file"),
    text("csv", ["csv"], "text/csv", "data", "CSV file", [
        "application/csv",
        "text/comma-separated-values",
        // An installed Excel owns `.csv` on Windows. See
        // ASSOCIATION_OWNER_MEDIA_TYPES.
        "application/vnd.ms-excel",
    ]),
    text("tsv", ["tsv"], "text/tab-separated-values", "data", "TSV file", [
        "text/tsv",
        "application/x-tsv",
        "application/vnd.ms-excel",
    ]),
    text("json", ["json"], "application/json", "data", "JSON file", ["text/json"]),
    text("ndjson", ["jsonl", "ndjson"], "application/x-ndjson", "data", "JSON Lines file", [
        "application/jsonl",
        "application/x-jsonlines",
        "text/jsonl",
    ]),
    text("yaml", ["yaml", "yml"], "application/yaml", "data", "YAML file", [
        "text/yaml",
        "text/x-yaml",
        "application/x-yaml",
    ]),
    text("toml", ["toml"], "application/toml", "data", "TOML file", [
        "text/toml",
        "text/x-toml",
    ]),
    text("ini", ["ini", "conf"], "text/x-ini", "data", "configuration file", [
        "text/inf",
        "application/textedit",
    ]),

    // -- Markup and documents that are really text --------------------------
    // Never rendered and never fetched from: an uploaded page is text the
    // model reads, so its scripts, handlers and external references are
    // characters in a document and nothing else.
    text("html", ["html", "htm"], "text/html", "markup", "HTML file"),
    text("xml", ["xml"], "application/xml", "markup", "XML file", ["text/xml"]),
    text("subrip", ["srt"], "application/x-subrip", "markup", "subtitle file", ["text/srt"]),
    text("webvtt", ["vtt"], "text/vtt", "markup", "subtitle file"),
    text("icalendar", ["ics"], "text/calendar", "data", "calendar file", [
        "application/ics",
        "text/x-vcalendar",
    ]),
    text("vcard", ["vcf"], "text/vcard", "data", "contact card file", ["text/x-vcard"]),

    // -- Source code --------------------------------------------------------
    // Read, never run. Nothing below is executed, imported, compiled or
    // evaluated at any point; each is decoded as text and fenced as data.
    text("python", ["py"], "text/x-python", "code", "Python source file", [
        "application/x-python",
        "application/x-python-code",
        "text/python",
    ]),
    text("javascript", ["js", "mjs", "cjs"], "text/javascript", "code", "JavaScript source file", [
        "application/javascript",
        "application/x-javascript",
        "text/x-javascript",
    ]),
    text("jsx", ["jsx"], "text/jsx", "code", "JavaScript source file"),
    text("typescript", ["ts"], "text/x-typescript", "code", "TypeScript source file", [
        "application/typescript",
        "application/x-typescript",
        // Windows maps `.ts` to an MPEG transport stream. A real one fails the
        // UTF decode, so honouring the extension here costs nothing.
        "video/mp2t",
    ]),
    text("tsx", ["tsx"], "text/x-tsx", "code", "TypeScript source file"),
    text("java", ["java"], "text/x-java-source", "code", "Java source file", ["text/x-java"]),
    text("c", ["c", "h"], "text/x-c", "code", "C source file", ["text/x-chdr", "text/x-csrc"]),
    text("cpp", ["cpp", "hpp", "cc", "cxx"], "text/x-c++src", "code", "C++ source file", [
        "text/x-c++hdr",
    ]),
    text("csharp", ["cs"], "text/x-csharp", "code", "C# source file"),
    text("go", ["go"], "text/x-go", "code", "Go source file"),
    text("rust", ["rs"], "text/x-rust", "code", "Rust source file", ["text/rust"]),
    text("ruby", ["rb"], "text/x-ruby", "code", "Ruby source file", ["application/x-ruby"]),
    text("php", ["php"], "text/x-php", "code", "PHP source file", ["application/x-httpd-php"]),
    text("kotlin", ["kt", "kts"], "text/x-kotlin", "code", "Kotlin source file"),
    text("swift", ["swift"], "text/x-swift", "code", "Swift source file"),
    text("scala", ["scala"], "text/x-scala", "code", "Scala source file"),
    text("r", ["r"], "text/x-r", "code", "R source file", ["text/x-r-source"]),
    text("sql", ["sql"], "application/sql", "code", "SQL file", ["text/x-sql", "text/sql"]),
    text("shell", ["sh", "bash"], "application/x-sh", "code", "shell script file", [
        "text/x-sh",
        "text/x-shellscript",
        "application/x-shellscript",
    ]),
    text("powershell", ["ps1"], "application/x-powershell", "code", "PowerShell script file", [
        "text/x-powershell",
    ]),
    text("css", ["css"], "text/css", "code", "CSS file"),
    text("scss", ["scss"], "text/x-scss", "code", "SCSS file"),
    text("less", ["less"], "text/x-less", "code", "LESS file"),
    text("vue", ["vue"], "text/x-vue", "code", "Vue component file"),
    text("svelte", ["svelte"], "text/x-svelte", "code", "Svelte component file"),
    text("graphql", ["graphql", "gql"], "application/graphql", "code", "GraphQL file", [
        "text/x-graphql",
    ]),
    text("protobuf", ["proto"], "text/x-protobuf", "code", "Protocol Buffers file"),
];

/**
 * Extensions refused before anything else looks at them, whatever media type
 * is claimed and whether they arrive on their own or inside an archive.
 *
 * The test is "does opening this run it", which is why `.sh`, `.ps1` and `.py`
 * are supported formats above and `.exe`, `.msi` and `.bat` are here: a shell
 * script is read as text by this product and by nothing else, while a Windows
 * batch file is one double-click from being a program on the reader's own
 * machine. Archive formats other than ZIP are here too -- one container
 * shape is supported and it is not extended by renaming.
 */
export const OTHER_ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
    "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "lz", "lzma", "zst", "cab",
    "iso", "dmg", "arj", "lzh", "ace", "z", "war", "ear",
]);

/**
 * Programs, installers, libraries and anything an operating system runs on
 * open. Refused as an upload, and fatal to an archive that contains one --
 * see `ARCHIVE_FATAL_EXTENSIONS` for why that is not merely "skipped".
 */
export const EXECUTABLE_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
    "exe", "dll", "so", "dylib", "bin", "com", "scr", "msi", "msix", "apk",
    "ipa", "jar", "app", "deb", "rpm", "pkg", "run", "elf", "wasm", "o", "obj",
    "class", "pyc", "pyo", "node",
    "bat", "cmd", "vbs", "vbe", "jse", "wsf", "wsh",
    "hta", "lnk", "reg", "ps1xml", "psm1", "scpt", "command", "gadget",
]);

/**
 * Extensions refused before anything else looks at them, whatever media type
 * is claimed and whether they arrive on their own or inside an archive.
 *
 * The test is "does opening this run it", which is why `.sh`, `.ps1` and `.py`
 * are supported formats above and `.exe`, `.msi` and `.bat` are here: a shell
 * script is read as text by this product and by nothing else, while a Windows
 * batch file is one double-click from being a program on the reader's own
 * machine. Archive formats other than ZIP are here too -- one container
 * shape is supported and it is not extended by renaming.
 */
export const REFUSED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
    ...OTHER_ARCHIVE_EXTENSIONS,
    ...EXECUTABLE_ATTACHMENT_EXTENSIONS,
]);

/**
 * Build output that is refused as an upload but only skipped inside an
 * archive.
 *
 * These are libraries and compiled classes, so attaching one on its own is
 * still refused for the reason everything in
 * `EXECUTABLE_ATTACHMENT_EXTENSIONS` is. Inside an archive the question is a
 * different one: a Gradle wrapper ships a `.jar`, a `node_modules` ships
 * `.node`, a Java tree ships `.class` next to the `.java` files somebody
 * actually wants read, and every Python tree ships a `__pycache__` full of
 * `.pyc`. Failing the whole upload for them would refuse the ordinary source
 * archives this feature exists to read, and skipping them costs the person
 * nothing -- there is no text in a compiled module either way.
 *
 * The line this keeps: an archive still fails whole for a program the reader
 * could run (`.exe`, `.msi`, `.bat`) and for a private key.
 */
export const ARCHIVE_TOLERATED_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
    "jar",
    "node",
    "class",
    "pyc",
    "pyo",
]);

/**
 * Extensions and names that make an archive fail whole rather than have the
 * entry skipped.
 *
 * An unsupported entry is ordinary -- a source tree has images this product
 * cannot read and lock files it has no parser for -- and dropping it costs
 * the user nothing. A private key is different in kind: the person almost
 * certainly did not mean to hand it to a model, and quietly excluding it
 * would leave them believing they had sent a directory they had not audited.
 */
export const ARCHIVE_FATAL_EXTENSIONS: ReadonlySet<string> = new Set([
    "pem", "key", "p12", "pfx", "jks", "keystore", "ppk", "crt", "cer", "der",
    "asc", "gpg", "pgp", "kdbx", "keychain",
]);

export const ARCHIVE_FATAL_FILENAMES: ReadonlySet<string> = new Set([
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ed25519_sk", "id_xmss",
    "identity", ".htpasswd", ".netrc", "_netrc", ".pgpass",
]);

/**
 * Declared types that carry no information. A browser that cannot name a file
 * says one of these, and treating that as a mismatch is what made a perfectly
 * ordinary `.csv` unattachable.
 */
const UNINFORMATIVE_MEDIA_TYPES: ReadonlySet<string> = new Set([
    "",
    "application/octet-stream",
    "binary/octet-stream",
    "application/x-empty",
    "application/unknown",
    "*/*",
]);

const byExtension = new Map<string, ChatAttachmentFormat>();
const byFilename = new Map<string, ChatAttachmentFormat>();
const byMediaType = new Map<string, ChatAttachmentFormat>();

for (const format of CHAT_ATTACHMENT_FORMATS) {
    for (const extension of format.extensions) {
        byExtension.set(extension, format);
    }
    for (const filename of format.filenames || []) {
        byFilename.set(filename, format);
    }
    byMediaType.set(format.mediaType, format);
    for (const alias of format.mediaTypeAliases) {
        // Canonical types win over another format's alias, whichever order
        // the table is written in.
        if (!byMediaType.has(alias)) byMediaType.set(alias, format);
    }
}

/** Canonical types only -- what an upload is allowed to declare and store. */
export const CHAT_ATTACHMENT_MEDIA_TYPES: ReadonlySet<string> = new Set(
    CHAT_ATTACHMENT_FORMATS.map((format) => format.mediaType)
);

export const GUEST_CHAT_ATTACHMENT_MEDIA_TYPES: ReadonlySet<string> = new Set(
    CHAT_ATTACHMENT_FORMATS.filter((format) => format.guestAllowed).map(
        (format) => format.mediaType
    )
);

/** Strips parameters and case from a declared media type. */
export const normalizeDeclaredMediaType = (value: string | null | undefined) =>
    (value || "").split(";", 1)[0].trim().toLowerCase();

/**
 * The lowercase extension of a filename, or "" when it has none. Any
 * directory part is dropped first so an archive entry path can be passed
 * straight in.
 */
export const attachmentFileExtension = (filename: string) => {
    const base = filename.split(/[\\/]/).pop() || "";
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

/** The lowercase final path segment, for the extensionless-name lookup. */
export const attachmentBaseName = (filename: string) =>
    (filename.split(/[\\/]/).pop() || "").toLowerCase();

export const formatByMediaType = (mediaType: string) =>
    byMediaType.get(normalizeDeclaredMediaType(mediaType)) || null;

/**
 * Which format a file is, from its name and whatever the browser said about
 * it.
 *
 * The name leads and the declared type is a hint, because that is the way
 * round the two are actually reliable: an extension is chosen by whoever
 * made the file, a media type is guessed by whoever is opening it. Neither
 * decides anything on its own -- the bytes are checked against
 * `format.signature` server-side before a parser sees them.
 *
 * Returns `null` for "this product does not read that", including when the
 * name and the declared type each name a *different* supported format. That
 * disagreement is the one case where guessing would be actively wrong.
 */
/**
 * Extensions whose declared media type, on a machine where an Office
 * application owns the association, names that application rather than the
 * file.
 *
 * Windows serves `File.type` from `HKCR\<ext>\Content Type`, which records
 * *what opens this*, not *what this is*. Install Word and every `.rtf` is
 * announced as `application/msword`; install Excel and every `.csv` and
 * `.tsv` is announced as `application/vnd.ms-excel`. Both are true statements
 * about the desktop and false statements about the bytes.
 *
 * Without the aliases below the resolver reads that as a name and a type
 * naming two different formats and refuses -- on the client, before the
 * server sees a byte. That is the same shape as the failure this registry was
 * built to end, arriving from the other side: not a missing type this time
 * but a confidently wrong one.
 *
 * Each pair is listed in the owning format's `mediaTypeAliases`;
 * `tests/chatAttachmentFormats.test.mjs` walks this table so a row cannot
 * lose its alias silently. Found on 2026-08-23 by a staging round that
 * attached the samples through a real Windows file picker -- which is the
 * whole reason that item exists, and it paid for itself before the first
 * paid turn of its own section.
 */
export const ASSOCIATION_OWNER_MEDIA_TYPES: ReadonlyArray<{
    readonly extension: string;
    readonly declared: string;
    readonly owner: string;
}> = [
    { extension: "rtf", declared: "application/msword", owner: "Word" },
    { extension: "csv", declared: "application/vnd.ms-excel", owner: "Excel" },
    { extension: "tsv", declared: "application/vnd.ms-excel", owner: "Excel" },
];

export function resolveChatAttachmentFormat({
    filename,
    declaredMediaType,
}: {
    filename: string;
    declaredMediaType?: string | null;
}): ChatAttachmentFormat | null {
    const extension = attachmentFileExtension(filename);
    if (extension && REFUSED_ATTACHMENT_EXTENSIONS.has(extension)) return null;

    const declared = normalizeDeclaredMediaType(declaredMediaType);
    const fromName =
        (extension ? byExtension.get(extension) : undefined) ||
        byFilename.get(attachmentBaseName(filename)) ||
        null;

    if (fromName) {
        if (UNINFORMATIVE_MEDIA_TYPES.has(declared)) return fromName;
        if (declared === fromName.mediaType) return fromName;
        if (fromName.mediaTypeAliases.includes(declared)) return fromName;
        // "text/plain" is what a browser falls back to for text it cannot
        // place, which is most of the code formats above.
        if (fromName.category === "text" && declared === "text/plain") return fromName;
        const fromType = byMediaType.get(declared);
        if (fromType) return fromType === fromName ? fromName : null;
        // A declared type this product has never heard of says nothing at
        // all; the extension is still good.
        return fromName;
    }

    // The name did not resolve, and a declared type alone does not get to.
    // A file called `report` sent as `application/pdf` may well be a PDF, but
    // the person looking at the composer has been told nothing about what
    // they attached, and neither has the model reading its header. The
    // extension is the only part of an upload that says what it is in a place
    // a human can see, so it is required.
    return null;
}

/** "text" for anything the server turns into characters, "file" otherwise. */
export const attachmentKindForFormat = (format: ChatAttachmentFormat) =>
    format.category === "text" ? ("text" as const) : ("file" as const);

/**
 * The `accept` attribute for the file picker.
 *
 * Both media types and extensions are listed: the media type is what a
 * well-behaved picker filters on, and the extension is what saves the file
 * that the picker could not name -- the exact case that made a `.md` with an
 * empty type unselectable.
 */
export function chatAttachmentAcceptAttribute({
    guest = false,
}: { guest?: boolean } = {}) {
    const formats = CHAT_ATTACHMENT_FORMATS.filter(
        (format) => !guest || format.guestAllowed
    );
    return [
        ...formats.map((format) => format.mediaType),
        ...formats.flatMap((format) =>
            format.extensions.map((extension) => `.${extension}`)
        ),
    ].join(",");
}

/**
 * The extensions of every format, grouped for display, so the sentence that
 * tells a person what they may attach is derived from the table rather than
 * typed next to it.
 */
export function chatAttachmentExtensionsByGroup({
    guest = false,
}: { guest?: boolean } = {}): Record<ChatAttachmentUiGroup, string[]> {
    const groups: Record<ChatAttachmentUiGroup, string[]> = {
        image: [],
        document: [],
        data: [],
        markup: [],
        code: [],
        archive: [],
    };
    for (const format of CHAT_ATTACHMENT_FORMATS) {
        if (guest && !format.guestAllowed) continue;
        groups[format.uiGroup].push(...format.extensions);
    }
    return groups;
}

/**
 * The media type the model is actually sent for a format, which is not always
 * the one that was uploaded: a GIF is normalized to PNG before it leaves this
 * process, so telling the provider "image/gif" would be a lie about the bytes
 * accompanying it.
 */
export const providerMediaTypeForFormat = (format: ChatAttachmentFormat) =>
    format.id === "gif" ? "image/png" : format.mediaType;
