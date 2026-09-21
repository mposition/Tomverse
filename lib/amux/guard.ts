import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

export class AmuxGuardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AmuxGuardError";
  }
}

const MIN_SECRET_LENGTH = 32;

export function isAmuxSyncAuthorized(request: Request): boolean {
  const configured = process.env.TOMVERSE_AMUX_SYNC_SECRET || "";
  if (configured.length < MIN_SECRET_LENGTH) return false;

  const authorization = request.headers.get("authorization") || "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!provided) return false;

  const expectedDigest = createHash("sha256").update(configured).digest();
  const providedDigest = createHash("sha256").update(provided).digest();

  return timingSafeEqual(expectedDigest, providedDigest);
}

export function requireInternalAmuxToken(request: Request): void {
  if (!isAmuxSyncAuthorized(request)) {
    throw new AmuxGuardError(
      "AMUX_UNAUTHORIZED",
      "Invalid Tomverse AMUX internal credential",
    );
  }
}
