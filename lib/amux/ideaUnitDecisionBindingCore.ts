import { createHmac, timingSafeEqual } from "node:crypto";

import { amuxAnalysisTextSafe } from "./ideaAnalysisChunkCore.ts";
import type { AmuxDigestKey } from "./ideaCrypto.ts";

/** Keyed, body-free bindings for one owner decision. Neither the JWT session
 * nor a freeform reason is stored in the seven-year decision ledger. A later
 * writer must still check owner role, recent step-up, current DB source and
 * the consumed decision in its own transaction. */
const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST = /^[a-f0-9]{64}$/;

const validKey = (key: AmuxDigestKey): boolean =>
  Boolean(key && KEY_ID.test(key.digestKeyId) && Buffer.isBuffer(key.digestKey) &&
    key.digestKey.length === 32);

const keyed = (domain: string, parts: readonly string[], key: AmuxDigestKey) =>
  createHmac("sha256", key.digestKey).update(domain, "utf8")
    .update("\0", "utf8").update(key.digestKeyId, "ascii")
    .update("\0", "utf8").update(parts.join("\0"), "utf8").digest("hex");

export type AmuxUnitDecisionBinding = { digest: string; keyId: string };

/** The JWT-derived authentication timestamp changes on a real sign-in.
 * A merely matching user ID is not enough to consume another session's
 * prepared decision. Route-level recent-step-up is a separate requirement. */
export function bindAmuxOwnerSession(input: {
  actorUserId: string; authenticatedAt: string;
}, key: AmuxDigestKey): AmuxUnitDecisionBinding | null {
  if (!validKey(key) || !input || !ID.test(input.actorUserId) ||
      typeof input.authenticatedAt !== "string" || !ISO.test(input.authenticatedAt) ||
      !Number.isFinite(Date.parse(input.authenticatedAt)) ||
      new Date(input.authenticatedAt).toISOString() !== input.authenticatedAt) return null;
  return { digest: keyed("amux-v4-owner-session-v1",
    [input.actorUserId, input.authenticatedAt], key), keyId: key.digestKeyId };
}

/** Bind the reason to exactly one decision and one draft unit. The raw text
 * must remain in the current request only; audit and prepare metadata retain
 * just this keyed commitment. */
export function bindAmuxUnitDecisionReason(input: {
  ideaId: string; draftUnitId: string; decisionId: string; reason: string;
}, key: AmuxDigestKey): AmuxUnitDecisionBinding | null {
  if (!validKey(key) || !input || !ID.test(input.ideaId) ||
      !ID.test(input.draftUnitId) || !ID.test(input.decisionId) ||
      typeof input.reason !== "string" || input.reason.length === 0 ||
      input.reason !== input.reason.trim() || input.reason !== input.reason.normalize("NFC") ||
      Buffer.byteLength(input.reason, "utf8") > 1_000 ||
      !amuxAnalysisTextSafe(input.reason)) return null;
  return { digest: keyed("amux-v4-unit-reason-v1",
    [input.ideaId, input.draftUnitId, input.decisionId, input.reason], key),
    keyId: key.digestKeyId };
}

export function sameAmuxUnitDecisionBinding(
  left: AmuxUnitDecisionBinding | null, right: AmuxUnitDecisionBinding | null,
): boolean {
  return Boolean(left && right && left.keyId === right.keyId &&
    DIGEST.test(left.digest) && DIGEST.test(right.digest) &&
    timingSafeEqual(Buffer.from(left.digest, "hex"), Buffer.from(right.digest, "hex")));
}
