import { createHmac, timingSafeEqual } from "node:crypto";

import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";
import {
  TOKEN_VERIFICATION_STATUS,
  TRACE_PROVENANCE,
  type TokenVerificationStatus,
} from "@/lib/errorReportContract";

/**
 * Server-issued error report token (Node runtime only).
 *
 * The token proves one thing: the trace ID and the error facts inside it were
 * minted by this server, at this release, at this time. It is NOT an auth
 * credential, not an ownership check, and it never substitutes for the
 * feedback endpoint's own rate limiting and verification.
 *
 * Boundaries (docs/policy/trace-feedback-automation.md):
 *  - issued only for server-generated traces on reportable, server-classified
 *    chat errors -- never for client-supplied or client-fallback traces, and
 *    never pre-issued on a healthy stream;
 *  - the raw token is never stored: not in the DB, not in logs, not in
 *    Sentry. Only the verification outcome is recorded;
 *  - this module must not be imported from proxy.ts or any Edge-capable
 *    bundle -- it depends on node:crypto by design.
 */

const TOKEN_VERSION = "terr1";
const MAX_TOKEN_LENGTH = 2_048;
const DEFAULT_TTL_HOURS = 72;
const MIN_TTL_HOURS = 1;
const MAX_TTL_HOURS = 168;
const MIN_SECRET_LENGTH = 32;

export type ErrorReportTokenPayload = {
  /** Always TRACE_PROVENANCE.serverGenerated; anything else fails closed. */
  traceProvenance: string;
  traceId: string;
  routeClass: string;
  release: string | null;
  environment: string | null;
  issuedAt: number;
  expiresAt: number;
  /** Only present when the server had already classified the error at
   * issuance time. A client classification added later never joins it. */
  errorCode?: string;
  /** Trusted evidence identity minted alongside the token, when evidence was
   * recorded (or scheduled) for this occurrence. */
  occurrenceId?: string;
};

export type ErrorReportTokenVerification =
  | { status: typeof TOKEN_VERIFICATION_STATUS.verified; payload: ErrorReportTokenPayload }
  | {
      status: Exclude<
        TokenVerificationStatus,
        "verified" | "missing_token" | "payload_mismatch"
      >;
      payload: null;
    };

const readSecret = () => {
  const secret = process.env.ERROR_REPORT_SIGNING_SECRET || "";
  return secret.length >= MIN_SECRET_LENGTH ? secret : null;
};

/** Whether tokens can be issued/verified at all. A missing secret disables
 * only the trace-verification feature; feedback submission stays up. */
export const isErrorReportSigningConfigured = () => readSecret() !== null;

export const errorReportTokenTtlMs = () => {
  const raw = Number(process.env.ERROR_REPORT_TOKEN_TTL_HOURS || "");
  const hours =
    Number.isFinite(raw) && raw >= MIN_TTL_HOURS && raw <= MAX_TTL_HOURS
      ? raw
      : DEFAULT_TTL_HOURS;
  return hours * 60 * 60 * 1000;
};

/**
 * Canonical serialization: fixed field order, undefined fields omitted
 * entirely. An absent optional field and an empty string are different
 * payloads and produce different signatures.
 */
