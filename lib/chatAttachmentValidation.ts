import "server-only";

import {
    providerMediaTypeForFormat,
    type ChatAttachmentFormat,
} from "@/lib/chatAttachmentFormats";
import { decodeAttachmentText } from "@/lib/chatAttachmentText";
import { ChatArchiveError } from "@/lib/chatArchive";
import {
    CHAT_ARCHIVE_ERROR_CODES,
    chatArchiveLimits,
    type ChatArchiveScope,
} from "@/lib/chatArchiveLimits";
import {
    ChatArchivePlanError,
    planChatArchive,
    totalArchiveExclusions,
} from "@/lib/chatArchivePlan";
import {
    AnimatedImageError,
    extractPdfTextSafely,
    normalizeImageSafely,
    normalizedImageMediaType,
    validatePdfSafely,
    type NormalizableImageMediaType,
} from "@/lib/mediaSecurity";
import { assertSafeOfficeArchive, parseOfficeSafely } from "@/lib/officeSecurity";
import {
    extractLegacyOfficeText,
    LegacyOfficeError,
    type LegacyOfficeFormatId,
} from "@/lib/legacyOfficeText";

/**
 * Proving an upload is what it says it is, in one place, for every caller.
 *
 * Contract: docs/policy/chat-attachment-formats.md.
 *
 * There used to be two answers to this question and they were not the same
 * one. A guest upload was validated and *parsed* inside the request that
 * carried the bytes -- signature, worker-isolated parser, extracted-text
 * ceiling -- before anything was stored. A signed-in upload went straight to
 * object storage and was finalized by checking the object's *metadata*: its
 * size and the Content-Type the browser had asked to store it under. Both of
 * those are claims made by the uploader. Nothing looked at a byte until the
 * user pressed send, sometimes minutes later, at which point the failure
 * arrived as a red chat turn rather than a rejected file.
 *
 * So the finalize step now reads the object it just accepted and runs the
 * same checks the guest path runs. What "the same checks" means per format is
 * below, and the cost of each is deliberate:
 *
 *   * images are normalized -- the only way to know a GIF is a still frame;
 *   * a PDF is opened, but its text is not extracted (that happens per turn,
 *     against the request's own character budget);
 *   * an Office file's ZIP container is walked, but its text is not
 *     extracted, for the same reason;
 *   * text is decoded strictly, which is the whole check for that family;
 *   * an archive's central directory is read in full -- every path, size,
 *     ratio and entry-count refusal lands here -- but nothing is inflated
 *     until the turn that sends it.
 *
 * The guest path passes `maxExtractedCharacters` and gets the stricter
 * behaviour it already had: the text is extracted here too, because a guest
 * has an input-token ceiling low enough that "this document is too long"
 * needs saying at upload, while the person is still looking at the file.
 */

export type ChatAttachmentValidationCode =
    | "ATTACHMENT_TYPE_MISMATCH"
    | "ATTACHMENT_ENCODING_UNREADABLE"
    | "ATTACHMENT_ANIMATED_IMAGE"
    | "INVALID_IMAGE_ATTACHMENT"
    | "INVALID_PDF_ATTACHMENT"
    | "ATTACHMENT_NO_TEXT"
    | "ATTACHMENT_TEXT_TOO_LARGE"
    | "ATTACHMENT_ENCRYPTED"
    | "ATTACHMENT_UNREADABLE";

export class ChatAttachmentValidationError extends Error {
    constructor(
        public readonly code: ChatAttachmentValidationCode,
        public readonly status = 400
    ) {
        super(code);
        this.name = "ChatAttachmentValidationError";
    }
}

export type ArchiveUploadSummary = {
    /** Entries in the archive, directories included. */
    readonly totalEntries: number;
    /** Entries this product will read on send. */
    readonly includedFiles: number;
    /** Entries left out, excluding directories and empty files. */
    readonly excludedFiles: number;
};

