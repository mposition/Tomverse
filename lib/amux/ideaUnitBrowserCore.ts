import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { AmuxDigestKey } from "./ideaCrypto.ts";

const ID = /^[A-Za-z0-9_-]{8,80}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const AUTH_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function amuxV4UnitBrowserCookieName(decisionId: string): string {
  if (!ID.test(decisionId)) throw new Error("Invalid unit decision ID");
  return `amux-v4-unit-${decisionId}`;
}

export const newAmuxV4UnitBrowserNonce = () => randomBytes(32).toString("base64url");

export function readAmuxV4UnitBrowserNonce(cookieHeader: string | null,
  decisionId: string): string | null {
  const name = amuxV4UnitBrowserCookieName(decisionId);
  if (!cookieHeader) return null;
  const values = cookieHeader.split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 && NONCE.test(values[0]) &&
    Buffer.from(values[0], "base64url").length === 32 ? values[0] : null;
}

/** The stored receipt sees only a domain-separated keyed digest, not the
 * browser nonce or a reusable session token. Re-login invalidates it. */
export function amuxV4UnitBrowserDigest(input: {
  decisionId: string; actorUserId: string; authenticatedAt: string | undefined;
  nonce: string; key: AmuxDigestKey;
}): { digest: string; keyId: string } {
  amuxV4UnitBrowserCookieName(input.decisionId);
  if (!ID.test(input.actorUserId) || !NONCE.test(input.nonce) ||
      Buffer.from(input.nonce, "base64url").length !== 32 ||
      !input.authenticatedAt || !AUTH_TIME.test(input.authenticatedAt) ||
      new Date(input.authenticatedAt).toISOString() !== input.authenticatedAt ||
      !input.key.digestKeyId || !Buffer.isBuffer(input.key.digestKey) ||
      input.key.digestKey.length !== 32) {
    throw new Error("AMUX unit browser binding unavailable");
  }
  return { digest: createHmac("sha256", input.key.digestKey)
    .update("amux-v4-unit-browser-v1\0")
    .update(input.decisionId).update("\0")
    .update(input.actorUserId).update("\0")
    .update(input.authenticatedAt).update("\0")
    .update(input.nonce).digest("hex"), keyId: input.key.digestKeyId };
}

export function matchesAmuxV4UnitBrowserDigest(expected: string, input: Parameters<
  typeof amuxV4UnitBrowserDigest>[0]): boolean {
  if (!DIGEST.test(expected)) return false;
  let actual: string;
  try { actual = amuxV4UnitBrowserDigest(input).digest; } catch { return false; }
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
