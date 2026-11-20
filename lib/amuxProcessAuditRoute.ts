// Authentication and responses for the AMUX process analysis box runner's two
// internal routes. The secret decides whether the routes exist: unset or
// shorter than 32 characters answers 404, as a path that is not there would.
// The comparison is between SHA-256 digests in constant time, and no other
// secret is a fallback: a leak of another service's secret does not reach this.

import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { AMUX_PROCESS_AUDIT_MIN_SECRET_LENGTH, AMUX_PROCESS_AUDIT_SECRET_ENV } from "./amuxProcessAuditCore";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export const processAuditSecret = (env: Readonly<Record<string, string | undefined>> = process.env): string | null => {
  const secret = env[AMUX_PROCESS_AUDIT_SECRET_ENV] ?? "";
  return secret.length >= AMUX_PROCESS_AUDIT_MIN_SECRET_LENGTH ? secret : null;
};

export const processAuditAuthorized = (request: Request, secret: string): boolean => {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const provided = authorization.slice("Bearer ".length);
  return provided.length > 0 && timingSafeEqual(digest(secret), digest(provided));
};

const NO_STORE = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } as const;

export const processAuditJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: NO_STORE });

/** A failure as an enum and a database code, never a message from a dependency. */
export const processAuditFailure = (operation: string, error: unknown): Response => {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null;
  console.error(JSON.stringify({
    event: "amux_process_audit_route_failed",
    operation,
    databaseCode: code && /^[A-Z0-9]{1,10}$/.test(code) ? code : null,
  }));
  return processAuditJson({ error: "unavailable" }, 503);
};