export type ChatAttachmentValidationResult = {
    /**
     * The bytes to store. Identical to the input for everything except an
     * image, which is re-encoded: metadata stripped, orientation applied, and
     * a GIF turned into the PNG the provider will actually receive.
     */
    readonly bytes: Buffer;
    /** The type to store the bytes under, which a GIF changes. */
    readonly mediaType: string;
    readonly archive?: ArchiveUploadSummary;
};

const isImageFormat = (format: ChatAttachmentFormat) => format.category === "image";

/**
 * Turns a legacy parser's outcome into the shared validation vocabulary.
 *
 * Encryption gets its own code because it is the one failure with an answer:
 * the person can remove the password and try again, where "invalid or
 * unsupported" would send them looking for a different file.
 */
export const legacyOfficeValidationCode = (
    error: unknown
): ChatAttachmentValidationCode => {
    if (!(error instanceof LegacyOfficeError)) return "ATTACHMENT_UNREADABLE";
    switch (error.code) {
        case "LEGACY_OFFICE_ENCRYPTED":
            return "ATTACHMENT_ENCRYPTED";
        case "LEGACY_OFFICE_NO_TEXT":
            return "ATTACHMENT_NO_TEXT";
        case "LEGACY_OFFICE_TOO_LARGE":
            return "ATTACHMENT_TEXT_TOO_LARGE";
        case "LEGACY_OFFICE_TIMEOUT":
            return "ATTACHMENT_UNREADABLE";
        default:
            return "ATTACHMENT_TYPE_MISMATCH";
    }
};

/**
 * Validates one uploaded file.
 *
 * `maxExtractedCharacters` opts into the guest behaviour: extract the text
 * here and refuse a document longer than the caller can send. Omitted, the
 * file is only proven readable and the text budget is left to the turn.
 */
