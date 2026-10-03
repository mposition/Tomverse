import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** A retention tick is a separate capability from source collection. */
export const AMUX_V4_COLLECTION_RESULT_PURGE_CODE_LATCH = false;
export const AMUX_V4_COLLECTION_RESULT_PURGE_ENV =
  "TOMVERSE_AMUX_V4_COLLECTION_RESULT_PURGE";
export const AMUX_V4_COLLECTION_RESULT_PURGE_SECRET_ENV =
  "TOMVERSE_AMUX_V4_COLLECTION_RESULT_PURGE_SECRET";
export const AMUX_V4_COLLECTION_RESULT_PURGE_AGENT_ID = "amux-v4-intake-retention";
export const AMUX_V4_COLLECTION_RESULT_PURGE_BATCH_SIZE = 8;

export const collectionResultPurgeEnabled = (value: string | undefined) =>
  AMUX_V4_COLLECTION_RESULT_PURGE_CODE_LATCH && value === "enabled";

export const collectionResultPurgeRequestSchema = z.object({
  schemaVersion: z.literal(1),
}).strict();

const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

export function isCollectionResultPurgeAuthorized(request: Request,
  configured: string | undefined, otherSecrets: readonly (string | undefined)[]): boolean {
  if (typeof configured !== "string" || !SECRET.test(configured) ||
      otherSecrets.includes(configured) ||
      request.headers.get("x-amux-agent-id") !==
        AMUX_V4_COLLECTION_RESULT_PURGE_AGENT_ID) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const provided = authorization.slice(7);
  if (!SECRET.test(provided)) return false;
  return timingSafeEqual(createHash("sha256").update(configured).digest(),
    createHash("sha256").update(provided).digest());
}
