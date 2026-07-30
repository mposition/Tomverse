export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assertGuestAttachmentType,
  assertGuestTextPayload,
  createGuestAttachmentKey,
  createGuestAttachmentObjectId,
  getGuestAttachmentSecret,
  getGuestAttachmentTtlMinutes,
  guestFileExtension,
  GuestAttachmentError,
  GUEST_IMAGE_TYPES,
  GUEST_MAX_ATTACHMENT_BYTES,
  GUEST_MAX_EXTRACTED_CHARACTERS,
  GUEST_OFFICE_TYPES,
  GUEST_TEXT_TYPES,
  isOwnGuestAttachmentKey,
  sanitizeGuestFilename,
} from "@/lib/guestAttachments";
import { chatErrorResponse, identifyChatCaller } from "@/lib/chatSecurity";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
  reserveDailyUploadBytes,
} from "@/lib/apiSecurity";
import { getOperationalFeatureFlags } from "@/lib/appSettings";
import { extractPdfTextSafely, normalizeImageSafely, validatePdfSafely } from "@/lib/mediaSecurity";
import { parseOfficeSafely } from "@/lib/officeSecurity";
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
 * can read it, using the same parsers the signed-in path uses -- the
 * worker-isolated, timeout-bounded ones, not a second lenient copy.
 *
 * Returns the bytes to store: normalised for images (re-encoded, metadata
 * stripped by `sharp`), unchanged otherwise. The extracted text is measured,
 * never returned and never logged: it exists here only to prove the file is
 * parseable and to enforce the guest input ceiling before the user has typed a
 * question.
 */
const validateGuestFile = async (buffer: Buffer, mediaType: string) => {
  if (GUEST_IMAGE_TYPES.has(mediaType)) {
    try {
      return await normalizeImageSafely(
        buffer,
        mediaType as "image/png" | "image/jpeg" | "image/webp",
        GUEST_MAX_ATTACHMENT_BYTES
      );
    } catch {
      throw new GuestAttachmentError(
        400,
        "GUEST_ATTACHMENT_UNREADABLE",
        "The image is invalid or unsupported."
      );
    }
  }

  if (mediaType === "application/pdf") {
    let extracted = "";
    try {
      extracted = await extractPdfTextSafely(
        buffer,
        GUEST_MAX_EXTRACTED_CHARACTERS + 1
      );
    } catch {
      // A PDF whose text cannot be extracted is not automatically broken --
      // it may be a scan. Prove it parses at all before deciding which error
      // the user sees.
      try {
        await validatePdfSafely(buffer);
      } catch {
        throw new GuestAttachmentError(
          400,
          "GUEST_ATTACHMENT_UNREADABLE",
          "The PDF is invalid or could not be processed."
        );
      }
      throw new GuestAttachmentError(
        400,
        "GUEST_ATTACHMENT_NO_TEXT",
        "The PDF has no readable text. Sign in to send scanned documents to a model that reads them directly."
      );
    }
    if (!extracted) {
      throw new GuestAttachmentError(
        400,
        "GUEST_ATTACHMENT_NO_TEXT",
        "The PDF has no readable text. Sign in to send scanned documents to a model that reads them directly."
      );
    }
    if (extracted.length > GUEST_MAX_EXTRACTED_CHARACTERS) {
      throw new GuestAttachmentError(
        413,
        "GUEST_ATTACHMENT_TEXT_TOO_LARGE",
        "The file's text is longer than a guest message can carry."
      );
    }
    return buffer;
  }

  if (GUEST_OFFICE_TYPES.has(mediaType)) {
    let extracted = "";
    try {
      extracted = await parseOfficeSafely(
        buffer,
        mediaType,
        GUEST_MAX_EXTRACTED_CHARACTERS + 1
      );
    } catch {
      throw new GuestAttachmentError(
        400,
        "GUEST_ATTACHMENT_UNREADABLE",
        "The document is invalid or could not be processed."
      );
    }
    if (!extracted) {
      throw new GuestAttachmentError(
        400,
        "GUEST_ATTACHMENT_NO_TEXT",
        "No readable text was found in the document."
      );
    }
    if (extracted.length > GUEST_MAX_EXTRACTED_CHARACTERS) {
      throw new GuestAttachmentError(
        413,
        "GUEST_ATTACHMENT_TEXT_TOO_LARGE",
        "The file's text is longer than a guest message can carry."
      );
    }
    return buffer;
  }

  // Text-ish types have no signature of their own, so they get an explicit
  // one: a renamed binary must not be decoded straight into a prompt.
  const text = assertGuestTextPayload(buffer);
  if (text.length > GUEST_MAX_EXTRACTED_CHARACTERS) {
    throw new GuestAttachmentError(
      413,
      "GUEST_ATTACHMENT_TEXT_TOO_LARGE",
      "The file's text is longer than a guest message can carry."
    );
  }
  return buffer;
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
    assertGuestAttachmentType(name, mediaType);

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

    const payload = await validateGuestFile(buffer, mediaType);

    const secret = getGuestAttachmentSecret();
    const key = createGuestAttachmentKey(
      access.subjectKey,
      secret,
      createGuestAttachmentObjectId(randomUUID())
    );
    await writeR2Object(key, payload, mediaType);
    storedKey = key;
    await validateR2ObjectMetadata(key, {
      maxBytes: GUEST_MAX_ATTACHMENT_BYTES,
      expectedContentType: mediaType,
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
        mediaType,
        size: payload.byteLength,
        kind: GUEST_TEXT_TYPES.has(mediaType) ? "text" : "file",
        extension: guestFileExtension(name),
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
