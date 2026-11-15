import "server-only";

import { typicalImageSeconds } from "@/lib/chatImageIntentCore";
import { prisma } from "@/lib/prisma";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RUNS = 2_000;
const TTL_MS = 10 * 60 * 1000;

let cached: { at: number; seconds: Record<string, number> } | null = null;

/**
 * How long each image model's recent generations here took (median seconds,
 * last 30 days), for the image router's speed comparison. A profile's
 * latencyClass is a guess made when the model was added -- every runtime model
 * starts as "balanced" -- while these are what users actually waited.
 *
 * Never throws and never blocks routing on a database problem: without a
 * reading the router falls back to the profile's band. Cached for ten minutes
 * so a chat send does not pay a query for a number that moves slowly.
 */
export async function readImageModelTypicalSeconds(now = Date.now()): Promise<Record<string, number>> {
    if (cached && now - cached.at < TTL_MS) return cached.seconds;
    try {
        const runs = await prisma.imageGeneration.findMany({
            where: {
                status: "succeeded",
                createdAt: { gte: new Date(now - WINDOW_MS) },
                startedAt: { not: null },
                completedAt: { not: null },
            },
            select: { modelId: true, startedAt: true, completedAt: true },
            orderBy: { createdAt: "desc" },
            take: MAX_RUNS,
        });
        cached = { at: now, seconds: typicalImageSeconds(runs) };
        return cached.seconds;
    } catch {
        return cached?.seconds ?? {};
    }
}
