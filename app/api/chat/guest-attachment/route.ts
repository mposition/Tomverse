export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createGuestAttachmentKey,
  createGuestAttachmentObjectId,
  getGuestAttachmentSecret,
  getGuestAttachmentTtlMinutes,
  guestFileExtension,
  GuestAttachmentError,
  GUEST_MAX_ATTACHMENT_BYTES,
  GUEST_MAX_EXTRACTED_CHARACTERS,
  isOwnGuestAttachmentKey,
  resolveGuestAttachmentFormat,
  sanitizeGuestFilename,
} from "@/lib/guestAttachments";
import {
  attachmentKindForFormat,
  type ChatAttachmentFormat,
} from "@/lib/chatAttachmentFormats";
import { ChatArchiveError } from "@/lib/chatArchive";
import {
  ChatAttachmentValidationError,
  validateChatAttachmentUpload,
} from "@/lib/chatAttachmentValidation";
import { chatErrorResponse, identifyChatCaller } from "@/lib/chatSecurity";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
  reserveDailyUploadBytes,
} from "@/lib/apiSecurity";
import { getOperationalFeatureFlags } from "@/lib/appSettings";
import { deleteR2Object, validateR2ObjectMetadata, writeR2Object } from "@/lib/r2";
import { ensureGuestVerified } from "@/lib/turnstile";

/**
 * Ephemeral file uploads for guests.
 *
 * The signed-in attachment flow (PUT prepare → direct-to-R2 → PATCH finalize)
 * is built on an account: the object key is derived from the user's e-mail,
 * the daily byte budget is a user's, and the finished object is a durable
 * asset that can be re-read on every later turn of a saved conversation. None
 * of that exists for a guest, and manufacturing it -- a placeholder user, a
 * nullable owner -- would turn a temporary trial into permanent unowned data.
 *
 * So guests get a different shape, not a loosened version of the same one: one
 * request that carries the bytes, is validated and *parsed* server-side before
 * anything is stored, and writes to a key derived from the caller's own signed
 * guest identity. The object is deleted when the composer drops it, and swept
 * by `cleanupExpiredData` once its TTL passes. It is never attached to a
 * Conversation, a Project, a share link or an export.
 *
 * Nothing about the file's *contents* -- not the bytes, not the extracted text
 * -- is ever logged. Errors carry a code and a sentence, never a parser
 * message.
 */

const GUEST_UPLOAD_BYTES_PER_DAY = 25 * 1024 * 1024;

const uploadQuerySchema = z.object({
  name: z.string().trim().min(1).max(200),
  mediaType: z.string().trim().min(3).max(120),
});

const deleteSchema = z.object({ key: z.string().min(1).max(512) }).strict();

const jsonError = (error: string, code: string, status: number) =>
  Response.json(
    { error, code },
    { status, headers: { "Cache-Control": "no-store" } }
  );

/**
 * Reads the request body with a hard ceiling, refusing an oversized upload
 * both by its declared length and by what actually arrives -- a
 * `Content-Length` is a claim, not a fact.
 */
const readBoundedBody = async (request: Request, maxBytes: number) => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new GuestAttachmentError(
      413,
      "GUEST_ATTACHMENT_TOO_LARGE",
      "The file is too large."
    );
  }
  if (!request.body) {
    throw new GuestAttachmentError(
      400,
      "GUEST_ATTACHMENT_EMPTY",
      "The file is empty."
    );
  }
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GuestAttachmentError(
          413,
          "GUEST_ATTACHMENT_TOO_LARGE",
          "The file is too large."
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new GuestAttachmentError(
      400,
      "GUEST_ATTACHMENT_EMPTY",
      "The file is empty."
    );
  }
  return Buffer.concat(chunks, total);
};

/**
 * Proves the file is genuinely what it claims to be *and* that this product
 * can read it, using the shared upload validator -- the same worker-isolated,
 * timeout-bounded parsers the signed-in finalize step now runs, not a second
 * lenient copy.
 *
 * Returns the bytes to store: normalised for images (re-encoded, metadata
 * stripped by `sharp`, a GIF turned into the PNG a provider will accept),
 * re-encoded to UTF-8 for text, unchanged otherwise. The extracted text is
 * measured, never returned and never logged: it exists here only to prove the
 * file is parseable and to enforce the guest input ceiling before the user has
 * typed a question.
 *
 * Guest refusal codes are preserved. The shared validator speaks in
 * account-shaped codes, and the composer already has copy for the guest ones,
 * so they are translated here rather than in the module every caller shares.
 */
