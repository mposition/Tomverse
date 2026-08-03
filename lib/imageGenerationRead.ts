import "server-only";

import { createR2ReadUrl } from "@/lib/r2";

// Shared read shape for image generation status responses. The by-id polling
// route and the per-conversation history route must serve byte-identical
// objects so the workspace can merge them into one client state. Asset access
// is always short-TTL signed URLs behind the ownership check -- raw R2 keys
// never leave the server, and the URLs must never be persisted client-side
// (they expire in IMAGE_ASSET_URL_TTL_SECONDS).

export const IMAGE_ASSET_URL_TTL_SECONDS = 300;

export const IMAGE_GENERATION_READ_SELECT = {
  id: true,
  userId: true,
  conversationId: true,
  status: true,
  publicErrorCode: true,
  prompt: true,
  preset: true,
  size: true,
  quality: true,
  createdAt: true,
  completedAt: true,
  failedAt: true,
  assets: {
    where: { status: "ready", deletedAt: null },
    select: { role: true, r2Key: true, mimeType: true },
  },
} as const;

export type ImageGenerationReadRow = {
  id: string;
  userId: string;
  conversationId: string;
  status: string;
  publicErrorCode: string | null;
  prompt: string;
  preset: string;
  size: string;
  quality: string;
  createdAt: Date;
  completedAt: Date | null;
  failedAt: Date | null;
  assets: Array<{ role: string; r2Key: string; mimeType: string }>;
};

export type ImageGenerationReservationRow = {
  reservedCredits: number;
  refundedAt: Date | null;
} | null;

export async function serializeImageGeneration(
  generation: ImageGenerationReadRow,
  reservation: ImageGenerationReservationRow
) {
  // Assets are only minted for a succeeded generation: a failed original
  // upload must not leak a partially-written object.
  const assets =
    generation.status === "succeeded"
      ? await Promise.all(
          generation.assets.map(async (asset) => ({
            role: asset.role,
            mimeType: asset.mimeType,
            url: await createR2ReadUrl(asset.r2Key, IMAGE_ASSET_URL_TTL_SECONDS),
          }))
        )
      : [];

  return {
    generationId: generation.id,
    conversationId: generation.conversationId,
    status: generation.status,
    prompt: generation.prompt,
    preset: generation.preset,
    size: generation.size,
    quality: generation.quality,
    reservedCredits: reservation?.reservedCredits ?? null,
    refunded: Boolean(reservation?.refundedAt),
    publicErrorCode: generation.publicErrorCode,
    createdAt: generation.createdAt.toISOString(),
    completedAt: generation.completedAt?.toISOString() ?? null,
    failedAt: generation.failedAt?.toISOString() ?? null,
    assets,
  };
}
