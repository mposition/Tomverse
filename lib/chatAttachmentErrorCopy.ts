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

    // -- Type and size ------------------------------------------------------
    UNSUPPORTED_ATTACHMENT_TYPE: "chat.attachmentTypeError",
    GUEST_ATTACHMENT_UNSUPPORTED_TYPE: "chat.guestAttachmentUnsupported",
    ATTACHMENT_TOO_LARGE: "chat.attachmentSizeError",

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

    // -- Operational --------------------------------------------------------
    ATTACHMENTS_DISABLED_BY_ADMIN: "chat.guestAttachmentUnavailable",
    API_RATE_LIMITED: "chat.compareRateLimited",
};

/**
 * The copy key for a refusal, or `null` when the code is one this client has
 * no specific sentence for -- the caller then falls back to its own generic
 * message rather than showing a code.
 */
export const chatAttachmentErrorCopyKey = (code?: string | null) =>
    (code && CHAT_ATTACHMENT_ERROR_COPY_KEYS[code]) || null;
