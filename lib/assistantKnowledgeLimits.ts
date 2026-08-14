/**
 * The quota and file-type contract for assistant knowledge (Release C, C2).
 *
 * docs/policy/external-conversation-import-and-memory.md §14.1 settles the
 * seven figures below and §14.2 the retention; both were approved on
 * 2026-08-13. Changing a number here is a policy change, so change the policy
 * first — the figures are load-bearing in the sense that a reviewer can check
 * each one against a sentence.
 *
 * Central, like `lib/externalImportLimits.ts` is for Release A: the server
 * enforces, the UI mirrors for display, and there is one place where the two
 * can disagree rather than several.
 *
 * Pure: no Prisma, no R2, no clock.
 */

/**
 * §14.1, as approved. Each figure's reasoning is in the policy; the short
 * version is repeated here because a constant with no reason next to it gets
 * "adjusted".
 */
export const ASSISTANT_KNOWLEDGE_LIMITS = {
    /**
     * Extraction reads the whole object, so this is the same physical
     * constraint as `IMAGE_ORIGINAL_MAX_READ_BYTES` — the largest single R2
     * object the server will pull into memory. Same value, separate decision:
     * moving one must not move the other.
     */
    maxFileBytes: 32 * 1024 * 1024,
    /**
     * The largest single block of text the server will take from one file,
     * matching the import API's per-message inbound ceiling. Text beyond it is
     * refused rather than silently truncated: a knowledge file the owner
     * believes is complete and is not is worse than one that would not upload.
     */
    maxExtractedCodePoints: 1_000_000,
    /**
     * A lexical retriever's top-k stops being meaningful past this. A quality
     * limit, not a storage one — it moves when retrieval does.
     */
    maxFilesPerProfile: 20,
    maxProfilesPerAccount: 20,
    /**
     * Not 20x20. Nobody fills every profile, and the account ceiling has to be
     * what the chunk table and the deletion sweep can carry.
     */
    maxFilesPerAccount: 100,
    /**
     * Deliberately below `maxFilesPerAccount * maxFileBytes` (3.2GiB). The two
     * ceilings guard different things — count guards retrieval quality and the
     * management UI, bytes guard storage cost — and in practice bytes bind
     * first, which is the intended order.
     */
    maxObjectBytesPerAccount: 500 * 1024 * 1024,
    /**
     * The same figure Release A gives imported text, and a separate budget: an
     * account that has filled its import allowance still has all of this.
     */
    maxExtractedBytesPerAccount: 50 * 1024 * 1024,
} as const;

/**
 * §14.2. Retention is not a duration for an active file — that is the
 * decision, not an omission. A profile is a tool its owner keeps using, and a
 * file that quietly expires produces a profile that gets worse for reasons no
 * user can distinguish from a bug.
 */
export const ASSISTANT_KNOWLEDGE_RETENTION = {
    /**
     * How long an object with no row may sit before the sweep takes it. Longer
     * than the guest-attachment hour because a failed extraction is retried,
     * and a short window would let a retry lose its own source.
     */
    abandonedObjectTtlMs: 24 * 60 * 60 * 1000,
    /**
     * Tombstones past this are left for an operator rather than retried
     * forever, mirroring `IMAGE_ASSET_CLEANUP_MAX_ATTEMPTS`.
     */
    cleanupMaxAttempts: 10,
    /** Content-free deletion audit metadata, same window as export audit. */
    auditRetentionMs: 90 * 24 * 60 * 60 * 1000,
} as const;

/** Private object namespace. Never rendered, never sent to a client. */
export const ASSISTANT_KNOWLEDGE_KEY_PREFIX = "assistant-knowledge/";

/* ------------------------------------------------- the closed vocabularies */

/**
 * The processing lifecycle, as a runtime list rather than as literals spread
 * through the pipeline.
 *
 * A CHECK constraint enforces the same four values, and
 * `npm run check:enum-constraints` compares the two on every run. That
 * comparison is the point: a status decides two different things in two
 * different places -- the worker claims "pending", retrieval reads "ready" --
 * so a value that exists in one and not the other is a row invisible to both.
 */
export const KNOWLEDGE_PROCESSING_STATUSES = [
    "pending",
    "processing",
    "ready",
    "failed",
] as const;

export type KnowledgeProcessingStatus =
    (typeof KNOWLEDGE_PROCESSING_STATUSES)[number];

/**
 * Why a stored object is queued for deletion (§14.2). Same arrangement: the
 * list and the constraint are checked against each other.
 */
export const KNOWLEDGE_CLEANUP_REASONS = [
    "file_deleted",
    "profile_deleted",
    "account_deleted",
    "upload_abandoned",
] as const;

