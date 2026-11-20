import "server-only";

import { mutuallyExclusiveSignalKind } from "@/lib/imageGenerationSignalsCore";
import type { ImageGenerationSignalKind } from "@/lib/imageRoutingCore";
import { prisma } from "@/lib/prisma";

// What a person did with one generated image (docs: the image routing
// improvement agent's measurement, prisma ImageGenerationSignal). One row per
// (user, generation, kind); the row says that it happened, not how often.
//
// Ownership is part of the write, not a check beside it: a generation that is
// not the caller's is answered exactly like one that does not exist, so a
// signal route cannot be used to learn which generation ids exist.

type SignalTables = {
  /** Locks the generation's group row for the rest of the transaction. */
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  imageGeneration: {
    findFirst(args: {
      where: { id: string; userId: string };
      select: { id: true; groupId: true };
    }): Promise<{ id: string; groupId: string } | null>;
  };
  imageGenerationSignal: {
    createMany(args: {
      data: { userId: string; generationId: string; kind: string }[];
      skipDuplicates: true;
    }): Promise<unknown>;
    deleteMany(args: {
      where: {
        userId: string;
        kind: string;
        generationId?: string | { not: string };
        generation?: { groupId: string };
      };
    }): Promise<unknown>;
  };
};

/** The database handle a signal write needs; the real client satisfies it. */
export type ImageSignalDb = SignalTables & {
  $transaction<T>(run: (tx: SignalTables) => Promise<T>): Promise<T>;
};

export type ImageGenerationSignalResult = { ok: true } | { ok: false; reason: "not_found" };

const defaultDb = (): ImageSignalDb => prisma as unknown as ImageSignalDb;

type SignalInput = { userId: string; generationId: string; kind: ImageGenerationSignalKind };

/**
 * Records one signal for the caller's own generation. Repeating it changes
 * nothing. `helpful` and `not_helpful` cannot both stand, so recording one
 * removes the other; choosing a result in a comparison (`selected`) moves the
 * caller's earlier choice in the same group to this one. Those removals are
 * the caller's own signal rows.
 */
export async function recordImageGenerationSignal(
  input: SignalInput,
  db: ImageSignalDb = defaultDb()
): Promise<ImageGenerationSignalResult> {
  return db.$transaction(async (tx) => {
    const generation = await tx.imageGeneration.findFirst({
      where: { id: input.generationId, userId: input.userId },
      select: { id: true, groupId: true },
    });
    if (!generation) return { ok: false, reason: "not_found" } as const;
    // One writer per group at a time: helpful/not_helpful on one image and the
    // one `selected` per comparison are read-then-write rules, which two
    // concurrent requests under READ COMMITTED would otherwise both pass.
    await tx.$queryRaw`SELECT 1 FROM "ImageGenerationGroup" WHERE "id" = ${generation.groupId} FOR UPDATE`;

    const rival = mutuallyExclusiveSignalKind(input.kind);
    if (rival) {
      await tx.imageGenerationSignal.deleteMany({
        where: { userId: input.userId, generationId: generation.id, kind: rival },
      });
    }
    if (input.kind === "selected") {
      await tx.imageGenerationSignal.deleteMany({
        where: {
          userId: input.userId,
          kind: "selected",
          generationId: { not: generation.id },
          generation: { groupId: generation.groupId },
        },
      });
    }
    // The unique (userId, generationId, kind) is the idempotence: a repeat, or
    // two presses racing, is skipped rather than failing.
    await tx.imageGenerationSignal.createMany({
      data: [{ userId: input.userId, generationId: generation.id, kind: input.kind }],
      skipDuplicates: true,
    });
    return { ok: true } as const;
  });
}

/** Takes back one of the caller's own signals. Taking back what is not there is a success. */
export async function clearImageGenerationSignal(
  input: SignalInput,
  db: ImageSignalDb = defaultDb()
): Promise<ImageGenerationSignalResult> {
  return db.$transaction(async (tx) => {
    const generation = await tx.imageGeneration.findFirst({
      where: { id: input.generationId, userId: input.userId },
      select: { id: true, groupId: true },
    });
    if (!generation) return { ok: false, reason: "not_found" } as const;
    await tx.imageGenerationSignal.deleteMany({
      where: { userId: input.userId, generationId: generation.id, kind: input.kind },
    });
    return { ok: true } as const;
  });
}
