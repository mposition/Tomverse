import "server-only";

import { createHash, createHmac } from "node:crypto";

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
 */
export const GUEST_ATTACHMENT_TYPES: Record<string, readonly string[]> = {
  "text/plain": ["txt", "text", "log"],
  "text/markdown": ["md", "markdown"],
  "text/csv": ["csv"],
  "application/json": ["json"],
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
  "application/vnd.oasis.opendocument.text": ["odt"],
  "application/vnd.oasis.opendocument.spreadsheet": ["ods"],
  "application/vnd.oasis.opendocument.presentation": ["odp"],
};

export const GUEST_OFFICE_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);

export const GUEST_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export const GUEST_TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

/**
 * Extensions refused outright, whatever media type is claimed. Archives are
 * refused because a guest upload is not a container to unpack, and executables
 * because nothing here should ever look like something to run. The Office
 * formats above are technically ZIP containers, which is exactly why they go
 * through `assertSafeOfficeArchive`'s bomb/traversal checks instead of this
 * list.
 */
const REFUSED_EXTENSIONS = new Set([
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "lz", "lzma", "cab", "iso", "dmg",
  "exe", "dll", "so", "dylib", "bin", "com", "scr", "msi", "apk", "jar", "app",
  "sh", "bash", "zsh", "bat", "cmd", "ps1", "vbs", "js", "mjs", "cjs", "wasm",
  "deb", "rpm", "pkg", "run", "elf",
]);

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
 * Checks the declared media type against the allowlist and against the
 * filename's own extension. A mismatch is refused rather than resolved in
 * either direction: trusting the extension would let a caller rename their way
 * into a parser, and trusting the media type would let them hide the file's
 * real shape from the user.
 */
export const assertGuestAttachmentType = (
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
  const allowedExtensions = GUEST_ATTACHMENT_TYPES[mediaType];
  if (!allowedExtensions) {
    throw new GuestAttachmentError(
      400,
      "GUEST_ATTACHMENT_UNSUPPORTED_TYPE",
      "This file type cannot be attached."
    );
  }
  if (!extension || !allowedExtensions.includes(extension)) {
    throw new GuestAttachmentError(
      400,
      "GUEST_ATTACHMENT_TYPE_MISMATCH",
      "The file extension does not match its file type."
    );
  }
};

/**
 * Text files get a signature check of their own: the binary formats above are
 * verified by their parsers (PDF header, image signature, Office archive), but
 * "text/plain" has no signature, so a renamed binary would otherwise be
 * base64'd straight into a prompt.
 */
const BINARY_SIGNATURES: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04], // ZIP / OOXML
  [0x50, 0x4b, 0x05, 0x06],
  [0x1f, 0x8b], // gzip
  [0x52, 0x61, 0x72, 0x21], // RAR
  [0x37, 0x7a, 0xbc, 0xaf], // 7z
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // PE / DOS
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat / Java class
  [0x25, 0x50, 0x44, 0x46], // PDF
  [0x89, 0x50, 0x4e, 0x47], // PNG
];

export const assertGuestTextPayload = (buffer: Buffer) => {
  for (const signature of BINARY_SIGNATURES) {
    if (
      buffer.length >= signature.length &&
      signature.every((byte, index) => buffer[index] === byte)
    ) {
      throw new GuestAttachmentError(
        400,
        "GUEST_ATTACHMENT_TYPE_MISMATCH",
        "The file contents do not match its file type."
      );
    }
  }
  if (buffer.includes(0x00)) {
    throw new GuestAttachmentError(
      400,
      "GUEST_ATTACHMENT_TYPE_MISMATCH",
      "The file contents do not match its file type."
    );
  }
  const text = buffer.toString("utf8");
  // Buffer.toString replaces every invalid sequence with U+FFFD, so a file
  // that was not UTF-8 to begin with comes back visibly damaged. Written as an
  // escape rather than the literal glyph so the repository's encoding check
  // does not read this guard as its own bug.
  if (text.includes("\uFFFD")) {
    throw new GuestAttachmentError(
      400,
      "GUEST_ATTACHMENT_UNREADABLE",
      "The file could not be read as text."
    );
  }
  return text;
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