const GUEST_VALIDATION_CODES: Record<string, { code: string; message: string }> = {
  ATTACHMENT_TYPE_MISMATCH: {
    code: "GUEST_ATTACHMENT_TYPE_MISMATCH",
    message: "The file contents do not match its file type.",
  },
  ATTACHMENT_ENCODING_UNREADABLE: {
    code: "GUEST_ATTACHMENT_UNREADABLE",
    message: "The file could not be read as text.",
  },
  ATTACHMENT_ANIMATED_IMAGE: {
    code: "ATTACHMENT_ANIMATED_IMAGE",
    message: "Animated images are not supported. Attach a still image instead.",
  },
  INVALID_IMAGE_ATTACHMENT: {
    code: "GUEST_ATTACHMENT_UNREADABLE",
    message: "The image is invalid or unsupported.",
  },
  INVALID_PDF_ATTACHMENT: {
    code: "GUEST_ATTACHMENT_UNREADABLE",
    message: "The PDF is invalid or could not be processed.",
  },
  ATTACHMENT_NO_TEXT: {
    code: "GUEST_ATTACHMENT_NO_TEXT",
    message:
      "No readable text was found. Sign in to send scanned documents to a model that reads them directly.",
  },
  ATTACHMENT_UNREADABLE: {
    code: "GUEST_ATTACHMENT_UNREADABLE",
    message: "The document is invalid or could not be processed.",
  },
  ATTACHMENT_TEXT_TOO_LARGE: {
    code: "GUEST_ATTACHMENT_TEXT_TOO_LARGE",
    message: "The file's text is longer than a guest message can carry.",
  },
};

const validateGuestFile = async (
  buffer: Buffer,
  format: ChatAttachmentFormat
) => {
  try {
    return await validateChatAttachmentUpload({
      buffer,
      format,
      scope: "guest",
      maxExtractedCharacters: GUEST_MAX_EXTRACTED_CHARACTERS,
    });
  } catch (error) {
    if (error instanceof ChatAttachmentValidationError) {
      const mapped = GUEST_VALIDATION_CODES[error.code];
      throw new GuestAttachmentError(
        error.status,
        mapped?.code || "GUEST_ATTACHMENT_UNREADABLE",
        mapped?.message || "The file could not be processed."
      );
    }
    throw error;
  }
};

