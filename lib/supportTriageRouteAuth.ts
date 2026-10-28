/**
 * Who may call the support-triage internal routes (docs/policy/support-triage.md §3).
 *
 * Each route has its own secret, held by its own caller only: the retention
 * service holds the retention secret, the worker service the run secret, and
 * the team 3 watcher the heartbeat secret, which neither triage service gets,
 * so a failing component cannot report on itself. A secret shorter than 32
 * characters is treated as absent. The comparison is of SHA-256 digests in
 * constant time.
 *
 * Pure: the environment is an argument. No I/O, no logging; secrets never
 * leave this module.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const SUPPORT_TRIAGE_RUN_SECRET_ENV = "SUPPORT_TRIAGE_RUN_SECRET";
export const SUPPORT_TRIAGE_RETENTION_SECRET_ENV = "SUPPORT_TRIAGE_RETENTION_SECRET";
export const SUPPORT_TRIAGE_HEARTBEAT_SECRET_ENV = "SUPPORT_TRIAGE_HEARTBEAT_SECRET";
export const SUPPORT_TRIAGE_ENABLED_ENV = "SUPPORT_TRIAGE_ENABLED";
export const SUPPORT_TRIAGE_ROUTE_SECRET_MIN_LENGTH = 32;

export type SupportTriageRouteSecretEnv =
  | typeof SUPPORT_TRIAGE_RUN_SECRET_ENV
  | typeof SUPPORT_TRIAGE_RETENTION_SECRET_ENV
  | typeof SUPPORT_TRIAGE_HEARTBEAT_SECRET_ENV;

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Bearer secret of the named route, at least 32 characters, compared in constant time. */
export const isSupportTriageRouteAuthorized = (
  authorization: string | null,
  secretEnv: SupportTriageRouteSecretEnv,
  env: Readonly<Record<string, string | undefined>>
): boolean => {
  const own = env[secretEnv] ?? "";
  if (own.length < SUPPORT_TRIAGE_ROUTE_SECRET_MIN_LENGTH) return false;
  if (!authorization?.startsWith("Bearer ")) return false;
  const provided = authorization.slice("Bearer ".length);
  if (provided.length === 0) return false;
  return timingSafeEqual(digest(own), digest(provided));
};

/** Dark by default: only the exact string "true" enables triage. */
export const isSupportTriageEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env[SUPPORT_TRIAGE_ENABLED_ENV] === "true";
