import {
    EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS as ARCHIVE_LIMITS,
} from "@/lib/externalImportLimits";

/**
 * Archive entry classification and safety rules for external import.
 *
 * docs/policy/external-conversation-import-and-memory.md §5.1–§5.2.
 *
 * The archive is opened in the browser and never uploaded, so nothing here
 * is an API security boundary. What it does prevent is a hostile or merely
 * enormous archive taking the tab down, and it decides — before a single
 * byte is inflated — which entries are worth reading at all:
 *
 *   * media entries are skipped without inflating (a ChatGPT export is mostly
 *     images; the conversation JSON is a fraction of it, so gating on total
 *     archive size would reject exactly the heavy users who want this most);
 *   * traversal paths, absolute paths and encrypted entries are refused rather
 *     than sanitized — the safe answer to "why does this export contain
 *     `../../etc/passwd`" is not to fix up the name;
 *   * nested archives are never unpacked, but they are skipped rather than
 *     refused: a user who attached a `.zip` to a chat has one sitting in an
 *     otherwise ordinary export, and refusing that entry refuses the export;
 *   * per-entry and cumulative inflate budgets bound what parsing can cost,
 *     including the compression ratio of what actually gets inflated.
 *
 * Pure and isomorphic: the worker and the tests run the same code.
 */

export type ArchiveEntryDecision =
    | { kind: "parse"; role: "conversations" | "candidate" }
    | { kind: "skip"; reason: ArchiveSkipReason }
    | { kind: "reject"; reason: ArchiveRejectReason };

export type ArchiveSkipReason =
    | "directory"
    | "media"
    | "unsupported_extension"
    | "metadata"
    | "empty"
    | "nested_archive";

export type ArchiveRejectReason =
    | "path_traversal"
    | "absolute_path"
    | "encrypted"
    | "entry_too_large"
    | "suspicious_compression_ratio";

export type ArchiveEntryInfo = {
    /** Entry name exactly as stored in the archive. */
    name: string;
    /** Uncompressed size in bytes, from the archive's own directory. */
    uncompressedBytes: number;
    /** Compressed size in bytes, when the archive reports one. */
    compressedBytes?: number;
    encrypted?: boolean;
};

const MEDIA_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "heic", "heif",
    "mp3", "wav", "m4a", "ogg", "oga", "flac", "aac", "opus",
    "mp4", "mov", "webm", "avi", "mkv",
    "pdf", "bin", "dat",
]);

const NESTED_ARCHIVE_EXTENSIONS = new Set([
    "zip", "tgz", "gz", "tar", "bz2", "xz", "7z", "rar",
]);

const PARSEABLE_EXTENSIONS = new Set(["json", "jsonl"]);

/** Not parsed, but recognisable enough to explain what went wrong (§6). */
const HTML_EXTENSIONS = new Set(["html", "htm"]);

/** Conversation payload filenames, by provider export layout. */
const CONVERSATION_FILENAMES = new Set([
    "conversations.json",
    "chat_history.json",
]);

const extensionOf = (name: string): string => {
    const base = name.split("/").pop() ?? name;
    const dot = base.lastIndexOf(".");
    return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
};

const basenameOf = (name: string): string =>
    (name.split("/").pop() ?? name).toLowerCase();

/**
 * Decides what to do with one archive entry, using only its directory
 * metadata — no inflation has happened yet when this is called.
 */
