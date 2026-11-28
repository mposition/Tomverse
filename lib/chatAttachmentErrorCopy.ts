/**
 * Server refusal code -> the copy key that explains it.
 *
 * The signed-in upload path used to throw away everything the server said.
 * `uploadOneFile` checked `response.ok`, threw a bare `Error`, and the catch
 * showed `chat.attachmentUploadError` -- "Couldn't upload the file. Please try
 * again." -- for every cause there is. A file too large, a corrupt PDF, an
 * admin-disabled feature and a rate limit all produced the same sentence, and
 * "try again" was wrong advice for three of the four. The guest path already
 * had a switch like this one; it just was not shared.
 *
 * So the mapping lives here, both paths use it, and adding a refusal code
 * without adding its sentence is a missing key rather than a silent fallback
 * to "try again". Pure: a code in, a translation key out. The client resolves
 * the key, so every locale gets the same coverage.
 */

/**
 * The refusal for a signed-in user's stored file whose object storage no
 * longer holds.
 *
 * Named as a constant because three places have to agree on the string -- the
 * chat route that raises it, the copy table below, and the client that decides
 * whether to offer "attach again" or "continue without it" -- and a literal
 * repeated three times is a literal that will one day be two.
 */
export const ATTACHMENT_UNAVAILABLE_CODE = "ATTACHMENT_UNAVAILABLE";

/** Storage could not be read. Distinct from the above: this one is transient. */
export const ATTACHMENT_STORAGE_UNAVAILABLE_CODE = "ATTACHMENT_STORAGE_UNAVAILABLE";

