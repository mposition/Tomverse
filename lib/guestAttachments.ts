import "server-only";

import { createHash, createHmac } from "node:crypto";

import {
  CHAT_ATTACHMENT_FORMATS,
  REFUSED_ATTACHMENT_EXTENSIONS,
  resolveChatAttachmentFormat,
} from "@/lib/chatAttachmentFormats";
import { decodeAttachmentText } from "@/lib/chatAttachmentText";

/**
 * Guest file attachments: policy, naming and storage scoping.
 *
 * A guest has no account, so there is no owner to hang a durable attachment
 * record on -- and inventing one (a placeholder user, a nullable owner column)
 * would turn a temporary upload into a permanent, unowned asset. Guest files
 * are therefore ephemeral: validated, parsed, held in object storage under a
 * key derived from the caller's own signed guest identity, and swept after a
 * short TTL. They are never written to a Conversation, a Project, a share link
 * or an export.
 *
 * Everything a guest may upload is a subset of what an account may upload,
 * with a stricter per-file ceiling and a hard one-file-per-message cap. This
 * module never widens an existing limit.
 */

// One file per message, and half the signed-in per-file ceiling. Both are
// defined in the shared policy module the composer also reads, so the number
// the UI enforces and the number the server enforces cannot drift; neither is
// configurable upward through the environment, because a guest upload path is
// the one place where a misconfiguration is unauthenticated.
export {
  GUEST_MAX_ATTACHMENTS_PER_MESSAGE,
  GUEST_MAX_ATTACHMENT_BYTES,
} from "@/lib/guestAttachmentPolicy";

/**
 * The extracted-text ceiling for one guest file. The real limit is the guest
 * chat input-token budget (`CHAT_GUEST_MAX_INPUT_TOKENS`, 16k by default);
 * this sits below it so an oversized document is refused at upload -- with a
 * message naming the file -- rather than at send, after the user has typed a
 * question.
 */
export const GUEST_MAX_EXTRACTED_CHARACTERS = 40_000;

/** How long an unused guest object may sit in storage before the sweep takes it. */
export const getGuestAttachmentTtlMinutes = () => {
  const parsed = Number(process.env.CHAT_GUEST_ATTACHMENT_TTL_MINUTES);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 24 * 60
    ? parsed
    : 60;
};

export const GUEST_ATTACHMENT_PREFIX = "guest-attachments/";

/**
 * The media types a guest may send, each with the extensions that are allowed
 * to carry it. Both directions are checked: an `.exe` renamed to `.pdf` fails
 * the signature check downstream, and a genuine PDF named `.zip` fails here.
 *
 * Derived from the shared format table rather than written out again -- this
 * map and the signed-in allowlist had to be edited together, and nothing said
 * so.
 */
export const GUEST_ATTACHMENT_TYPES: Record<string, readonly string[]> =
  Object.fromEntries(
    CHAT_ATTACHMENT_FORMATS.filter((format) => format.guestAllowed).map(
      (format) => [format.mediaType, format.extensions]
    )
  );

const guestMediaTypesForCategory = (category: string) =>
  new Set(
    CHAT_ATTACHMENT_FORMATS.filter(
      (format) => format.guestAllowed && format.category === category
    ).map((format) => format.mediaType)
  );

export const GUEST_OFFICE_TYPES = guestMediaTypesForCategory("office");

export const GUEST_IMAGE_TYPES = guestMediaTypesForCategory("image");

export const GUEST_TEXT_TYPES = guestMediaTypesForCategory("text");

export const GUEST_ARCHIVE_TYPES = guestMediaTypesForCategory("archive");

/**
 * Extensions refused outright, whatever media type is claimed.
 *
 * Now one list, in `lib/chatAttachmentFormats.ts`, shared with the signed-in
 * path: executables because nothing here should ever look like something to
 * run, and every archive format except ZIP because exactly one container
 * shape is supported and renaming is not how you add another. ZIP itself is
 * absent on purpose -- it is a supported format with its own expansion
 * contract (`lib/chatArchivePlan.ts`), not a hole in this list. The Office
 * formats are ZIP containers too, which is why they go through
 * `assertSafeOfficeArchive` rather than either list.
 */
const REFUSED_EXTENSIONS = REFUSED_ATTACHMENT_EXTENSIONS;

export class GuestAttachmentError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "GuestAttachmentError";
  }
}

/**
 * The keying secret. Reuses the application secret that already signs the
 * guest cookie itself, so a storage prefix is exactly as unguessable as the
 * identity it belongs to -- and so there is no second secret to rotate.
 */
export const getGuestAttachmentSecret = () => {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new GuestAttachmentError(
      503,
      "SECURITY_NOT_CONFIGURED",
      "Guest attachments are not configured."
    );
  }
  return secret;
};

/**
 * Normalises a client-supplied filename to something safe to *display*. It is
 * never used to build a storage key (see `createGuestAttachmentKey`), so path
 * traversal has nowhere to land, but a name still reaches the model prompt and
 * the UI.
 */
