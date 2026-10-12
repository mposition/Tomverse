import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived proof that the server offered Guest Chat Smart Adaptive for one
 * exact activated runtime. This token is only an input to the durable
 * authorityId + subjectKey claim; it does not replace that one-time claim or
 * any Send-time quota, kill-switch, activation, or financial check.
 */

export const GUEST_CHAT_AUTO_AUTHORITY_PURPOSE =
  "guest_chat_smart_adaptive" as const;
export const GUEST_CHAT_AUTO_AUTHORITY_PRODUCT = "chat" as const;
export const GUEST_CHAT_AUTO_AUTHORITY_POLICY_VERSION = 1 as const;
export const GUEST_CHAT_AUTO_AUTHORITY_MIN_TTL_SECONDS = 15;
export const GUEST_CHAT_AUTO_AUTHORITY_MAX_TTL_SECONDS = 300;

const TOKEN_PREFIX = "gca1";
const SIGNING_DOMAIN = "guest-chat-auto-authority.v1\0";
const MAX_TOKEN_LENGTH = 4_096;
const MAX_LABEL_LENGTH = 120;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const GUEST_SUBJECT_KEY = /^guest:[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST64 = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const WIRE_KEYS = [
  "version",
  "purpose",
  "product",
  "policyVersion",
  "authorityId",
  "nonce",
  "subjectKey",
  "sourceCommitSha",
  "runtimeDeploymentId",
  "activationPairDigest",
  "configDigest",
  "issuedAtMs",
  "expiresAtMs",
] as const;

export type GuestChatAutoAuthorityBinding = Readonly<{
  /** Existing HMAC-derived Guest usage subject; never the signed cookie. */
  subjectKey: `guest:${string}`;
  sourceCommitSha: string;
  runtimeDeploymentId: string;
  activationPairDigest: string;
  configDigest: string;
}>;

export type GuestChatAutoAuthorityPayload = Readonly<{
  version: 1;
  purpose: typeof GUEST_CHAT_AUTO_AUTHORITY_PURPOSE;
  product: typeof GUEST_CHAT_AUTO_AUTHORITY_PRODUCT;
  policyVersion: typeof GUEST_CHAT_AUTO_AUTHORITY_POLICY_VERSION;
  /** Stable id consumed with subjectKey by the durable one-turn claim. */
  authorityId: string;
  /** Token uniqueness only; never an idempotency or paid-work claim key. */
  nonce: string;
  subjectKey: `guest:${string}`;
  sourceCommitSha: string;
  runtimeDeploymentId: string;
  activationPairDigest: string;
  configDigest: string;
  issuedAtMs: number;
  expiresAtMs: number;
}>;

export type GuestChatAutoAuthorityVerification =
  | { ok: true; payload: GuestChatAutoAuthorityPayload }
  | {
      ok: false;
      reason:
        | "malformed"
        | "secret_unavailable"
        | "invalid_signature"
        | "not_yet_valid"
        | "expired"
        | "subject_mismatch"
        | "purpose_mismatch"
        | "product_mismatch"
        | "policy_mismatch"
        | "release_mismatch"
        | "activation_mismatch"
        | "config_mismatch";
    };

export type MintGuestChatAutoAuthorityInput = Readonly<{
  secret: string;
  binding: GuestChatAutoAuthorityBinding;
  authorityId: string;
  nonce: string;
  nowMs: number;
  /** Caller resolves CHAT_ADMISSION_TTL_SECONDS; this helper never reads env. */
  ttlSeconds: number;
}>;

export type VerifyGuestChatAutoAuthorityOptions = Readonly<{
  secret: string;
  binding: GuestChatAutoAuthorityBinding;
  nowMs: number;
}>;

const bindingIsValid = (
  binding: unknown
): binding is GuestChatAutoAuthorityBinding => {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return false;
  }
  const record = binding as Record<string, unknown>;
  return (
    typeof record.subjectKey === "string" &&
    GUEST_SUBJECT_KEY.test(record.subjectKey) &&
    typeof record.sourceCommitSha === "string" &&
    SHA40.test(record.sourceCommitSha) &&
    typeof record.runtimeDeploymentId === "string" &&
    UUID.test(record.runtimeDeploymentId) &&
    typeof record.activationPairDigest === "string" &&
    DIGEST64.test(record.activationPairDigest) &&
    typeof record.configDigest === "string" &&
    DIGEST64.test(record.configDigest)
  );
};

