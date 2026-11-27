import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";

/**
 * WebAuthn registration and assertion checks for the passkey that confirms a remote approval
 * (docs/ops/desktop-remote-control.md). Pure Node crypto, no server-only, no Prisma: the routes and the tests share it.
 *
 * Scope on purpose: ES256 (-7) and RS256 (-257) keys, attestation not trusted (the credential is requested with
 * attestation "none" and its statement is ignored), user presence and user verification both required, and one
 * origin and relying party per call. Nothing here reads a secret: it only checks what a public key signed.
 */

export const WEBAUTHN_ALGORITHMS = [-7, -257] as const;
export type WebAuthnAlgorithm = (typeof WEBAUTHN_ALGORITHMS)[number];

export class WebAuthnError extends Error {
  constructor(readonly code:
    | "malformed" | "type" | "challenge" | "origin" | "rp" | "presence" | "verification" | "algorithm" | "key" | "signature" | "counter",
  ) {
    super(`WebAuthn check failed: ${code}.`);
  }
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const toBase64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** Strict base64url (no padding, no other characters), cut at `maxBytes` decoded. */
export function fromBase64url(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || !value || value.length > Math.ceil(maxBytes * 4 / 3) + 2 || !BASE64URL.test(value)) throw new WebAuthnError("malformed");
  const bytes = Buffer.from(value, "base64url");
  if (!bytes.length || bytes.length > maxBytes || bytes.toString("base64url") !== value) throw new WebAuthnError("malformed");
  return bytes;
}

// ── CBOR: the subset an attestation object and a COSE key use ───────────────

type Cbor = number | bigint | boolean | null | Buffer | string | Cbor[] | Map<Cbor, Cbor>;

function readHead(bytes: Buffer, offset: number): { major: number; arg: number; next: number } {
  const first = bytes[offset];
  if (first === undefined) throw new WebAuthnError("malformed");
  const major = first >> 5;
  const info = first & 0x1f;
  if (info < 24) return { major, arg: info, next: offset + 1 };
  const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0;
  // 64-bit lengths and indefinite lengths are not used by any authenticator for these structures.
  if (!width || offset + 1 + width > bytes.length) throw new WebAuthnError("malformed");
  const arg = width === 1 ? bytes[offset + 1]! : width === 2 ? bytes.readUInt16BE(offset + 1) : bytes.readUInt32BE(offset + 1);
  return { major, arg, next: offset + 1 + width };
}

function decodeCbor(bytes: Buffer, offset: number, depth = 0): { value: Cbor; next: number } {
  if (depth > 8) throw new WebAuthnError("malformed");
  const head = readHead(bytes, offset);
  const { major, arg } = head;
  let next = head.next;
  switch (major) {
    case 0: return { value: arg, next };
    case 1: return { value: -1 - arg, next };
    case 2: case 3: {
      if (next + arg > bytes.length) throw new WebAuthnError("malformed");
      const slice = bytes.subarray(next, next + arg);
      return { value: major === 2 ? Buffer.from(slice) : slice.toString("utf8"), next: next + arg };
    }
    case 4: {
      if (arg > 64) throw new WebAuthnError("malformed");
      const items: Cbor[] = [];
      for (let index = 0; index < arg; index += 1) {
        const item = decodeCbor(bytes, next, depth + 1);
        items.push(item.value);
        next = item.next;
      }
      return { value: items, next };
    }
    case 5: {
      if (arg > 64) throw new WebAuthnError("malformed");
      const entries = new Map<Cbor, Cbor>();
      for (let index = 0; index < arg; index += 1) {
        const key = decodeCbor(bytes, next, depth + 1);
        const value = decodeCbor(bytes, key.next, depth + 1);
        if (entries.has(key.value)) throw new WebAuthnError("malformed");
        entries.set(key.value, value.value);
        next = value.next;
      }
      return { value: entries, next };
    }
    case 7:
      if (arg === 20) return { value: false, next };
      if (arg === 21) return { value: true, next };
      if (arg === 22) return { value: null, next };
      throw new WebAuthnError("malformed");
    default:
      throw new WebAuthnError("malformed");
  }
}

// ── client data and authenticator data ──────────────────────────────────────

type Expected = { challenge: string; origin: string; rpId: string };

