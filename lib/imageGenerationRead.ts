import "server-only";

import {
  deriveImageComposerRestore,
  type ImageComposerRestore,
} from "@/lib/imageComposerRestore";
import {
  currentImageAttempt,
  deriveImageGroupStatus,
  type ImageGenerationStatus,
} from "@/lib/imageGenerationStateCore";
import { prisma } from "@/lib/prisma";
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
  provider: true,
  modelId: true,
  outputWidth: true,
  outputHeight: true,
  groupId: true,
  targetId: true,
  attemptNumber: true,
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
  provider: string;
  modelId: string;
  outputWidth: number | null;
  outputHeight: number | null;
  groupId: string;
  targetId: string;
  attemptNumber: number;
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
    // v2: which model produced this attempt and which comparison slot it
    // belongs to, so the workspace can group attempts without a second read.
    provider: generation.provider,
    modelId: generation.modelId,
    // What the bytes actually are, not what was asked for. Null when the
    // header could not be read (policy §12.1).
    outputWidth: generation.outputWidth,
    outputHeight: generation.outputHeight,
    groupId: generation.groupId,
    targetId: generation.targetId,
    attemptNumber: generation.attemptNumber,
    reservedCredits: reservation?.reservedCredits ?? null,
    refunded: Boolean(reservation?.refundedAt),
    publicErrorCode: generation.publicErrorCode,
    createdAt: generation.createdAt.toISOString(),
    completedAt: generation.completedAt?.toISOString() ?? null,
    failedAt: generation.failedAt?.toISOString() ?? null,
    assets,
  };
}

// ---------------------------------------------------------------------------
// Group reads (policy §11).
//
// One comparison group is one poll. The workspace used to ask for each active
// generation separately, which made the read cost of watching a comparison
// scale with the number of models being compared -- the feature's whole point.
// At a 5s cadence a five-model group spent its own 60/minute status budget
// exactly, and a group stuck until the 12-minute stale sweep spent thousands
// of the daily allowance; the client treats a rejected poll as "no update", so
// the symptom would have been a workspace that quietly stopped refreshing.

export const IMAGE_GROUP_READ_SELECT = {
  id: true,
  userId: true,
  conversationId: true,
  createdAt: true,
  targets: {
    select: {
      id: true,
      provider: true,
      modelId: true,
      currentGenerationId: true,
      generations: {
        orderBy: { attemptNumber: "asc" },
        select: IMAGE_GENERATION_READ_SELECT,
      },
    },
  },
} as const;

export type ImageGroupReadRow = {
  id: string;
  userId: string;
  conversationId: string;
  createdAt: Date;
  targets: Array<{
    id: string;
    provider: string;
    modelId: string;
    currentGenerationId: string | null;
    generations: ImageGenerationReadRow[];
  }>;
};

export async function serializeImageGroup(
  group: ImageGroupReadRow,
  reservationByGeneration: Map<string, ImageGenerationReservationRow>
) {
  const attempts = group.targets.flatMap((target) => target.generations);

  // The CURRENT attempt of each target, and only that one: a target whose
  // failure has already been retried must not drag the group backwards. The
  // rule is in imageGenerationStateCore so this route and any future caller
  // cannot each pick differently.
  const currentAttempts = group.targets.map((target) =>
    currentImageAttempt(target)
  );

  return {
    groupId: group.id,
    conversationId: group.conversationId,
    createdAt: group.createdAt.toISOString(),
    status: deriveImageGroupStatus(
      currentAttempts
        .filter((attempt): attempt is ImageGenerationReadRow => attempt !== null)
        .map((attempt) => attempt.status as ImageGenerationStatus)
    ),
    targets: group.targets.map((target, index) => ({
      targetId: target.id,
      provider: target.provider,
      modelId: target.modelId,
      currentGenerationId: currentAttempts[index]?.id ?? null,
      attemptCount: target.generations.length,
    })),
    // Every attempt, current and superseded. Past attempts are the audit trail
    // the policy keeps; they are all failures, because a succeeded target
    // cannot be re-run, so this adds no signed-URL work to a poll.
    generations: await Promise.all(
      attempts.map((generation) =>
        serializeImageGeneration(
          generation,
          reservationByGeneration.get(generation.id) ?? null
        )
      )
    ),
  };
}

// ---------------------------------------------------------------------------
// Composer restore (policy §11, UI contract "Composer state lifecycle").

export const IMAGE_COMPOSER_RESTORE_SELECT = {
  id: true,
  targets: {
    select: {
      id: true,
      modelId: true,
      currentGenerationId: true,
      generations: {
        orderBy: { attemptNumber: "asc" },
        select: {
          id: true,
          attemptNumber: true,
          preset: true,
          quality: true,
          size: true,
        },
      },
    },
  },
} as const;

export type ImageComposerRestoreRow = {
  id: string;
  targets: Array<{
    id: string;
    modelId: string;
    currentGenerationId: string | null;
    generations: Array<{
      id: string;
      attemptNumber: number;
      preset: string;
      quality: string;
      size: string;
    }>;
  }>;
};

/**
 * The composer's starting state for an image conversation, read from its most
 * recent comparison group.
 *
 * Ordered by the GROUP's createdAt, with the id as a tiebreak so two groups
 * created in the same millisecond still order deterministically. Never by a
 * generation's timestamp: retrying an older group's failed target writes the
 * newest ImageGeneration row in the conversation, and reading that would drag
 * the composer back to a comparison the user has moved past.
 */
export async function readImageComposerRestore(
  conversationId: string
): Promise<ImageComposerRestore | null> {
  const group = await prisma.imageGenerationGroup.findFirst({
    where: { conversationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: IMAGE_COMPOSER_RESTORE_SELECT,
  });
  if (!group || group.targets.length === 0) return null;
  return deriveImageComposerRestore({
    groupId: group.id,
    targets: group.targets,
  });
}
