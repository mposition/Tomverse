/**
 * The keyed digest a support-triage decision record keeps
 * (docs/policy/support-triage.md §6).
 *
 * A decision is bound to what the person saw: a suggestion's or sample's input
 * digest, or a group's members and input digest. The record keeps an
 * HMAC-SHA256 of that binding under a server-only key, never the binding
 * itself, so guessing a short report cannot reproduce the value without the
 * key.
 *
 * Keys: `SUPPORT_TRIAGE_DIGEST_KEY_V<n>` holds key version n as base64url of
 * at least 32 random bytes; `SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION` names
 * the version new records use. A record is checked only with the key of its
 * own version; a version whose key is gone is "unverifiable", never
 * recomputed. A key is retired only once no record of its version remains.
 *
 * Pure: the environment is an argument. No I/O, no logging; key bytes never
 * leave this module.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { DECISION_KINDS, type DecisionKind } from "./supportTriageCore";

export const DIGEST_KEY_PREFIX = "SUPPORT_TRIAGE_DIGEST_KEY_V";
export const DIGEST_KEY_CURRENT_VERSION_VARIABLE = "SUPPORT_TRIAGE_DIGEST_KEY_CURRENT_VERSION";
/** 256 bits. */
export const DIGEST_KEY_MIN_BYTES = 32;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const VERSION = /^[1-9][0-9]{0,8}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export type DigestKeyring = {
  readonly currentVersion: number;
  readonly keys: ReadonlyMap<number, Buffer>;
};

/** Why the keyring is unusable, and which variable to fix. Never a key's value. */
export type DigestKeyringProblem = {
  readonly reason: "current_version_missing" | "current_version_invalid" | "current_key_missing" | "key_malformed";
  readonly variable: string;
};

export type DigestKeyringResult =
  | { readonly ok: true; readonly keyring: DigestKeyring }
  | { readonly ok: false; readonly problem: DigestKeyringProblem };

const decodeKey = (value: string): Buffer | null => {
  if (!BASE64URL.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  // Reject values that do not round-trip (stray padding bits) and short keys.
  if (bytes.toString("base64url") !== value) return null;
  return bytes.length >= DIGEST_KEY_MIN_BYTES ? bytes : null;
};

/**
 * Reads every `SUPPORT_TRIAGE_DIGEST_KEY_V<n>` and the current version. Any
 * malformed key makes the whole keyring a configuration error: a key that
 * silently drops out would turn its records unverifiable without notice.
 */
export const readDigestKeyring = (env: Readonly<Record<string, string | undefined>>): DigestKeyringResult => {
  const keys = new Map<number, Buffer>();
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(DIGEST_KEY_PREFIX) || name === DIGEST_KEY_CURRENT_VERSION_VARIABLE) continue;
    const suffix = name.slice(DIGEST_KEY_PREFIX.length);
    const key = VERSION.test(suffix) && typeof value === "string" ? decodeKey(value) : null;
    if (!key) return { ok: false, problem: { reason: "key_malformed", variable: name } };
    keys.set(Number(suffix), key);
  }
  const current = env[DIGEST_KEY_CURRENT_VERSION_VARIABLE];
  if (current === undefined || current === "") {
    return { ok: false, problem: { reason: "current_version_missing", variable: DIGEST_KEY_CURRENT_VERSION_VARIABLE } };
  }
  if (!VERSION.test(current)) {
    return { ok: false, problem: { reason: "current_version_invalid", variable: DIGEST_KEY_CURRENT_VERSION_VARIABLE } };
  }
  const currentVersion = Number(current);
  if (!keys.has(currentVersion)) {
    return { ok: false, problem: { reason: "current_key_missing", variable: `${DIGEST_KEY_PREFIX}${currentVersion}` } };
  }
  return { ok: true, keyring: { currentVersion, keys } };
};

export const DECISION_TARGET_KINDS = Object.freeze(["suggestion", "group", "sample"] as const);
export type DecisionTargetKind = (typeof DECISION_TARGET_KINDS)[number];

/** What one decision was bound to. No report text, id, person, lane or flag. */
export type DecisionEnvelope = {
  readonly envelopeVersion: 1;
  readonly decisionKind: DecisionKind;
  readonly targetKind: DecisionTargetKind;
  /** A SHA-256 hex: the input digest, or `groupTargetBinding()` for a group. */
  readonly targetBinding: string;
  readonly policyVersion: number;
  readonly generatorVersions: Readonly<Record<string, string>>;
  /** Whole seconds since the epoch. */
  readonly decidedAtSecond: number;
};

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * A group decision is bound to the members shown and the group's input digest
 * at that moment, so two decisions over the same members but different report
 * states or signals are told apart.
 */
