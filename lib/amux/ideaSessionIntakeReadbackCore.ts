import { createHash, timingSafeEqual } from "node:crypto";

import { isAmuxIdeaRequestId } from "./ideaRequestIdCore.ts";

export const AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV =
  "TOMVERSE_AMUX_SESSION_INTAKE_CLIENT_SECRET";
export const AMUX_SESSION_INTAKE_READBACK_ENV =
  "TOMVERSE_AMUX_SESSION_INTAKE_READBACK";
export const AMUX_SESSION_INTAKE_READBACK_CODE_LATCH = true;

const SECRET_LIKE_ENV_NAME =
  /(?:^|_)(?:SECRET|TOKEN|API_KEY|PRIVATE_KEY|PASSWORD|CREDENTIAL|COOKIE|KEYRING|PEPPER|KEYS?)(?:_|$)|(?:^|_)(?:DATABASE_URL|POSTGRES)(?:_|$)/i;

export const isAmuxSessionIntakeConflictingSecretEnvName = (
  name: string,
): boolean => name !== AMUX_SESSION_INTAKE_CLIENT_SECRET_ENV &&
  SECRET_LIKE_ENV_NAME.test(name);

/** Return values only: names and credentials never leave the authorization
 * path. Read the current environment for every request so a newly introduced
 * internal credential cannot silently share the intake bearer. */
export function amuxSessionIntakeConflictingSecretValues(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    isAmuxSessionIntakeConflictingSecretEnvName(name) && value
      ? [value]
      : []);
}

const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

export const isAmuxSessionIntakeClientSecret = (
  value: unknown,
): value is string => typeof value === "string" && SECRET.test(value);

export const amuxSessionIntakeReadbackEnabled = (
  sessionIntakeReadback: string | undefined,
  ideaReadback: string | undefined,
): boolean => AMUX_SESSION_INTAKE_READBACK_CODE_LATCH &&
  sessionIntakeReadback === "enabled" && ideaReadback === "enabled";

/** This bearer grants only session intake/readback. A value shared with any
 * other configured secret-like environment value is refused. */
export function isAmuxSessionIntakeClientAuthorized(
  request: Request,
  configured: string | undefined,
  otherSecrets: readonly (string | undefined)[],
): boolean {
  if (!isAmuxSessionIntakeClientSecret(configured) ||
      otherSecrets.some((secret) => secret === configured)) return false;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const provided = authorization.slice(7);
  if (!isAmuxSessionIntakeClientSecret(provided)) return false;
  return timingSafeEqual(
    createHash("sha256").update(configured).digest(),
    createHash("sha256").update(provided).digest(),
  );
}

/** One exact request ID and no query extensions: readback cannot become a
 * listing or a broader lookup surface. */
export function amuxSessionIntakeReadbackRequestId(request: Request): string | null {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => key !== "requestId")) return null;
  const requestIds = params.getAll("requestId");
  return requestIds.length === 1 && isAmuxIdeaRequestId(requestIds[0]!)
    ? requestIds[0]!
    : null;
}

export type AmuxSessionIntakeReadback =
  | { requestId: string; status: "absent" }
  | { requestId: string; status: "partial"; ideaId: string }
  | { requestId: string; status: "committed"; ideaId: string;
      reservationId: string; hasExternalSources: boolean };

/** Closed response projection. Extra service fields, including encrypted or
 * plaintext content added by mistake, never reach the intake client. */
export function amuxSessionIntakeReadbackReply(
  expectedRequestId: string,
  readback: AmuxSessionIntakeReadback,
): {
  status: number;
  body: Record<string, unknown>;
} {
  if (readback.requestId !== expectedRequestId) {
    throw new Error("session intake readback request ID mismatch");
  }
  if (readback.status === "absent") {
    return { status: 404, body: { status: "absent", requestId: readback.requestId,
      retryWrite: false } };
  }
  if (readback.status === "partial") {
    return { status: 409, body: { status: "partial", requestId: readback.requestId,
      ideaId: readback.ideaId, retryWrite: false } };
  }
  return { status: 200, body: {
    status: "committed",
    requestId: readback.requestId,
    ideaId: readback.ideaId,
    reservationId: readback.reservationId,
    hasExternalSources: readback.hasExternalSources,
    adminPath: `/admin/amux-backlog?tab=ideas&idea=${encodeURIComponent(readback.requestId)}`,
  } };
}
