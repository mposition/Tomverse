export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  clearImageGenerationSignal,
  recordImageGenerationSignal,
} from "@/lib/imageGenerationSignals";
import {
  IMAGE_GENERATION_CANCELLABLE_SIGNAL_KINDS,
  IMAGE_GENERATION_USER_SIGNAL_KINDS,
} from "@/lib/imageGenerationSignalsCore";

// POST   /api/images/generations/[generationId]/signal  { kind }
// DELETE /api/images/generations/[generationId]/signal?kind=helpful
//
// What a person did with one generated image: chose it in a comparison, found
// it helpful or not, or wanted a text answer instead. `download` is recorded
// by the download route and is not accepted here. DELETE takes back a
// thumbs-up, a thumbs-down or "wanted text" -- the toggles the card shows.
//
// A generation that is not the caller's is a 404, the same answer as one that
// does not exist.

const postSchema = z.object({ kind: z.enum(IMAGE_GENERATION_USER_SIGNAL_KINDS) }).strict();
const deleteSchema = z.enum(IMAGE_GENERATION_CANCELLABLE_SIGNAL_KINDS);

type Params = { params: Promise<{ generationId: string }> };

const noStore = { "Cache-Control": "no-store" };

const notFound = () =>
  NextResponse.json(
    { error: "Image not found.", code: "IMAGE_GENERATION_NOT_FOUND" },
    { status: 404, headers: noStore }
  );

async function authenticate(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;
  const userId = session.user.id;
  // Its own bucket: a few presses per image, never a polling path.
  await consumeApiRateLimit(req, userId, "image-generation-signal", {
    minute: 30,
    day: 1_000,
  });
  return userId;
}

const unauthenticated = () =>
  NextResponse.json({ error: "Authentication required." }, { status: 401, headers: noStore });

export async function POST(req: Request, { params }: Params) {
  try {
    const userId = await authenticate(req);
    if (!userId) return unauthenticated();
    const body = await readLimitedJson(req, 1024, postSchema);
    const { generationId } = await params;
    if (!generationId) return notFound();
    const result = await recordImageGenerationSignal({ userId, generationId, kind: body.kind });
    if (!result.ok) return notFound();
    return new Response(null, { status: 204, headers: noStore });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Image generation signal failed:", error);
    return NextResponse.json(
      { error: "Failed to record the signal." },
      { status: 500, headers: noStore }
    );
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const userId = await authenticate(req);
    if (!userId) return unauthenticated();
    const kind = deleteSchema.safeParse(new URL(req.url).searchParams.get("kind"));
    if (!kind.success) {
      return NextResponse.json(
        { error: "Invalid request payload.", code: "INVALID_REQUEST" },
        { status: 400, headers: noStore }
      );
    }
    const { generationId } = await params;
    if (!generationId) return notFound();
    const result = await clearImageGenerationSignal({ userId, generationId, kind: kind.data });
    if (!result.ok) return notFound();
    return new Response(null, { status: 204, headers: noStore });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Image generation signal removal failed:", error);
    return NextResponse.json(
      { error: "Failed to remove the signal." },
      { status: 500, headers: noStore }
    );
  }
}