/** Keys under the `chat.` namespace in `locales/*.ts`. */
export const CHAT_ATTACHMENT_ERROR_COPY_KEYS: Readonly<Record<string, string>> = {
    // -- Shape and content --------------------------------------------------
    ATTACHMENT_TYPE_MISMATCH: "chat.attachmentTypeMismatch",
    GUEST_ATTACHMENT_TYPE_MISMATCH: "chat.attachmentTypeMismatch",
    ATTACHMENT_ENCODING_UNREADABLE: "chat.attachmentEncodingUnreadable",
    ATTACHMENT_ANIMATED_IMAGE: "chat.attachmentAnimatedImage",
    INVALID_IMAGE_ATTACHMENT: "chat.attachmentImageInvalid",
    INVALID_PDF_ATTACHMENT: "chat.attachmentPdfInvalid",
    ATTACHMENT_NO_TEXT: "chat.attachmentNoText",
    ATTACHMENT_ENCRYPTED: "chat.attachmentEncrypted",
    GUEST_ATTACHMENT_NO_TEXT: "chat.guestAttachmentUnreadable",
    ATTACHMENT_UNREADABLE: "chat.attachmentUnreadable",
    GUEST_ATTACHMENT_UNREADABLE: "chat.guestAttachmentUnreadable",
    ATTACHMENT_TEXT_TOO_LARGE: "chat.attachmentTextTooLarge",
    GUEST_ATTACHMENT_TEXT_TOO_LARGE: "chat.guestAttachmentTextTooLarge",
    ATTACHMENT_MODEL_IMAGE_UNSUPPORTED: "chat.attachmentModelImageUnsupported",
    // The file on the message being sent cannot be read by the chosen model
    // (an image for a model without image input). Earlier messages' files never
    // raise it: they are named to the model as not included instead.
    ATTACHMENT_MODEL_UNSUPPORTED: "chat.attachmentModelUnsupported",
    // Scanned PDF, OCR service down, and a model that cannot read the PDF itself.
    PDF_OCR_UNAVAILABLE: "chat.attachmentOcrUnavailable",
    // A photo an image edit refuses before it reserves anything (lib/imageEditSource.ts).
    IMAGE_EDIT_SOURCE_TOO_LARGE: "chat.imageEditSourceTooLarge",
    IMAGE_EDIT_SOURCE_UNSUPPORTED: "chat.imageEditSourceUnsupported",

    // -- Type and size ------------------------------------------------------
    UNSUPPORTED_ATTACHMENT_TYPE: "chat.attachmentTypeError",
    GUEST_ATTACHMENT_UNSUPPORTED_TYPE: "chat.guestAttachmentUnsupported",
    ATTACHMENT_TOO_LARGE: "chat.attachmentSizeError",

    // -- Recordings (docs/policy/chat-attachment-formats.md 2.4) ------------
    ATTACHMENT_AUDIO_TOO_LONG: "chat.attachmentAudioTooLong",
    AUDIO_TRANSCRIPTION_UNAVAILABLE: "chat.audioTranscriptionUnavailable",
    AUDIO_TRANSCRIPTION_LIMIT_REACHED: "chat.audioTranscriptionLimitReached",

    // -- Archives -----------------------------------------------------------
    ARCHIVE_CORRUPT: "chat.archiveCorrupt",
    ARCHIVE_ENCRYPTED: "chat.archiveEncrypted",
    ARCHIVE_ZIP64_UNSUPPORTED: "chat.archiveZip64",
    ARCHIVE_TOO_MANY_ENTRIES: "chat.archiveTooManyEntries",
    ARCHIVE_ENTRY_TOO_LARGE: "chat.archiveEntryTooLarge",
    ARCHIVE_EXPANSION_TOO_LARGE: "chat.archiveExpansionTooLarge",
    ARCHIVE_COMPRESSION_RATIO: "chat.archiveCompressionRatio",
    ARCHIVE_UNSAFE_PATH: "chat.archiveUnsafePath",
    ARCHIVE_EXECUTABLE_ENTRY: "chat.archiveExecutableEntry",
    ARCHIVE_CREDENTIAL_ENTRY: "chat.archiveCredentialEntry",
    ARCHIVE_UNSUPPORTED_COMPRESSION: "chat.archiveUnsupportedCompression",
    ARCHIVE_SIZE_MISMATCH: "chat.archiveSizeMismatch",
    ARCHIVE_NO_SUPPORTED_FILES: "chat.archiveNoSupportedFiles",
    ARCHIVE_PROCESSING_TIMEOUT: "chat.archiveTimeout",

    // -- Availability -------------------------------------------------------
    // A stored file whose bytes are gone. Not "try again": re-reading the same
    // object gets the same 404, and the only way forward is a new copy of the
    // file or an explicit decision to continue without it.
    ATTACHMENT_UNAVAILABLE: "chat.attachmentUnavailable",
    // Storage did not answer. The opposite advice, and the reason the two
    // cannot share a code: this one *is* worth retrying.
    ATTACHMENT_STORAGE_UNAVAILABLE: "chat.attachmentStorageUnavailable",
    GUEST_ATTACHMENT_EXPIRED: "chat.guestAttachmentExpired",

    // -- Operational --------------------------------------------------------
    ATTACHMENTS_DISABLED_BY_ADMIN: "chat.guestAttachmentUnavailable",
    API_RATE_LIMITED: "chat.compareRateLimited",
};

/**
 * The send-time refusals `components/chat/ChatApp.tsx` answers from this table
 * instead of showing the server's English sentence.
 *
 * Deliberately a short list, not the whole table: the rest are raised by the
 * upload step, which has its own surface. A code is added here when the chat
 * route can answer it on a send and the panel had no sentence for it.
 */
export const CHAT_SEND_LOCALIZED_ATTACHMENT_CODES: ReadonlySet<string> = new Set([
    "ATTACHMENT_UNREADABLE",
    "ATTACHMENT_MODEL_UNSUPPORTED",
    "PDF_OCR_UNAVAILABLE",
]);

/**
 * The copy key for a refusal, or `null` when the code is one this client has
 * no specific sentence for -- the caller then falls back to its own generic
 * message rather than showing a code.
 */
export const chatAttachmentErrorCopyKey = (code?: string | null) =>
    (code && CHAT_ATTACHMENT_ERROR_COPY_KEYS[code]) || null;