export const groupTargetBinding = (memberFeedbackIds: readonly string[], groupInputDigest: string) => {
  if (!HEX64.test(groupInputDigest)) throw new RangeError("groupInputDigest must be a SHA-256 hex");
  if (memberFeedbackIds.length === 0 || new Set(memberFeedbackIds).size !== memberFeedbackIds.length) {
    throw new RangeError("members must be a non-empty set");
  }
  const members = [...memberFeedbackIds].sort();
  return sha256Hex(canonicalJson({ groupInputDigest, members }));
};

/** JSON with object keys sorted at every depth; arrays keep their order. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("canonical JSON has no non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot hold ${typeof value}`);
};

const ENVELOPE_KEYS = [
  "decidedAtSecond",
  "decisionKind",
  "envelopeVersion",
  "generatorVersions",
  "policyVersion",
  "targetBinding",
  "targetKind",
];

const TARGET_OF: Readonly<Record<DecisionKind, DecisionTargetKind>> = {
  suggestion_accepted: "suggestion",
  suggestion_rejected: "suggestion",
  group_confirmed: "group",
  group_dismissed: "group",
  sample_judged: "sample",
};

/** Throws on anything but the exact envelope shape; the digest never covers a guess. */
export const assertDecisionEnvelope = (envelope: DecisionEnvelope) => {
  const keys = Object.keys(envelope).sort();
  if (keys.join(",") !== ENVELOPE_KEYS.join(",")) throw new RangeError("envelope has the wrong fields");
  if (envelope.envelopeVersion !== 1) throw new RangeError("unknown envelope version");
  if (!DECISION_KINDS.includes(envelope.decisionKind)) throw new RangeError("unknown decision kind");
  if (TARGET_OF[envelope.decisionKind] !== envelope.targetKind) throw new RangeError("target kind does not fit the decision");
  if (!HEX64.test(envelope.targetBinding)) throw new RangeError("targetBinding must be a SHA-256 hex");
  if (!Number.isSafeInteger(envelope.policyVersion) || envelope.policyVersion < 1) {
    throw new RangeError("policyVersion must be a positive integer");
  }
  if (!Number.isSafeInteger(envelope.decidedAtSecond) || envelope.decidedAtSecond < 0) {
    throw new RangeError("decidedAtSecond must be whole seconds");
  }
  const generators = envelope.generatorVersions;
  if (generators === null || typeof generators !== "object" || Array.isArray(generators)) {
    throw new RangeError("generatorVersions must be an object");
  }
  for (const [name, version] of Object.entries(generators)) {
    if (!/^[a-z][a-zA-Z0-9_.-]{0,63}$/.test(name) || typeof version !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(version)) {
      throw new RangeError("generatorVersions holds names and versions only");
    }
  }
};

const hmacHex = (key: Buffer, envelope: DecisionEnvelope) =>
  createHmac("sha256", key).update(canonicalJson(envelope), "utf8").digest("hex");

/** The value a new record keeps, always under the current key. */
export const computeDecisionDigest = (keyring: DigestKeyring, envelope: DecisionEnvelope) => {
  assertDecisionEnvelope(envelope);
  const key = keyring.keys.get(keyring.currentVersion);
  if (!key) throw new Error("the current digest key is not in the keyring");
  return { decisionEnvelopeDigest: hmacHex(key, envelope), digestVersion: keyring.currentVersion };
};

export type DecisionDigestCheck = "match" | "mismatch" | "unverifiable";

/** Checks a stored digest with its own version's key only; a missing key is not a mismatch. */
export const verifyDecisionDigest = (
  keyring: DigestKeyring,
  envelope: DecisionEnvelope,
  stored: { readonly decisionEnvelopeDigest: string; readonly digestVersion: number }
): DecisionDigestCheck => {
  assertDecisionEnvelope(envelope);
  const key = keyring.keys.get(stored.digestVersion);
  if (!key) return "unverifiable";
  if (!HEX64.test(stored.decisionEnvelopeDigest)) return "mismatch";
  const expected = Buffer.from(hmacHex(key, envelope), "hex");
  return timingSafeEqual(expected, Buffer.from(stored.decisionEnvelopeDigest, "hex")) ? "match" : "mismatch";
};