export function classifyArchiveEntry(
    entry: ArchiveEntryInfo,
    limits: typeof ARCHIVE_LIMITS = ARCHIVE_LIMITS
): ArchiveEntryDecision {
    const name = entry.name;

    // Traversal and absolute paths are refused even though nothing is written
    // to disk: an export containing them is not an export we understand, and
    // the entry name reaches UI and telemetry paths later.
    if (name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name)) {
        return { kind: "reject", reason: "absolute_path" };
    }
    const segments = name.split(/[\\/]/);
    if (segments.some((segment) => segment === "..")) {
        return { kind: "reject", reason: "path_traversal" };
    }
    if (entry.encrypted) {
        return { kind: "reject", reason: "encrypted" };
    }

    if (name.endsWith("/") || name.endsWith("\\")) {
        return { kind: "skip", reason: "directory" };
    }

    const extension = extensionOf(name);
    if (NESTED_ARCHIVE_EXTENSIONS.has(extension)) {
        // §5.2: extraction depth stays 0 -- a nested archive is never opened,
        // enumerated or inspected. It is skipped rather than refused because a
        // user attaching a .zip to a chat puts one in an otherwise ordinary
        // export, and refusing the entry refuses the whole export with it.
        // Counted under its own reason: folded into unsupported_extension, the
        // preview could not say why an attachment is missing.
        return { kind: "skip", reason: "nested_archive" };
    }

    // Media is skipped before any size check: it is never inflated, so its
    // size cannot exhaust anything.
    if (MEDIA_EXTENSIONS.has(extension)) {
        return { kind: "skip", reason: "media" };
    }
    if (!PARSEABLE_EXTENSIONS.has(extension)) {
        return { kind: "skip", reason: "unsupported_extension" };
    }
    if (entry.uncompressedBytes === 0) {
        return { kind: "skip", reason: "empty" };
    }

    // From here the entry would actually be inflated, so its budget applies.
    if (entry.uncompressedBytes > limits.maxParsedEntryBytes) {
        return { kind: "reject", reason: "entry_too_large" };
    }
    if (
        entry.compressedBytes !== undefined &&
        entry.compressedBytes > 0 &&
        entry.uncompressedBytes / entry.compressedBytes >
            limits.maxParsedEntryCompressionRatio
    ) {
        return { kind: "reject", reason: "suspicious_compression_ratio" };
    }

    const base = basenameOf(name);
    if (CONVERSATION_FILENAMES.has(base)) {
        return { kind: "parse", role: "conversations" };
    }
    // Provider layouts move the payload around between export versions, so a
    // JSON entry that is not obviously metadata stays a candidate rather than
    // being dropped on a filename guess.
    if (base === "user.json" || base === "message_feedback.json" ||
        base === "shared_conversations.json" || base === "model_comparisons.json") {
        return { kind: "skip", reason: "metadata" };
    }
    return { kind: "parse", role: "candidate" };
}

export type ArchivePlan = {
    parse: Array<{ entry: ArchiveEntryInfo; role: "conversations" | "candidate" }>;
    skipped: Record<ArchiveSkipReason, number>;
    /** Total uncompressed bytes of media that was skipped, for the preview. */
    skippedMediaBytes: number;
};

export class ExternalImportArchiveError extends Error {
    constructor(
        message: string,
        public readonly reason:
            | ArchiveRejectReason
            | "too_many_entries"
            | "archive_too_large"
            | "parsed_budget_exceeded"
            | "no_conversation_data"
            | "html_export_unsupported"
    ) {
        super(message);
        this.name = "ExternalImportArchiveError";
    }
}

/**
 * Plans a whole archive from its directory listing. Throws on the first
 * entry that must be refused — a malicious archive is not partially imported
 * — but counts skips, which are normal and are shown in the preview.
 */