const timestampIsValid = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const ttlIsValid = (ttlSeconds: number): boolean =>
  Number.isSafeInteger(ttlSeconds) &&
  ttlSeconds >= GUEST_CHAT_AUTO_AUTHORITY_MIN_TTL_SECONDS &&
  ttlSeconds <= GUEST_CHAT_AUTO_AUTHORITY_MAX_TTL_SECONDS;

const payloadIsValid = (payload: GuestChatAutoAuthorityPayload): boolean => {
  if (
    payload.version !== 1 ||
    typeof payload.purpose !== "string" ||
    payload.purpose.length === 0 ||
    payload.purpose.length > MAX_LABEL_LENGTH ||
    typeof payload.product !== "string" ||
    payload.product.length === 0 ||
    payload.product.length > MAX_LABEL_LENGTH ||
    !Number.isSafeInteger(payload.policyVersion) ||
    !UUID.test(payload.authorityId) ||
    !UUID.test(payload.nonce) ||
    !bindingIsValid(payload) ||
    !timestampIsValid(payload.issuedAtMs) ||
    !timestampIsValid(payload.expiresAtMs) ||
    payload.expiresAtMs <= payload.issuedAtMs
  ) {
    return false;
  }

  const lifetimeMs = payload.expiresAtMs - payload.issuedAtMs;
  return (
    lifetimeMs >= GUEST_CHAT_AUTO_AUTHORITY_MIN_TTL_SECONDS * 1_000 &&
    lifetimeMs <= GUEST_CHAT_AUTO_AUTHORITY_MAX_TTL_SECONDS * 1_000 &&
    lifetimeMs % 1_000 === 0
  );
};

const encodePayload = (payload: GuestChatAutoAuthorityPayload): string =>
  Buffer.from(
    JSON.stringify({
      version: payload.version,
      purpose: payload.purpose,
      product: payload.product,
      policyVersion: payload.policyVersion,
      authorityId: payload.authorityId,
      nonce: payload.nonce,
      subjectKey: payload.subjectKey,
      sourceCommitSha: payload.sourceCommitSha,
      runtimeDeploymentId: payload.runtimeDeploymentId,
      activationPairDigest: payload.activationPairDigest,
      configDigest: payload.configDigest,
      issuedAtMs: payload.issuedAtMs,
      expiresAtMs: payload.expiresAtMs,
    }),
    "utf8"
  ).toString("base64url");

const signatureFor = (body: string, secret: string): Buffer =>
  createHmac("sha256", secret)
    .update(`${SIGNING_DOMAIN}${body}`, "utf8")
    .digest();

const decodePayload = (body: string): GuestChatAutoAuthorityPayload | null => {
  if (!body || !BASE64URL.test(body)) return null;

  let parsed: unknown;
  try {
    const bytes = Buffer.from(body, "base64url");
    if (bytes.toString("base64url") !== body) return null;
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== WIRE_KEYS.length ||
    keys.some((key, index) => key !== WIRE_KEYS[index])
  ) {
    return null;
  }

  const payload = record as unknown as GuestChatAutoAuthorityPayload;
  if (!payloadIsValid(payload) || encodePayload(payload) !== body) return null;
  return Object.freeze({ ...payload });
};

