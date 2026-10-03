import { createHash, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";

/** A polling hint for the credential-isolated source collector, not a claim. */
export const AMUX_V4_COLLECTION_QUEUE_CODE_LATCH = false;
export const AMUX_V4_COLLECTION_QUEUE_READ_ENV = "TOMVERSE_AMUX_V4_COLLECTION_QUEUE_READ";
export const AMUX_V4_COLLECTION_AGENT_SECRET_ENV = "TOMVERSE_AMUX_V4_COLLECTION_AGENT_SECRET";
export const AMUX_V4_COLLECTION_AGENT_ID = "amux-v4-source-collector";

export const collectionQueueReadEnabled = (value: string | undefined): boolean =>
  AMUX_V4_COLLECTION_QUEUE_CODE_LATCH && value === "enabled";

const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Neither the board sync nor the analysis Agent credential may poll sources. */
export function isCollectionAgentAuthorized(request: Request,
  configured: string | undefined, syncSecret?: string,
  analysisSecret?: string): boolean {
  if (typeof configured !== "string" || !SECRET.test(configured) ||
      configured === syncSecret || configured === analysisSecret ||
      request.headers.get("x-amux-agent-id") !== AMUX_V4_COLLECTION_AGENT_ID) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const provided = authorization.slice(7);
  if (!SECRET.test(provided)) return false;
  return timingSafeEqual(createHash("sha256").update(configured).digest(),
    createHash("sha256").update(provided).digest());
}

export type AmuxV4CollectionQueueCursor = { createdAt: Date; collectionRequestId: string };

export function parseCollectionQueueCursor(raw: unknown): AmuxV4CollectionQueueCursor | null {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2 ||
        typeof decoded[0] !== "string" || !UTC_ISO.test(decoded[0]) ||
        typeof decoded[1] !== "string" || !UUID.test(decoded[1])) return null;
    const createdAt = new Date(decoded[0]);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== decoded[0] ||
        encodeCollectionQueueCursor({ createdAt, collectionRequestId: decoded[1] }) !== raw) return null;
    return { createdAt, collectionRequestId: decoded[1] };
  } catch { return null; }
}

export function encodeCollectionQueueCursor(value: AmuxV4CollectionQueueCursor): string {
  if (!(value.createdAt instanceof Date) ||
      !Number.isFinite(value.createdAt.getTime()) || !UUID.test(value.collectionRequestId)) {
    throw new TypeError("invalid AMUX collection queue cursor");
  }
  return Buffer.from(JSON.stringify([value.createdAt.toISOString(), value.collectionRequestId]), "utf8")
    .toString("base64url");
}

/** This selects only candidate IDs. The eventual claim must lock and verify
 * scope, model, owner audit and digest again before reading any source. */
export function buildCollectionCandidateWhere(now: Date,
  cursor: AmuxV4CollectionQueueCursor | null): Prisma.AmuxIdeaCollectionRequestWhereInput {
  return {
    state: "pending", leaseId: null, leaseExpiresAt: null,
    expiresAt: { gt: now }, resultCiphertext: null, resultDigest: null,
    idea: { state: "submitted", analysisDeadlineAt: { gt: now },
      rawPurgedAt: null, rawCiphertext: { not: null } },
    sourceScopeApproval: { is: { status: "approved", approvedAt: { lte: now },
      expiresAt: { gt: now }, consumedAt: null, revokedAt: null,
      scopePurgedAt: null, scopeCiphertext: { not: null } } },
    frontierApproval: { is: { status: "approved", approvedAt: { lte: now },
      revokedAt: null } },
    ...(cursor ? { OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.collectionRequestId } },
    ] } : {}),
  };
}
