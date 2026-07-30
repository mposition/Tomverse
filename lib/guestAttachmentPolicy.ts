/**
 * The parts of the guest attachment policy the browser also needs.
 *
 * `lib/guestAttachments.ts` is `server-only` -- it holds the keying, the
 * signature checks and the storage scope, none of which belong in a bundle --
 * but the composer still has to know how many files a guest may pick, how big
 * they may be and which types to offer, and those numbers must be the same
 * ones the server enforces. They are defined here once and imported by both,
 * so the client can *pre-empt* a rejection but never define it: every limit
 * below is re-checked server-side.
 */

/** One file per message for guests. */
export const GUEST_MAX_ATTACHMENTS_PER_MESSAGE = 1;

/** Half the signed-in per-file ceiling. Never above it. */
export const GUEST_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * The media types a guest may attach -- a subset of the signed-in allowlist,
 * limited to what the existing security pipeline can validate and parse end to
 * end. Archives, executables and anything without a parser are absent by
 * construction rather than by a deny-list.
 */
export const GUEST_ACCEPTED_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
] as const;

export const GUEST_ACCEPTED_FILE_TYPES = GUEST_ACCEPTED_MEDIA_TYPES.join(",");

/**
 * What happens to an attached file after the turn that used it.
 *
 * `account` files live with the conversation and can be re-read on any later
 * turn. `ephemeral` files are held for a short TTL, scoped to the guest
 * session that uploaded them, and are never added to a project, a saved
 * conversation, a share link or an export -- which is a promise the UI has to
 * make out loud, so it is modelled rather than assumed.
 */
export type AttachmentPersistence = "account" | "ephemeral" | "none";

/**
 * What this caller may do in the composer's attachment controls. Replaces the
 * old `canAttach={!isGuestMode}`, which collapsed four independent questions
 * -- may I attach at all, how many, from where, and what happens afterwards --
 * into one boolean, and answered all four with "no" for guests.
 */
export type ChatAttachmentCapabilities = {
  canAttachLocalFiles: boolean;
  canConnectGoogleDrive: boolean;
  maxAttachmentsPerMessage: number;
  maxAttachmentBytes: number;
  attachmentPersistence: AttachmentPersistence;
};
