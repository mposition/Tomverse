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

import {
  CHAT_ATTACHMENT_FORMATS,
  chatAttachmentAcceptAttribute,
} from "@/lib/chatAttachmentFormats";

/** One file per message for guests. */
export const GUEST_MAX_ATTACHMENTS_PER_MESSAGE = 1;

/** Half the signed-in per-file ceiling. Never above it. */
export const GUEST_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * The media types a guest may attach.
 *
 * Derived from `guestAllowed` in `lib/chatAttachmentFormats.ts` rather than
 * written out again: this list existed as its own literal, and keeping it in
 * step with the signed-in list was manual work that nothing checked. A guest
 * subset is a *property of a format*, so it belongs on the format.
 */
export const GUEST_ACCEPTED_MEDIA_TYPES: readonly string[] =
  CHAT_ATTACHMENT_FORMATS.filter((format) => format.guestAllowed).map(
    (format) => format.mediaType
  );

export const GUEST_ACCEPTED_FILE_TYPES = chatAttachmentAcceptAttribute({
  guest: true,
});

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
