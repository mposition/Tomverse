/**
 * How the marketing generator proves it is the generator (S3 plan, S3a/S3b).
 *
 * Only `MARKETING_GENERATOR_SUBMIT_SECRET`, by the publisher route's rule: at
 * least 32 characters, compared as SHA-256 digests in constant time, and no
 * other secret as a fallback -- a secret shared with another service is one
 * whose leak reaches this. Shared by the generator's routes so the rule is
 * written once.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const MARKETING_GENERATOR_SECRET_ENV = "MARKETING_GENERATOR_SUBMIT_SECRET";

/** The secret, or null when it is missing or too short to be one. */
export const marketingGeneratorSecret = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null => {
  const secret = env[MARKETING_GENERATOR_SECRET_ENV];
  return secret && secret.length >= 32 ? secret : null;
};

export const marketingGeneratorAuthorized = (request: Request, secret: string): boolean => {
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(secret).digest(),
    createHash("sha256").update(provided).digest(),
  );
};

/**
 * The body, read chunk by chunk and abandoned the moment it passes `maxBytes`.
 *
 * Not `request.json()` or `arrayBuffer()`: those hold the whole body before
 * anything can count it, and the generator is authenticated but not trusted --
 * a body of any size would be parsed before the schema could refuse it.
 * `null` means too large.
 */
export const readMarketingGeneratorBody = async (
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

/** Strict UTF-8 JSON, or undefined. */
export const parseMarketingGeneratorJson = (raw: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return undefined;
  }
};
