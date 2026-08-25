export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { BoundedBufferError } from "@/lib/boundedBuffer";
import {
  imageDownloadContentDisposition,
  imageDownloadFilename,
} from "@/lib/imageAssetDownload";
import { IMAGE_ORIGINAL_MAX_READ_BYTES } from "@/lib/imageGenerationStateCore";
import { prisma } from "@/lib/prisma";
import { readOwnR2ObjectBytes } from "@/lib/r2";

// GET /api/images/generations/[generationId]/download -- saving a generated
// image as a file.
//
// ## Why this route exists at all, when a signed URL already serves the bytes
//
// The workspace holds a short-TTL signed R2 URL for every asset, and the
// download control used to be that URL behind an `<a download>`. Two things
// were wrong with it and only one of them looked like a bug.
//
// The visible one: `download` is same-origin-only. R2 is a different origin,
// so browsers ignored the attribute, followed the link, and rendered a
// perfectly correct `image/png` in a new tab. Nothing in the storage
// configuration was wrong -- the correct content type is exactly why the
// browser displayed it -- and no change to the stored metadata could have
// fixed it, because `Content-Type` describes what the bytes are and
// `Content-Disposition` decides what to do with them. Only the response can
// carry the second one, and only this application can decide it.
//
// The quiet one: those URLs expire in IMAGE_ASSET_URL_TTL_SECONDS. The `<img>`
// has an `onError` that re-mints, so a stale picture repairs itself; a link
// has no such thing, so a card left open for six minutes had a download
// control that navigated to an S3 error document. This route mints nothing the
// client has to keep, so a card is as downloadable an hour later as it was on
// arrival.
//
// The bytes are proxied rather than redirected because a redirect hands the
// outcome back to the browser -- including the failures, which would arrive as
// a navigation away from the workspace. Fetched here, a refusal stays a
// refusal on the page that asked (lib/browserDownload.ts).
//
// ## Why every refusal is a 404
//
// The lookup is scoped by `userId`, so "not yours" and "not there" are the
// same branch, as they are on the sibling status route. A generation that has
// not succeeded, or whose original was swept, is the same answer: there is no
// file here.

type Params = { params: Promise<{ generationId: string }> };

const notFound = () =>
  NextResponse.json(
    { error: "Image not found.", code: "IMAGE_GENERATION_NOT_FOUND" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );

export async function GET(req: Request, { params }: Params) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }
    const userId = session.user.id;
    // Its own bucket, not the status budget: a poll and a download are not the
    // same action and a comparison spends the first freely.
    await consumeApiRateLimit(req, userId, "image-asset-download", {
      minute: 30,
      day: 500,
    });

    const { generationId } = await params;
    if (!generationId) return notFound();

    const generation = await prisma.imageGeneration.findFirst({
      // Ownership is part of the lookup, not a check after it.
      where: { id: generationId, userId },
      select: {
        id: true,
        status: true,
        modelId: true,
        assets: {
          // The original only. The thumbnail is a display artefact this
          // application derived; nobody asked to download it.
          where: { role: "original", status: "ready", deletedAt: null },
          select: { r2Key: true, mimeType: true, byteSize: true },
        },
      },
    });

    const asset = generation?.assets[0];
    if (!generation || generation.status !== "succeeded" || !asset) {
      return notFound();
    }

    // The row's own size, checked before the read rather than during it: an
    // object larger than anything this application may have written means the
    // row and the object disagree, and that is worth refusing without first
    // pulling 32MB across the wire to discover it.
    if (
      !Number.isSafeInteger(asset.byteSize) ||
      asset.byteSize <= 0 ||
      asset.byteSize > IMAGE_ORIGINAL_MAX_READ_BYTES
    ) {
      console.error(
        "Image asset byte size is outside the storable range:",
        generation.id
      );
      return notFound();
    }

    // The non-destructive read. `readR2Object` deletes an object whose
    // metadata does not match the caller's claim -- right for an untrusted
    // upload, catastrophic for an image the user paid for and cannot get back
    // without paying again.
    const bytes = await readOwnR2ObjectBytes(asset.r2Key, {
      maxBytes: IMAGE_ORIGINAL_MAX_READ_BYTES,
    });

    const filename = imageDownloadFilename({
      generationId: generation.id,
      modelId: generation.modelId,
      mimeType: asset.mimeType,
    });

    return new Response(new Uint8Array(bytes), {
      headers: {
        // The row's recorded type, which is what the bytes were parsed as when
        // they were written. `nosniff` below makes it binding.
        "Content-Type": asset.mimeType,
        "Content-Length": String(bytes.byteLength),
        // The half that was missing. Named from the mime type, so a provider
        // that returned JPEG does not arrive as `original.png`.
        "Content-Disposition": imageDownloadContentDisposition(filename),
        // One account's image. A shared cache that kept it would serve it to
        // the next person through the same proxy.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    if (error instanceof BoundedBufferError) {
      console.error("Image asset exceeded its size ceiling:", error);
      return notFound();
    }
    console.error("Image asset download failed:", error);
    return NextResponse.json(
      { error: "Failed to download the image." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
