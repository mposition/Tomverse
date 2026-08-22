/**
 * What an uploaded ZIP is allowed to cost, and why each number is that number.
 *
 * Contract: docs/policy/chat-attachment-formats.md.
 *
 * These are deliberately **not** the external-import archive limits in
 * `lib/externalImportLimits.ts`. That feature opens a 1GB Google Takeout in
 * the browser, on the user's own machine, and never sends the container to
 * the server; this one inflates a container *on the server*, inside a chat
 * request that is already holding a model reservation. Same file format,
 * opposite cost model, so borrowing those figures would have moved a
 * client-side convenience bound onto a server-side budget.
 *
 * Pure: the composer reads the container ceiling to pre-empt a rejection, the
 * server reads all of them to decide one.
 */

export type ChatArchiveScope = "account" | "guest";

export type ChatArchiveLimits = {
    /** The compressed upload itself. Matches the per-file attachment ceiling. */
    readonly maxArchiveBytes: number;
    /**
     * Entries in the central directory, before anything is selected. A
     * directory listing this long is a container of a different kind --
     * a backup, a `node_modules` -- and reading it is not what the feature is
     * for.
     */
    readonly maxEntries: number;
    /**
     * How many entries are actually parsed. Every one of these runs a parser
     * in a worker, so this is the figure that bounds wall-clock time, not
     * `maxEntries`.
     */
    readonly maxProcessedFiles: number;
    /** Largest single entry after inflation. */
    readonly maxEntryUncompressedBytes: number;
    /** Everything inflated from one archive, added up. */
    readonly maxTotalUncompressedBytes: number;
    /** Refuses the classic bomb: a few KB that becomes gigabytes. */
    readonly maxCompressionRatio: number;
    /** Zero. An archive inside an archive is not opened. */
    readonly maxNestedArchiveDepth: 0;
    /**
     * How many PDFs from one archive may reach the paid OCR fallback.
     *
     * A PDF attached on its own is one deliberate act by one person, and
     * spending OCR on it is the feature working. Twenty scans arriving inside
     * a container the user dragged in is a different event with the same
     * shape, and the per-page cost is real money that nothing in the request
     * asked about. Beyond this count an image-only PDF is reported as
     * excluded -- "no readable text" -- rather than billed.
     *
     * Zero for guests, who cannot reach OCR on a direct attachment either.
     */
    readonly maxOcrPdfs: number;
    /**
     * Longest entry path, and longest single segment. A 4KB filename is not a
     * filename; it is an attempt to bury the rest of a prompt header.
     */
    readonly maxEntryPathLength: number;
    readonly maxEntryPathSegmentLength: number;
};

/**
 * A signed-in account. The container ceiling is the per-file attachment
 * ceiling (`MAX_ATTACHMENT_SIZE`), the per-entry ceiling matches it because
 * an entry may be an attachment-sized document, and the total is five times
 * that -- generous enough for a source tree, far below anything that would
 * matter to the process.
 */
const ACCOUNT_ARCHIVE_LIMITS: ChatArchiveLimits = {
    maxArchiveBytes: 10 * 1024 * 1024,
    maxEntries: 100,
    maxProcessedFiles: 20,
    maxEntryUncompressedBytes: 10 * 1024 * 1024,
    maxTotalUncompressedBytes: 50 * 1024 * 1024,
    maxCompressionRatio: 100,
    maxNestedArchiveDepth: 0,
    maxOcrPdfs: 3,
    maxEntryPathLength: 1_024,
    maxEntryPathSegmentLength: 255,
};

/**
 * A guest. Half the container, a quarter of the files, and no OCR -- the same
 * relationship every other guest limit has to its signed-in counterpart. A
 * guest chat is a trial, not an archive reader.
 */
const GUEST_ARCHIVE_LIMITS: ChatArchiveLimits = {
    maxArchiveBytes: 5 * 1024 * 1024,
    maxEntries: 100,
    maxProcessedFiles: 5,
    maxEntryUncompressedBytes: 5 * 1024 * 1024,
    maxTotalUncompressedBytes: 20 * 1024 * 1024,
    maxCompressionRatio: 100,
    maxNestedArchiveDepth: 0,
    maxOcrPdfs: 0,
    maxEntryPathLength: 1_024,
    maxEntryPathSegmentLength: 255,
};

export const chatArchiveLimits = (scope: ChatArchiveScope): ChatArchiveLimits =>
    scope === "guest" ? GUEST_ARCHIVE_LIMITS : ACCOUNT_ARCHIVE_LIMITS;

/** Wall-clock ceiling for inflating one archive, in its own worker. */
export const CHAT_ARCHIVE_INFLATE_TIMEOUT_MS = 15_000;

/** Heap ceiling for that worker. Above the total-inflation cap, not far above. */
export const CHAT_ARCHIVE_WORKER_MAX_OLD_SPACE_MB = 256;

/**
 * Every way reading an archive can end badly, as codes rather than sentences.
 *
 * The client turns these into localized copy
 * (`lib/chatAttachmentErrorCopy.ts`); nothing here is user-facing, and no
 * parser message, entry name or path is ever attached to one. A path is
 * attacker-controlled text and an error is a place it would be echoed.
 */
export const CHAT_ARCHIVE_ERROR_CODES = {
    corrupt: "ARCHIVE_CORRUPT",
    encrypted: "ARCHIVE_ENCRYPTED",
    zip64: "ARCHIVE_ZIP64_UNSUPPORTED",
    tooManyEntries: "ARCHIVE_TOO_MANY_ENTRIES",
    entryTooLarge: "ARCHIVE_ENTRY_TOO_LARGE",
    expansionTooLarge: "ARCHIVE_EXPANSION_TOO_LARGE",
    compressionRatio: "ARCHIVE_COMPRESSION_RATIO",
    unsafePath: "ARCHIVE_UNSAFE_PATH",
    executableEntry: "ARCHIVE_EXECUTABLE_ENTRY",
    credentialEntry: "ARCHIVE_CREDENTIAL_ENTRY",
    unsupportedCompression: "ARCHIVE_UNSUPPORTED_COMPRESSION",
    sizeMismatch: "ARCHIVE_SIZE_MISMATCH",
    noSupportedFiles: "ARCHIVE_NO_SUPPORTED_FILES",
    timeout: "ARCHIVE_PROCESSING_TIMEOUT",
} as const;

export type ChatArchiveErrorCode =
    (typeof CHAT_ARCHIVE_ERROR_CODES)[keyof typeof CHAT_ARCHIVE_ERROR_CODES];

/** Why one entry was left out. Reported as counts, never as paths. */
export type ChatArchiveExclusionReason =
    | "unsupported-format"
    | "nested-archive"
    | "directory"
    | "empty"
    | "beyond-file-limit"
    | "beyond-text-budget"
    | "unreadable";
