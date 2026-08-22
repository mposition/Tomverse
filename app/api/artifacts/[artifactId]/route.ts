import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
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
  ARTIFACT_LIMITS,
  artifactContentDisposition,
  isSupportedArtifactFormat,
} from "@/lib/generatedArtifactCore";
import { prisma } from "@/lib/prisma";
import { readOwnR2ObjectBytes } from "@/lib/r2";

/**
 * Downloading a file an assistant answer produced.
 *
 * Policy: docs/policy/generated-artifacts.md section 5.
 *
 * The id in the URL is the only thing a client ever holds. It addresses a
 * `MessageArtifact` row; the object key lives on that row and is never sent
 * anywhere, so a URL the model invented, a key a user guessed, and a link
 * copied out of somebody else's session are all equally useless here.
 *
 * ## Why every refusal is a 404
 *
 * There are four ways this can fail to serve a file -- the row does not
 * exist, it belongs to someone else, its conversation was deleted, or the
 * generation failed -- and three of them would tell an attacker something if
 * they were distinguishable. `findFirst` scopes the read by `userId`, so the
 * handler cannot tell "not yours" from "not there" even internally: there is
 * no branch to leak because there is no branch.
 *
 * The lock is the one deliberate exception. A locked conversation answers
 * `CONVERSATION_LOCKED`, exactly as its own export and message routes do,
 * because the owner is the person being refused and hiding the reason from
 * them would only lose them the unlock prompt. Ownership is established
 * before the lock is consulted, so the distinguishable answer is only ever
 * shown to the owner.
 */
export async function GET(
  req: Request,
  context: RouteContext<"/api/artifacts/[artifactId]">
) {
  try {
    const session = await getServerSession(authOptions);
    const userId = (session?.user as { id?: string } | undefined)?.id;
    if (!userId) {
      return NextResponse.json({ error: "Login required" }, { status: 401 });
    }

    await consumeApiRateLimit(req, userId, "artifact-download", {
      minute: 30,
      day: 500,
    });

    const { artifactId } = await context.params;
    if (!artifactId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const artifact = await prisma.messageArtifact.findFirst({
      // Ownership is part of the lookup, not a check after it.
      where: { id: artifactId, userId },
      select: {
        id: true,
        conversationId: true,
        format: true,
        filename: true,
        mediaType: true,
        byteSize: true,
        status: true,
        objectKey: true,
        conversation: { select: { password: true, userId: true } },
      },
    });

    if (
      !artifact ||
      artifact.status !== "ready" ||
      !artifact.objectKey ||
      !isSupportedArtifactFormat(artifact.format) ||
      // Belt and braces: the row's own `userId` already scoped the query, and
      // the conversation's owner is checked too so that a row whose
      // conversation was reassigned could never be served on the strength of
      // the denormalised column alone.
      artifact.conversation?.userId !== userId
    ) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (
      !hasConversationUnlockGrant(
        req,
        userId,
        artifact.conversationId,
        artifact.conversation.password
      )
    ) {
      return conversationLockedResponse();
    }

    // Read through the non-destructive path. `readR2Object` deletes an object
    // whose metadata does not match what the caller claimed -- right for an
    // untrusted upload, catastrophic for a file this application generated and
    // the user cannot regenerate without paying for the answer again.
    const bytes = await readOwnR2ObjectBytes(artifact.objectKey, {
      maxBytes: ARTIFACT_LIMITS.maxOutputBytes,
    });

    return new Response(new Uint8Array(bytes), {
      headers: {
        // The row's media type, not the object's and not the request's: the
        // row is the record this application wrote, and `nosniff` below makes
        // it binding on the browser.
        "Content-Type": artifact.mediaType,
        "Content-Length": String(bytes.byteLength),
        // Two fields, because one cannot do both jobs: a quoted `filename` is
        // literal and ASCII-only, so a Korean name has to travel in RFC 5987's
        // `filename*`. See lib/generatedArtifactCore.ts.
        "Content-Disposition": artifactContentDisposition(
          artifact.filename,
          artifact.format
        ),
        // Private and unstored: the file is one account's data, and a shared
        // cache that kept it would serve it to the next person through the
        // same proxy.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    if (error instanceof BoundedBufferError) {
      // The object is larger than anything this route may have written, so
      // the row and the object disagree. Reported as a failed download rather
      // than streamed: the ceiling exists to be enforced here too.
      console.error("Generated artifact exceeded its size ceiling:", error);
      return NextResponse.json(
        { error: "This file is no longer available." },
        { status: 404 }
      );
    }
    console.error("Artifact download failed:", error);
    return NextResponse.json(
      { error: "Failed to download the file." },
      { status: 500 }
    );
  }
}
