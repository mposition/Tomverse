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