export const sanitizeGuestFilename = (filename: string) => {
  const withoutPath = filename
    .normalize("NFKC")
    // Anything a filesystem or URL could read as a separator, including the
    // encoded forms, becomes an ordinary character before the class filter.
    .replace(/%2e/gi, ".")
    .replace(/%2f/gi, "-")
    .replace(/%5c/gi, "-")
    .split(/[\\/]/)
    .pop() ?? "";
  const safe = withoutPath
    .replace(/\.{2,}/g, ".")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return safe || "attachment";
};

export const guestFileExtension = (filename: string) => {
  const safe = sanitizeGuestFilename(filename);
  const dot = safe.lastIndexOf(".");
  return dot > 0 ? safe.slice(dot + 1).toLowerCase() : "";
};

/**
 * Resolves what a guest is actually sending, or refuses it.
 *
 * The name leads and the declared media type is checked against it, so a
 * caller can neither rename their way into a parser nor hide a file's real
 * shape behind a type the picker never reported. Both refusals keep the codes
 * they had, because the composer already translates them.
 */
export const resolveGuestAttachmentFormat = (
  filename: string,
  mediaType: string
) => {
  const extension = guestFileExtension(filename);
  if (REFUSED_EXTENSIONS.has(extension)) {
    throw new GuestAttachmentError(
      400,
      "GUEST_ATTACHMENT_UNSUPPORTED_TYPE",
      "This file type cannot be attached."
    );
  }
  if (!GUEST_ATTACHMENT_TYPES[mediaType]) {
    throw new GuestAttachmentError(
      400,
      "GUEST_ATTACHMENT_UNSUPPORTED_TYPE",
      "This file type cannot be attached."
    );
  }
  const format = resolveChatAttachmentFormat({
    filename,
    declaredMediaType: mediaType,
  });
  if (!format || !format.guestAllowed || format.mediaType !== mediaType) {
    throw new GuestAttachmentError(
      400,
      "GUEST_ATTACHMENT_TYPE_MISMATCH",
      "The file extension does not match its file type."
    );
  }
  return format;
};

/** The refusal half of `resolveGuestAttachmentFormat`, kept for callers that only assert. */
export const assertGuestAttachmentType = (
  filename: string,
  mediaType: string
) => {
  resolveGuestAttachmentFormat(filename, mediaType);
};

/**
 * Text files get a check of their own: the binary formats above are verified
 * by their parsers (PDF header, image signature, Office archive), but
 * "text/plain" has no signature, so a renamed binary would otherwise be
 * base64'd straight into a prompt.
 *
 * The decision now lives in `lib/chatAttachmentText.ts` and is shared with
 * the signed-in path. Two behaviours changed with it, both deliberate: a
 * UTF-16 file with a byte order mark is converted rather than refused, and a
 * file that is not valid UTF-8 is refused *as* an encoding failure instead of
 * being decoded with U+FFFD scattered through it and then noticed by a
 * substring search for the replacement character.
 */
export const assertGuestTextPayload = (buffer: Buffer) => {
  const decoded = decodeAttachmentText(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  );
  if (!decoded.ok) {
    throw new GuestAttachmentError(
      400,
      decoded.reason === "binary"
        ? "GUEST_ATTACHMENT_TYPE_MISMATCH"
        : "GUEST_ATTACHMENT_UNREADABLE",
      decoded.reason === "binary"
        ? "The file contents do not match its file type."
        : "The file could not be read as text."
    );
  }
  return decoded.text;
};

/**
 * The storage scope for one guest identity.
 *
 * Derived from the *signed* guest subject key with a keyed hash, so it cannot
 * be recomputed, enumerated or guessed by anyone who does not already hold
 * that guest's cookie -- and so one guest's prefix can never be another's. The
 * original filename never appears in the key: names are attacker-controlled,
 * and a key is a path.
 */
export const guestAttachmentPrefix = (subjectKey: string, secret: string) =>
  `${GUEST_ATTACHMENT_PREFIX}${createHmac("sha256", secret)
    .update(`guest-attachment:${subjectKey}`)
    .digest("hex")
    .slice(0, 32)}/`;

export const createGuestAttachmentKey = (
  subjectKey: string,
  secret: string,
  objectId: string
) => `${guestAttachmentPrefix(subjectKey, secret)}${objectId}`;

/**
 * True only for keys inside this guest's own prefix. Also rejects any key
 * containing a traversal segment, so a crafted `objectKey` cannot walk out of
 * the guest area even if a future caller forgets to compare prefixes.
 */
export const isOwnGuestAttachmentKey = (
  key: string,
  subjectKey: string,
  secret: string
) => {
  if (key.includes("..") || key.includes("//") || key.startsWith("/")) {
    return false;
  }
  return key.startsWith(guestAttachmentPrefix(subjectKey, secret));
};

/** Object ids are opaque and unguessable; the name lives in the payload only. */
export const createGuestAttachmentObjectId = (uuid: string) =>
  createHash("sha256").update(uuid).digest("hex").slice(0, 40);