export function planArchiveEntries(
    entries: readonly ArchiveEntryInfo[],
    options: {
        archiveBytes: number;
        limits?: typeof ARCHIVE_LIMITS;
    }
): ArchivePlan {
    const limits = options.limits ?? ARCHIVE_LIMITS;
    if (options.archiveBytes > limits.maxArchiveContainerBytes) {
        throw new ExternalImportArchiveError(
            "The archive is larger than the supported limit.",
            "archive_too_large"
        );
    }
    if (entries.length > limits.maxArchiveEntries) {
        throw new ExternalImportArchiveError(
            "The archive contains more entries than the supported limit.",
            "too_many_entries"
        );
    }

    const plan: ArchivePlan = {
        parse: [],
        skipped: {
            directory: 0,
            media: 0,
            unsupported_extension: 0,
            metadata: 0,
            empty: 0,
            nested_archive: 0,
        },
        skippedMediaBytes: 0,
    };
    let parsedBudget = 0;

    for (const entry of entries) {
        const decision = classifyArchiveEntry(entry, limits);
        if (decision.kind === "reject") {
            throw new ExternalImportArchiveError(
                `Refusing archive entry: ${decision.reason}.`,
                decision.reason
            );
        }
        if (decision.kind === "skip") {
            plan.skipped[decision.reason] += 1;
            if (decision.reason === "media") {
                plan.skippedMediaBytes += entry.uncompressedBytes;
            }
            continue;
        }
        parsedBudget += entry.uncompressedBytes;
        if (parsedBudget > limits.maxParsedTextTotalBytes) {
            throw new ExternalImportArchiveError(
                "The archive's parseable content exceeds the supported total.",
                "parsed_budget_exceeded"
            );
        }
        plan.parse.push({ entry, role: decision.role });
    }

    if (plan.parse.length === 0) {
        // An export that holds HTML where the conversations should be is the
        // one failure the user can fix themselves: Google Takeout offers JSON
        // or HTML for My Activity, and only JSON is supported (A2 §6). Saying
        // "unreadable" would send them to support for a re-export they could
        // do in a minute. Detected by extension, never by a path segment --
        // those are translated to the account's language (A2 §3.1).
        if (entries.some((entry) => HTML_EXTENSIONS.has(extensionOf(entry.name)))) {
            throw new ExternalImportArchiveError(
                "The export contains HTML where the conversation data should be.",
                "html_export_unsupported"
            );
        }
        throw new ExternalImportArchiveError(
            "The archive contains no conversation data.",
            "no_conversation_data"
        );
    }

    // Known payload filenames first: on a normal export the very first entry
    // parsed is the conversation file, so an unrelated JSON never spends the
    // budget ahead of it.
    plan.parse.sort((a, b) =>
        a.role === b.role ? 0 : a.role === "conversations" ? -1 : 1
    );
    return plan;
}

/** True when the entry must go through the incremental parser (§5.1). */
export function requiresStreamingParse(
    entry: ArchiveEntryInfo,
    limits: typeof ARCHIVE_LIMITS = ARCHIVE_LIMITS
): boolean {
    return entry.uncompressedBytes > limits.maxSyncJsonParseBytes;
}

/**
 * One entry's buffered text, turned into conversation items — or abandoned.
 *
 * The two roles are held to different standards, and that asymmetry is the
 * whole point of this function.
 *
 * `conversations` names the authoritative payload. If it will not parse, the
 * import has nothing to import, so the failure is raised and the caller fails
 * closed.
 *
 * `candidate` is a JSON entry whose purpose is unknown. Export layouts move
 * the payload between versions, so anything that is not obviously metadata is
 * opened in case it holds conversations; it failing to parse means only that
 * it did not. Ending the import over one would throw away the payload sitting
 * beside it.
 *
 * That is not hypothetical. A 2026-08 Claude export ships `users.json`,
 * `memories.json`, `login_history.json`, `projects/<uuid>.json` and
 * `reflections/<uuid>.json` next to `conversations.json`. None are in the
 * metadata skip list, so all six classify as `candidate`, and several hold a
 * JSON *object*. The caller used to spread the parsed value straight into an
 * array, so an object threw a bare `TypeError` — not one of the typed archive
 * errors, therefore the catch-all `unreadable_archive`. The user was told
 * their export could not be read while three megabytes of readable
 * conversations sat in the same file.
 *
 * A skipped candidate is reported to nobody, deliberately: nobody asked for
 * `login_history.json` to be imported, so its shape is not their concern.
 */
export function readArchiveEntryItems(
    text: string,
    role: "conversations" | "candidate"
): { items: unknown[] } | { skipped: true } {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        if (role === "candidate") return { skipped: true };
        throw error;
    }
    if (!Array.isArray(value)) {
        if (role === "candidate") return { skipped: true };
        throw new ExternalImportArchiveError(
            "The entry is not a list of conversations.",
            "no_conversation_data"
        );
    }
    return { items: value };
}