export type KnowledgeCleanupReason = (typeof KNOWLEDGE_CLEANUP_REASONS)[number];

/* --------------------------------------------------------- file types */

/**
 * What a knowledge file may be, and which extensions may carry it.
 *
 * Narrower than the chat attachment allowlist, and the difference is the
 * point: an attachment can be an image because a model reads it directly,
 * while a knowledge file has to become *text* to be chunked and indexed.
 * An image here would upload, extract nothing, and sit in the list as a file
 * that is present and never retrieved — so it is refused at the edge with a
 * reason instead.
 */
export const ASSISTANT_KNOWLEDGE_TYPES: Record<string, readonly string[]> = {
    "text/plain": ["txt", "text", "log"],
    "text/markdown": ["md", "markdown"],
    "text/csv": ["csv"],
    "application/json": ["json"],
    "application/pdf": ["pdf"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
        "docx",
    ],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": [
        "pptx",
    ],
    "application/vnd.oasis.opendocument.text": ["odt"],
    "application/vnd.oasis.opendocument.spreadsheet": ["ods"],
    "application/vnd.oasis.opendocument.presentation": ["odp"],
};

export const ASSISTANT_KNOWLEDGE_TEXT_TYPES = new Set([
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
]);

export const ASSISTANT_KNOWLEDGE_OFFICE_TYPES = new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
]);

/**
 * The magic bytes each accepted binary type must actually start with.
 *
 * The declared media type is a claim by the uploader and the extension is a
 * claim by the filename; neither is evidence. Office formats are ZIP
 * containers, so they share the ZIP signature here and are separately checked
 * for bombs and traversal by `assertSafeOfficeArchive` — the signature says
 * "this is a ZIP", not "this is safe".
 *
 * Text types have no signature and are absent on purpose: any byte sequence is
 * a valid text file, so the check for them is that they decode as UTF-8, which
 * happens during extraction.
 */
const MAGIC_BYTES: Record<string, readonly number[][]> = {
    "application/pdf": [[0x25, 0x50, 0x44, 0x46]], // %PDF
    zip: [
        [0x50, 0x4b, 0x03, 0x04],
        // An empty or spanned archive. Accepted as a signature match so a
        // legitimate-but-unusual container fails the archive checks with a
        // reason rather than failing here as "not a ZIP".
        [0x50, 0x4b, 0x05, 0x06],
        [0x50, 0x4b, 0x07, 0x08],
    ],
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
    signature.every((byte, index) => bytes[index] === byte);

/**
 * Whether the leading bytes match what the declared type must begin with.
 *
 * `true` for a text type, which has no signature to check. `false` only when
 * a type that does have one does not match it.
 */
export function knowledgeSignatureMatches(
    mime: string,
    leadingBytes: Uint8Array
): boolean {
    if (ASSISTANT_KNOWLEDGE_TEXT_TYPES.has(mime)) return true;
    const signatures = ASSISTANT_KNOWLEDGE_OFFICE_TYPES.has(mime)
        ? MAGIC_BYTES.zip
        : MAGIC_BYTES[mime];
    if (!signatures) return false;
    return signatures.some((signature) => startsWith(leadingBytes, signature));
}

/** How many leading bytes a caller has to read for the check above. */
export const KNOWLEDGE_SIGNATURE_SCAN_BYTES = 8;

/* ------------------------------------------------------- §18 refusals */

/** §18 릴리스 C. Held here so no route invents a variant. */
export const ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE =
    "ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE";
export const ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED =
    "ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED";

export type KnowledgeRefusal = {
    code:
        | typeof ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE
        | typeof ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED;
    /** Which limit or claim failed, for a message the owner can act on. */
    detail: string;
};

const extensionOf = (filename: string): string => {
    const dot = filename.lastIndexOf(".");
    if (dot <= 0 || dot === filename.length - 1) return "";
    return filename.slice(dot + 1).toLowerCase();
};

/**
 * Whether this file may be accepted at all, judged on what the request claims.
 *
 * Both directions are checked, as the guest attachment allowlist does: an
 * executable renamed `.pdf` fails the signature check, and a genuine PDF named
 * `.zip` fails here. Returning the first refusal rather than a list, because
 * the caller shows one file's problem at a time and a second reason for a file
 * that is already refused changes nothing.
 */
export function knowledgeFileRefusal(input: {
    filename: string;
    mime: string;
    bytes: number;
    /** The first `KNOWLEDGE_SIGNATURE_SCAN_BYTES`, when the caller has them. */
    leadingBytes?: Uint8Array;
}): KnowledgeRefusal | null {
    const refuse = (detail: string): KnowledgeRefusal => ({
        code: ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE,
        detail,
    });

    const extensions = ASSISTANT_KNOWLEDGE_TYPES[input.mime];
    if (!extensions) return refuse(`the media type ${input.mime} is not accepted`);

    const extension = extensionOf(input.filename);
    if (extension === "") return refuse("the filename has no extension");
    if (!extensions.includes(extension)) {
        return refuse(
            `a .${extension} file cannot carry ${input.mime}`
        );
    }

    if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
        return refuse("the file is empty");
    }
    if (input.bytes > ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes) {
        return refuse(
            `the file is larger than ${ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes} bytes`
        );
    }

    if (
        input.leadingBytes &&
        !knowledgeSignatureMatches(input.mime, input.leadingBytes)
    ) {
        return refuse(`the file does not begin like ${input.mime}`);
    }

    return null;
}