export async function validateChatAttachmentUpload({
    buffer,
    format,
    scope,
    maxExtractedCharacters,
}: {
    buffer: Buffer;
    format: ChatAttachmentFormat;
    scope: ChatArchiveScope;
    maxExtractedCharacters?: number;
}): Promise<ChatAttachmentValidationResult> {
    if (buffer.byteLength === 0) {
        throw new ChatAttachmentValidationError("ATTACHMENT_TYPE_MISMATCH");
    }

    if (isImageFormat(format)) {
        const mediaType = format.mediaType as NormalizableImageMediaType;
        try {
            const normalized = await normalizeImageSafely(
                buffer,
                mediaType,
                Math.max(buffer.byteLength, 1) * 4
            );
            return {
                bytes: normalized,
                mediaType: normalizedImageMediaType(mediaType),
            };
        } catch (error) {
            if (error instanceof AnimatedImageError) {
                throw new ChatAttachmentValidationError("ATTACHMENT_ANIMATED_IMAGE");
            }
            throw new ChatAttachmentValidationError("INVALID_IMAGE_ATTACHMENT");
        }
    }

    if (format.category === "pdf") {
        if (maxExtractedCharacters === undefined) {
            try {
                await validatePdfSafely(buffer);
            } catch {
                throw new ChatAttachmentValidationError("INVALID_PDF_ATTACHMENT");
            }
            return { bytes: buffer, mediaType: format.mediaType };
        }

        let extracted = "";
        try {
            extracted = await extractPdfTextSafely(buffer, maxExtractedCharacters + 1);
        } catch {
            try {
                await validatePdfSafely(buffer);
            } catch {
                throw new ChatAttachmentValidationError("INVALID_PDF_ATTACHMENT");
            }
            throw new ChatAttachmentValidationError("ATTACHMENT_NO_TEXT");
        }
        if (!extracted) throw new ChatAttachmentValidationError("ATTACHMENT_NO_TEXT");
        if (extracted.length > maxExtractedCharacters) {
            throw new ChatAttachmentValidationError("ATTACHMENT_TEXT_TOO_LARGE", 413);
        }
        return { bytes: buffer, mediaType: format.mediaType };
    }

    if (format.category === "office") {
        if (maxExtractedCharacters === undefined) {
            try {
                assertSafeOfficeArchive(buffer, format.mediaType);
            } catch {
                throw new ChatAttachmentValidationError("ATTACHMENT_TYPE_MISMATCH");
            }
            return { bytes: buffer, mediaType: format.mediaType };
        }

        let extracted = "";
        try {
            extracted = await parseOfficeSafely(
                buffer,
                format.mediaType,
                maxExtractedCharacters + 1
            );
        } catch {
            throw new ChatAttachmentValidationError("ATTACHMENT_UNREADABLE");
        }
        if (!extracted) throw new ChatAttachmentValidationError("ATTACHMENT_NO_TEXT");
        if (extracted.length > maxExtractedCharacters) {
            throw new ChatAttachmentValidationError("ATTACHMENT_TEXT_TOO_LARGE", 413);
        }
        return { bytes: buffer, mediaType: format.mediaType };
    }

    if (format.category === "legacy-office") {
        // Unlike the OOXML path there is no cheap structural check that is
        // meaningfully weaker than the parse: opening the compound file, the
        // piece table or the record stream *is* the validation, and it is the
        // same work the turn will do. So the text is extracted here whatever
        // the caller asked for, and only the ceiling differs.
        let extracted: string;
        try {
            extracted = extractLegacyOfficeText(
                new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
                format.id as LegacyOfficeFormatId,
                maxExtractedCharacters === undefined
                    ? {}
                    : { maxCharacters: maxExtractedCharacters + 1 }
            ).text;
        } catch (error) {
            const code = legacyOfficeValidationCode(error);
            throw new ChatAttachmentValidationError(
                code,
                code === "ATTACHMENT_TEXT_TOO_LARGE" ? 413 : 400
            );
        }
        if (
            maxExtractedCharacters !== undefined &&
            extracted.length > maxExtractedCharacters
        ) {
            throw new ChatAttachmentValidationError("ATTACHMENT_TEXT_TOO_LARGE", 413);
        }
        return { bytes: buffer, mediaType: format.mediaType };
    }

    if (format.category === "archive") {
        // Directory only. Inflation costs CPU proportional to the archive and
        // happens once, on the turn that sends it -- but every structural
        // refusal (encryption, ZIP64, traversal, bombs, executables, keys, an
        // archive with nothing readable in it) is decidable from here, which
        // is what makes the upload answer honest.
        try {
            const plan = planChatArchive(
                new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
                chatArchiveLimits(scope)
            );
            return {
                bytes: buffer,
                mediaType: format.mediaType,
                archive: {
                    totalEntries: plan.totalEntries,
                    includedFiles: plan.entries.length,
                    excludedFiles: totalArchiveExclusions(plan.exclusions),
                },
            };
        } catch (error) {
            if (error instanceof ChatArchivePlanError) {
                throw new ChatArchiveError(error.code);
            }
            throw new ChatArchiveError(CHAT_ARCHIVE_ERROR_CODES.corrupt);
        }
    }

    const decoded = decodeAttachmentText(
        new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    );
    if (!decoded.ok) {
        throw new ChatAttachmentValidationError(
            decoded.reason === "binary"
                ? "ATTACHMENT_TYPE_MISMATCH"
                : "ATTACHMENT_ENCODING_UNREADABLE"
        );
    }
    if (
        maxExtractedCharacters !== undefined &&
        decoded.text.length > maxExtractedCharacters
    ) {
        throw new ChatAttachmentValidationError("ATTACHMENT_TEXT_TOO_LARGE", 413);
    }
    // A UTF-16 or BOM-prefixed file is re-encoded on the way in, so every
    // later reader -- this turn's and every turn after it -- gets plain UTF-8
    // and nobody has to remember which files were not.
    return {
        bytes: Buffer.from(decoded.text, "utf8"),
        mediaType: format.mediaType,
    };
}

/** Re-exported so a caller needs one import to catch every upload refusal. */
export { ChatArchiveError, providerMediaTypeForFormat };
