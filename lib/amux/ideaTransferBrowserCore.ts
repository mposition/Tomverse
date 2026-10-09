import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { isAmuxIdeaRequestId } from "./ideaSubmissionCore.ts";
import type { AmuxDigestKey } from "./ideaCrypto.ts";

const NONCE = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function ideaTransferBrowserCookieName(previewId: string): string {
  if (!isAmuxIdeaRequestId(previewId)) throw new Error("Invalid transfer preview ID");
  return `amux-v4-preview-${previewId}`;
}

export function newIdeaTransferBrowserNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** Duplicate cookies or an absent browser receipt cannot confirm a preview. */
export function readIdeaTransferBrowserNonce(cookieHeader: string | null,
  previewId: string): string | null {
  const name = ideaTransferBrowserCookieName(previewId);
  if (!cookieHeader) return null;
  const values = cookieHeader.split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 && NONCE.test(values[0]) ? values[0] : null;
}

/** Only a keyed proof, never the cookie or session identifier, enters audit. */
export function ideaTransferBrowserDigest(input: {
  previewId: string; nonce: string; authenticatedAt: string | undefined;
  key: AmuxDigestKey;
}): string {
  ideaTransferBrowserCookieName(input.previewId);
  if (!NONCE.test(input.nonce) ||
      Buffer.from(input.nonce, "base64url").length !== 32 ||
      typeof input.authenticatedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.authenticatedAt) ||
      !Number.isFinite(Date.parse(input.authenticatedAt)) ||
      !input.key.digestKeyId || !Buffer.isBuffer(input.key.digestKey) ||
      input.key.digestKey.length !== 32) {
    throw new Error("Transfer browser binding unavailable");
  }
  return createHmac("sha256", input.key.digestKey)
    .update("amux-v4-transfer-browser\0")
    .update(input.previewId).update("\0")
    .update(input.authenticatedAt).update("\0")
    .update(input.nonce).digest("hex");
}

export function matchesIdeaTransferBrowserDigest(expected: string, input: {
  previewId: string; nonce: string; authenticatedAt: string | undefined;
  key: AmuxDigestKey;
}): boolean {
  if (!DIGEST.test(expected)) return false;
  let actual: string;
  try { actual = ideaTransferBrowserDigest(input); } catch { return false; }
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