/* ------------------------------------------------------------- quota */

/** What the account already holds. Every figure is server-computed. */
export type KnowledgeUsage = {
    filesInProfile: number;
    filesInAccount: number;
    objectBytesInAccount: number;
    extractedBytesInAccount: number;
};

/**
 * Whether one more file of this size fits.
 *
 * Checked before the object is accepted, not after: an upload that is refused
 * at the end has already cost the owner the wait and Tomverse the bytes. The
 * extracted-text ceiling cannot be checked here — nobody knows how much text a
 * PDF holds until it is read — so it is enforced again after extraction, and
 * `extractedBytesInAccount` is present so the pre-check refuses an account
 * that is already over.
 *
 * Ordered so the ceiling a person can act on comes first: deleting a file
 * fixes a count, and there is nothing to do about a file that is simply too
 * large.
 */
export function knowledgeQuotaRefusal(input: {
    usage: KnowledgeUsage;
    incomingBytes: number;
}): KnowledgeRefusal | null {
    const limits = ASSISTANT_KNOWLEDGE_LIMITS;
    const refuse = (detail: string): KnowledgeRefusal => ({
        code: ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED,
        detail,
    });
    const { usage } = input;

    if (usage.filesInProfile >= limits.maxFilesPerProfile) {
        return refuse(
            `this profile already holds ${limits.maxFilesPerProfile} files`
        );
    }
    if (usage.filesInAccount >= limits.maxFilesPerAccount) {
        return refuse(
            `this account already holds ${limits.maxFilesPerAccount} knowledge files`
        );
    }
    if (
        usage.objectBytesInAccount + input.incomingBytes >
        limits.maxObjectBytesPerAccount
    ) {
        return refuse(
            `this file would take the account past ${limits.maxObjectBytesPerAccount} stored bytes`
        );
    }
    if (usage.extractedBytesInAccount >= limits.maxExtractedBytesPerAccount) {
        return refuse(
            `this account is already at ${limits.maxExtractedBytesPerAccount} bytes of extracted text`
        );
    }
    return null;
}

/**
 * The same account ceiling, applied to text that has now been read.
 *
 * Separate from the pre-check because it answers a different question with
 * information the pre-check did not have. A file that passes upload and fails
 * here is a processing failure, not a rejected upload: the object exists, so
 * the row records why and the tombstone gets the bytes.
 */
export function knowledgeExtractedTextRefusal(input: {
    extractedBytesInAccount: number;
    incomingExtractedBytes: number;
    extractedCodePoints: number;
}): KnowledgeRefusal | null {
    const limits = ASSISTANT_KNOWLEDGE_LIMITS;
    if (input.extractedCodePoints > limits.maxExtractedCodePoints) {
        return {
            code: ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE,
            detail: `the file holds more than ${limits.maxExtractedCodePoints} characters of text`,
        };
    }
    if (
        input.extractedBytesInAccount + input.incomingExtractedBytes >
        limits.maxExtractedBytesPerAccount
    ) {
        return {
            code: ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED,
            detail: `this file's text would take the account past ${limits.maxExtractedBytesPerAccount} bytes`,
        };
    }
    return null;
}

/** What the capacity endpoint and the UI show before a file is chosen. */
export function knowledgeRemainingCapacity(usage: KnowledgeUsage) {
    const limits = ASSISTANT_KNOWLEDGE_LIMITS;
    const floor = (value: number) => (value > 0 ? value : 0);
    return {
        filesInProfile: floor(limits.maxFilesPerProfile - usage.filesInProfile),
        filesInAccount: floor(limits.maxFilesPerAccount - usage.filesInAccount),
        objectBytes: floor(
            limits.maxObjectBytesPerAccount - usage.objectBytesInAccount
        ),
        extractedBytes: floor(
            limits.maxExtractedBytesPerAccount - usage.extractedBytesInAccount
        ),
    };
}