export async function POST(request: Request) {
  let storedKey: string | null = null;
  try {
    const access = identifyChatCaller(request);
    if (access.kind !== "guest") {
      return jsonError(
        "This endpoint is for guest sessions only.",
        "GUEST_ONLY_ENDPOINT",
        400
      );
    }
    if (!(await getOperationalFeatureFlags()).attachmentsEnabled) {
      return jsonError(
        "Attachments are temporarily disabled for operational maintenance.",
        "ATTACHMENTS_DISABLED_BY_ADMIN",
        503
      );
    }

    await consumeApiRateLimit(
      request,
      access.subjectKey,
      "guest-attachment-upload",
      { minute: 3, day: 12 }
    );

    const url = new URL(request.url);
    const query = uploadQuerySchema.safeParse({
      name: url.searchParams.get("name") || "",
      mediaType: url.searchParams.get("mediaType") || "",
    });
    if (!query.success) {
      return jsonError(
        "This file type cannot be attached.",
        "GUEST_ATTACHMENT_UNSUPPORTED_TYPE",
        400
      );
    }
    const mediaType = query.data.mediaType.split(";", 1)[0].trim().toLowerCase();
    const name = sanitizeGuestFilename(query.data.name);
    const format = resolveGuestAttachmentFormat(name, mediaType);

    // The declared body type must agree with the declared media type too, so a
    // caller cannot slip past a proxy or a parser by disagreeing with itself.
    const contentType = (request.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType && contentType !== mediaType) {
      return jsonError(
        "The file extension does not match its file type.",
        "GUEST_ATTACHMENT_TYPE_MISMATCH",
        400
      );
    }

    const turnstileGrantCookie = await ensureGuestVerified(
      request,
      url.searchParams.get("turnstileToken") || undefined,
      "guest_attachment"
    );

    const buffer = await readBoundedBody(request, GUEST_MAX_ATTACHMENT_BYTES);
    await reserveDailyUploadBytes(
      access.subjectKey,
      buffer.byteLength,
      GUEST_UPLOAD_BYTES_PER_DAY
    );

    const validated = await validateGuestFile(buffer, format);
    const payload = validated.bytes;
    // An image may leave this call as a different type than it arrived as --
    // a GIF is stored as the PNG the provider will be sent -- so the stored
    // object, its metadata check and the response all use the validated type
    // rather than the declared one.
    const storedMediaType = validated.mediaType;

    const secret = getGuestAttachmentSecret();
    const key = createGuestAttachmentKey(
      access.subjectKey,
      secret,
      createGuestAttachmentObjectId(randomUUID())
    );
    await writeR2Object(key, payload, storedMediaType);
    storedKey = key;
    await validateR2ObjectMetadata(key, {
      maxBytes: GUEST_MAX_ATTACHMENT_BYTES,
      expectedContentType: storedMediaType,
      expectedSize: payload.byteLength,
    });
    storedKey = null;

    const headers = new Headers({ "Cache-Control": "no-store" });
    if (access.setCookie) headers.append("Set-Cookie", access.setCookie);
    if (turnstileGrantCookie) headers.append("Set-Cookie", turnstileGrantCookie);

    return Response.json(
      {
        objectKey: key,
        name,
        mediaType: storedMediaType,
        size: payload.byteLength,
        kind: attachmentKindForFormat(format),
        extension: guestFileExtension(name),
        // Counts, never paths: an entry name is text the uploader chose, and
        // an upload response is not a place to echo it back.
        ...(validated.archive ? { archive: validated.archive } : {}),
        ephemeral: true,
        expiresInMinutes: getGuestAttachmentTtlMinutes(),
      },
      { headers }
    );
  } catch (error) {
    // A file that was written and then failed its own metadata check must not
    // be left behind for the sweep to find an hour later.
    if (storedKey) {
      await deleteR2Object(storedKey).catch((cleanupError) =>
        console.error("Guest attachment cleanup after failure failed:", {
          key: storedKey,
          cleanupError,
        })
      );
    }
    if (error instanceof GuestAttachmentError) {
      return jsonError(error.message, error.code, error.status);
    }
    if (error instanceof ChatArchiveError) {
      return jsonError("The archive could not be read.", error.code, error.status);
    }
    const chatResponse = chatErrorResponse(error);
    if (chatResponse) return chatResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Guest attachment upload failed.", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return jsonError(
      "The file could not be processed.",
      "GUEST_ATTACHMENT_FAILED",
      500
    );
  }
}

/**
 * Drops a guest object early -- when the composer removes the file, or the
 * send it was picked for never happens. Best-effort by design: the TTL sweep
 * is the guarantee, this is the courtesy that keeps storage near-empty in the
 * common case.
 */
export async function DELETE(request: Request) {
  try {
    const access = identifyChatCaller(request);
    if (access.kind !== "guest") {
      return jsonError(
        "This endpoint is for guest sessions only.",
        "GUEST_ONLY_ENDPOINT",
        400
      );
    }
    await consumeApiRateLimit(
      request,
      access.subjectKey,
      "guest-attachment-delete",
      { minute: 10, day: 60 }
    );
    const { key } = await readLimitedJson(request, 4 * 1024, deleteSchema);
    // The prefix is derived from the caller's own signed identity, so a guest
    // can only ever delete their own objects -- guessing another guest's key
    // is as hard as forging their cookie.
    if (!isOwnGuestAttachmentKey(key, access.subjectKey, getGuestAttachmentSecret())) {
      return jsonError("Forbidden", "GUEST_ATTACHMENT_FORBIDDEN", 403);
    }
    await deleteR2Object(key);
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof GuestAttachmentError) {
      return jsonError(error.message, error.code, error.status);
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Guest attachment delete failed.", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return jsonError(
      "The file could not be removed.",
      "GUEST_ATTACHMENT_DELETE_FAILED",
      500
    );
  }
}