function sameText(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkClientData(clientDataJSON: Buffer, type: "webauthn.create" | "webauthn.get", expected: Expected) {
  let parsed: unknown;
  try { parsed = JSON.parse(clientDataJSON.toString("utf8")); } catch { throw new WebAuthnError("malformed"); }
  if (!parsed || typeof parsed !== "object") throw new WebAuthnError("malformed");
  const data = parsed as Record<string, unknown>;
  if (data.type !== type) throw new WebAuthnError("type");
  if (typeof data.challenge !== "string" || !sameText(data.challenge, expected.challenge)) throw new WebAuthnError("challenge");
  if (typeof data.origin !== "string" || data.origin !== expected.origin || data.crossOrigin === true) throw new WebAuthnError("origin");
}

type AuthenticatorData = { flags: number; signCount: number; rest: Buffer };

function checkAuthenticatorData(authData: Buffer, rpId: string): AuthenticatorData {
  if (authData.length < 37) throw new WebAuthnError("malformed");
  const expected = createHash("sha256").update(rpId).digest();
  if (!timingSafeEqual(authData.subarray(0, 32), expected)) throw new WebAuthnError("rp");
  const flags = authData[32]!;
  if (!(flags & FLAG_UP)) throw new WebAuthnError("presence");
  // The person must have unlocked the authenticator (biometric or PIN), not only touched it.
  if (!(flags & FLAG_UV)) throw new WebAuthnError("verification");
  return { flags, signCount: authData.readUInt32BE(33), rest: authData.subarray(37) };
}

// ── registration ────────────────────────────────────────────────────────────

export type RegisteredCredential = {
  credentialId: string;
  /** SubjectPublicKeyInfo, DER, base64url. */
  publicKey: string;
  alg: WebAuthnAlgorithm;
  signCount: number;
};

function coseToSpki(cose: Cbor): { spki: Buffer; alg: WebAuthnAlgorithm } {
  if (!(cose instanceof Map)) throw new WebAuthnError("key");
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (alg !== -7 && alg !== -257) throw new WebAuthnError("algorithm");
  try {
    if (alg === -7) {
      const x = cose.get(-2);
      const y = cose.get(-3);
      if (kty !== 2 || cose.get(-1) !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new WebAuthnError("key");
      const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url") }, format: "jwk" });
      return { spki: key.export({ type: "spki", format: "der" }), alg };
    }
    const n = cose.get(-1);
    const e = cose.get(-2);
    // 2048 bits at least: a shorter modulus is not a key worth trusting an approval to.
    if (kty !== 3 || !Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256 || n.length > 1024 || e.length < 1 || e.length > 8) throw new WebAuthnError("key");
    const key = createPublicKey({ key: { kty: "RSA", n: n.toString("base64url"), e: e.toString("base64url") }, format: "jwk" });
    return { spki: key.export({ type: "spki", format: "der" }), alg };
  } catch (error) {
    throw error instanceof WebAuthnError ? error : new WebAuthnError("key");
  }
}

export function verifyRegistration(input: {
  clientDataJSON: string;
  attestationObject: string;
  expected: Expected;
}): RegisteredCredential {
  const clientData = fromBase64url(input.clientDataJSON, 4096);
  checkClientData(clientData, "webauthn.create", input.expected);
  const attestation = decodeCbor(fromBase64url(input.attestationObject, 16 * 1024), 0).value;
  if (!(attestation instanceof Map)) throw new WebAuthnError("malformed");
  const authData = attestation.get("authData");
  if (!Buffer.isBuffer(authData)) throw new WebAuthnError("malformed");
  // The attestation statement is not read: the credential is requested with attestation "none".
  const { flags, signCount, rest } = checkAuthenticatorData(authData, input.expected.rpId);
  if (!(flags & FLAG_AT) || rest.length < 18) throw new WebAuthnError("malformed");
  const idLength = rest.readUInt16BE(16);
  if (idLength < 16 || idLength > 1023 || rest.length < 18 + idLength) throw new WebAuthnError("malformed");
  const credentialId = rest.subarray(18, 18 + idLength);
  const key = decodeCbor(rest, 18 + idLength);
  const { spki, alg } = coseToSpki(key.value);
  return { credentialId: toBase64url(credentialId), publicKey: toBase64url(spki), alg, signCount };
}

// ── assertion ───────────────────────────────────────────────────────────────

export type StoredPasskey = { publicKey: string; alg: number; signCount: number };

/**
 * Checks one assertion against the public key stored at registration. Returns the new signature counter. An
 * authenticator that counts must count up: a counter that did not rise means the credential was copied.
 */
export function verifyAssertion(input: {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  expected: Expected;
  stored: StoredPasskey;
}): { signCount: number } {
  if (input.stored.alg !== -7 && input.stored.alg !== -257) throw new WebAuthnError("algorithm");
  const clientData = fromBase64url(input.clientDataJSON, 4096);
  checkClientData(clientData, "webauthn.get", input.expected);
  const authData = fromBase64url(input.authenticatorData, 4096);
  const { signCount } = checkAuthenticatorData(authData, input.expected.rpId);
  const signature = fromBase64url(input.signature, 1024);
  const signed = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);
  let valid = false;
  try {
    const key = createPublicKey({ key: Buffer.from(input.stored.publicKey, "base64url"), format: "der", type: "spki" });
    valid = verify("sha256", signed, key, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new WebAuthnError("signature");
  if ((signCount !== 0 || input.stored.signCount !== 0) && signCount <= input.stored.signCount) throw new WebAuthnError("counter");
  return { signCount };
}
