import { NextResponse } from "next/server";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { BoundedBufferError } from "@/lib/boundedBuffer";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import {
  MAX_PREVIEW_ATTACHMENT_BYTES,
  isPreviewableAttachmentMediaType,
} from "@/lib/messageAttachmentPreview";
import { prisma } from "@/lib/prisma";
import { readOwnR2ObjectBytes } from "@/lib/r2";

/**
 * The thumbnail of an image the signed-in owner sent in a chat message.
 *
 * Policy: docs/policy/user-attachment-persistence.md section 5.1.
 *
 * The sending tab shows a local preview, but a reloaded conversation only has
 * the card's metadata, so every sent picture used to come back as a generic
 * icon. This route serves the owner's own image back to the owner, inline,
 * and nothing more:
 *
 * - Raster images only (PREVIEWABLE_ATTACHMENT_MEDIA_TYPES). A PDF, a document
 *   or an archive has no thumbnail and is a 404 here, so this is not a general
 *   download route for input files.
 * - Ownership is part of the lookup, exactly as for a generated file
 *   (app/api/artifacts/[artifactId]/route.ts): "not yours" and "not there" are
 *   the same 404 because there is no branch that separates them.
 * - A locked conversation answers CONVERSATION_LOCKED, to the owner only.
 * - The URL carries the opaque row id; the storage key never leaves the server
 *   and no signed URL is minted.
 */
export async function GET(
  req: Request,
  context: RouteContext<"/api/attachments/[attachmentId]/preview">
) {
  try {
    const authentication = await resolveChatRouteSession(req);
    if (authentication.response) return authentication.response;
    const session = authentication.session;
    const userId = (session?.user as { id?: string } | undefined)?.id;
    if (!userId) {
      return NextResponse.json({ error: "Login required" }, { status: 401 });
    }

    // A conversation can show many pictures at once, so the ceiling is higher
    // than a deliberate download's.
    await consumeApiRateLimit(req, userId, "attachment-preview", {
      minute: 120,
      day: 3000,
    });

    const { attachmentId } = await context.params;
    if (!attachmentId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const attachment = await prisma.messageAttachment.findFirst({
      // Ownership is part of the lookup, not a check after it.
      where: { id: attachmentId, userId },
      select: {
        conversationId: true,
        mediaType: true,
        size: true,
        objectKey: true,
        unavailableAt: true,
        conversation: {
          select: { password: true, passwordVersion: true, userId: true },
        },
      },
    });

    if (
      !attachment ||
      !attachment.objectKey ||
      attachment.unavailableAt ||
      !isPreviewableAttachmentMediaType(attachment.mediaType) ||
      // The denormalised `userId` already scoped the query; the conversation's
      // owner is checked too so a reassigned conversation is never served on
      // the strength of that column alone.
      attachment.conversation?.userId !== userId
    ) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (
      !hasConversationUnlockGrant(
        req,
        userId,
        attachment.conversationId,
        attachment.conversation.password == null
          ? null
          : attachment.conversation.passwordVersion
      )
    ) {
      return conversationLockedResponse();
    }

    // The non-destructive read. `readR2Object` deletes an object whose
    // metadata disagrees with the caller, which is right for an untrusted
    // upload and wrong for a file the user already sent.
    const bytes = await readOwnR2ObjectBytes(attachment.objectKey, {
      maxBytes: Math.max(
        1,
        Math.min(
          attachment.size > 0 ? attachment.size : MAX_PREVIEW_ATTACHMENT_BYTES,
          MAX_PREVIEW_ATTACHMENT_BYTES
        )
      ),
    });

    return new Response(new Uint8Array(bytes), {
      headers: {
        // The row's media type, made binding by `nosniff`.
        "Content-Type": attachment.mediaType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": "inline",
        // One account's data: never kept by a shared cache.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        // Opened directly, the response is a picture and nothing that can run.
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    if (error instanceof BoundedBufferError) {
      // The object is larger than the row says it stored. Not served.
      console.error("Attachment preview exceeded its size ceiling");
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // A missing object, a storage outage and a timeout all leave the card
    // with its icon. Availability is decided by the chat route, which alone
    // writes `unavailableAt` from a confirmed 404 (section 11); a thumbnail
    // request never does.
    console.error(
      JSON.stringify({
        event: "attachment_preview_failed",
        error: error instanceof Error ? error.name : "unknown",
      })
    );
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