const canonicalPayload = (payload: ErrorReportTokenPayload) => {
  const ordered: Record<string, unknown> = {
    traceProvenance: payload.traceProvenance,
    traceId: payload.traceId,
    routeClass: payload.routeClass,
    release: payload.release,
    environment: payload.environment,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
  if (payload.errorCode !== undefined) ordered.errorCode = payload.errorCode;
  if (payload.occurrenceId !== undefined) {
    ordered.occurrenceId = payload.occurrenceId;
  }
  return JSON.stringify(ordered);
};

const sign = (secret: string, payloadB64: string) =>
  createHmac("sha256", secret)
    .update(`${TOKEN_VERSION}.${payloadB64}`)
    .digest("base64url");

export const issueErrorReportToken = (input: {
  traceId: string;
  routeClass: string;
  errorCode?: string;
  occurrenceId?: string;
  now?: number;
}): string | null => {
  const secret = readSecret();
  if (!secret) return null;
  if (!input.traceId) return null;
  const issuedAt = input.now ?? Date.now();
  const payload: ErrorReportTokenPayload = {
    traceProvenance: TRACE_PROVENANCE.serverGenerated,
    traceId: input.traceId,
    routeClass: input.routeClass,
    release:
      process.env.SENTRY_RELEASE ||
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      null,
    // Deliberately NOT SENTRY_ENVIRONMENT: this is signed into the token and
    // read back as a fact about which deployment issued it, not as a label for
    // a dashboard.
    environment: resolveDeploymentEnvironment(),
    issuedAt,
    expiresAt: issuedAt + errorReportTokenTtlMs(),
    // undefined means "not classified at issuance"; an empty string is a
    // different (and signed-as-different) payload. Absent and empty never
    // collapse into each other anywhere in this module.
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.occurrenceId !== undefined
      ? { occurrenceId: input.occurrenceId }
      : {}),
  };
  const payloadB64 = Buffer.from(canonicalPayload(payload)).toString(
    "base64url"
  );
  return `${TOKEN_VERSION}.${payloadB64}.${sign(secret, payloadB64)}`;
};

/**
 * Verifies a token string. Malformed input of any kind -- oversized, wrong
 * version, bad encoding, tampered payload or signature -- resolves to a
 * verification status; nothing here throws on attacker-controlled input.
 */
export const verifyErrorReportToken = (
  token: string,
  now: number = Date.now()
): ErrorReportTokenVerification => {
  const secret = readSecret();
  const invalid = {
    status: TOKEN_VERIFICATION_STATUS.invalidSignature,
    payload: null,
  } as const;
  if (!secret) return invalid;
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    return invalid;
  }
  const parts = token.split(".");
  if (parts.length !== 3) return invalid;
  const [version, payloadB64, signatureB64] = parts;
  if (version !== TOKEN_VERSION) {
    return {
      status: TOKEN_VERIFICATION_STATUS.unsupportedVersion,
      payload: null,
    };
  }
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureB64, "base64url");
  } catch {
    return invalid;
  }
  // Base64 is not a canonical encoding, and Node's decoder is lenient. A
  // 32-byte HMAC is 43 base64url characters whose last one carries only four
  // meaningful bits -- the low two are padding the decoder discards. So a
  // signature ending `zw` and the same signature ending `zz` decode to
  // identical bytes, and comparing decoded bytes alone accepts a token string
  // nobody issued.
  //
  // Checked against the input's own re-encoding rather than against the
  // expected signature: this is a property of the string the caller sent, so
  // it involves no secret and can be a plain comparison. Comparing against the
  // real signature here would leak it through timing, which is the reason the
  // byte comparison below is timing-safe in the first place.
  if (provided.toString("base64url") !== signatureB64) return invalid;
  const expected = Buffer.from(sign(secret, payloadB64), "base64url");
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    return invalid;
  }

  let payload: ErrorReportTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as ErrorReportTokenPayload;
  } catch {
    return invalid;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.traceId !== "string" ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.expiresAt !== "number"
  ) {
    return invalid;
  }
  // The signature only ever covers server-generated traces; a payload
  // claiming anything else was not produced by issueErrorReportToken.
  if (payload.traceProvenance !== TRACE_PROVENANCE.serverGenerated) {
    return {
      status: TOKEN_VERIFICATION_STATUS.untrustedTraceSource,
      payload: null,
    };
  }
  if (payload.expiresAt <= now || payload.issuedAt > now + 5 * 60 * 1000) {
    return { status: TOKEN_VERIFICATION_STATUS.expired, payload: null };
  }
  return { status: TOKEN_VERIFICATION_STATUS.verified, payload };
};