export const mintGuestChatAutoAuthority = (
  input: MintGuestChatAutoAuthorityInput
): string => {
  if (typeof input.secret !== "string" || input.secret.length === 0) {
    throw new Error("guest_chat_auto_authority_secret_unavailable");
  }
  if (
    !bindingIsValid(input.binding) ||
    !UUID.test(input.authorityId) ||
    !UUID.test(input.nonce) ||
    !timestampIsValid(input.nowMs) ||
    !ttlIsValid(input.ttlSeconds)
  ) {
    throw new Error("guest_chat_auto_authority_input_invalid");
  }

  const expiresAtMs = input.nowMs + input.ttlSeconds * 1_000;
  if (!timestampIsValid(expiresAtMs)) {
    throw new Error("guest_chat_auto_authority_input_invalid");
  }

  const payload: GuestChatAutoAuthorityPayload = Object.freeze({
    version: 1,
    purpose: GUEST_CHAT_AUTO_AUTHORITY_PURPOSE,
    product: GUEST_CHAT_AUTO_AUTHORITY_PRODUCT,
    policyVersion: GUEST_CHAT_AUTO_AUTHORITY_POLICY_VERSION,
    authorityId: input.authorityId,
    nonce: input.nonce,
    ...input.binding,
    issuedAtMs: input.nowMs,
    expiresAtMs,
  });
  const body = encodePayload(payload);
  const signature = signatureFor(body, input.secret).toString("base64url");
  const token = `${TOKEN_PREFIX}.${body}.${signature}`;
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new Error("guest_chat_auto_authority_token_too_large");
  }
  return token;
};

export const verifyGuestChatAutoAuthority = (
  token: string,
  options: VerifyGuestChatAutoAuthorityOptions
): GuestChatAutoAuthorityVerification => {
  if (typeof options.secret !== "string" || options.secret.length === 0) {
    return { ok: false, reason: "secret_unavailable" };
  }
  if (!bindingIsValid(options.binding) || !timestampIsValid(options.nowMs)) {
    return { ok: false, reason: "malformed" };
  }
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed" };
  }

  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== TOKEN_PREFIX ||
    !parts[1] ||
    !parts[2] ||
    !BASE64URL.test(parts[1]) ||
    !BASE64URL.test(parts[2])
  ) {
    return { ok: false, reason: "malformed" };
  }

  const [, body, signature] = parts;
  const expected = signatureFor(body, options.secret);
  const actual = Buffer.from(signature, "base64url");
  if (
    actual.toString("base64url") !== signature ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return { ok: false, reason: "invalid_signature" };
  }

  // Decode and compare only after the signature has been authenticated.
  const payload = decodePayload(body);
  if (!payload) return { ok: false, reason: "malformed" };

  if (payload.purpose !== GUEST_CHAT_AUTO_AUTHORITY_PURPOSE) {
    return { ok: false, reason: "purpose_mismatch" };
  }
  if (payload.product !== GUEST_CHAT_AUTO_AUTHORITY_PRODUCT) {
    return { ok: false, reason: "product_mismatch" };
  }
  if (payload.policyVersion !== GUEST_CHAT_AUTO_AUTHORITY_POLICY_VERSION) {
    return { ok: false, reason: "policy_mismatch" };
  }
  if (payload.subjectKey !== options.binding.subjectKey) {
    return { ok: false, reason: "subject_mismatch" };
  }
  if (
    payload.sourceCommitSha !== options.binding.sourceCommitSha ||
    payload.runtimeDeploymentId !== options.binding.runtimeDeploymentId
  ) {
    return { ok: false, reason: "release_mismatch" };
  }
  if (payload.activationPairDigest !== options.binding.activationPairDigest) {
    return { ok: false, reason: "activation_mismatch" };
  }
  if (payload.configDigest !== options.binding.configDigest) {
    return { ok: false, reason: "config_mismatch" };
  }
  if (payload.issuedAtMs > options.nowMs) {
    return { ok: false, reason: "not_yet_valid" };
  }
  if (payload.expiresAtMs <= options.nowMs) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload };
};
