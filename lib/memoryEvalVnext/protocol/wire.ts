import {
  componentError, componentValue, decodeCanonical, encodeCanonical,
  type CanonicalValue, type ComponentResult,
} from "./canonicalJson";

// These five shapes establish structure only. Expected local comparison values
// are not a registration wire format and never enter these records.
export interface BlobRef { path: string; byteLength: number; rawSha256: string }
export interface GitFileRef { commit: string; path: string; rawSha256: string }
export interface SignaturePayload {
  schemaVersion: 1; purpose: string; signerId: string; keyId: string;
  trustEpoch: string; contentDigest: string; issuedAt: string;
}
export interface SignatureReceipt { payload: SignaturePayload; signatureBase64: string }
export type Role = "approver" | "authoring_reviewer" | "controller" | "custodian" | "importer" | "reviewer";
export interface TrustAnchor {
  trustEpoch: string; signerId: string; keyId: string; publicKeyBase64: string;
  roles: Role[]; validFrom: string; validUntil: string | null; revokedAt: string | null;
  registrationReceipt: BlobRef; previousEpochDigest: string | null;
}
export interface WireTypes {
  BlobRef: BlobRef; GitFileRef: GitFileRef; SignaturePayload: SignaturePayload;
  SignatureReceipt: SignatureReceipt; TrustAnchor: TrustAnchor;
}
export interface ComponentCheck {
  scope: "offline_component_only"; authorityEstablished: false; fieldsMatch: boolean;
}

export const isDigest = (input: unknown): input is string => typeof input === "string" && /^[0-9a-f]{64}$/.test(input);
export const isKeyId = (input: unknown): input is string => typeof input === "string" && /^[0-9a-f]{32}$/.test(input);
// IP-D1: nonempty U+0021..U+007E only, without trimming or identity repair.
export const isAsciiId = (input: unknown): input is string => typeof input === "string"
  && input.length > 0 && !/[^\x21-\x7e]/.test(input);
export const isApproverId = (input: unknown): input is string => typeof input === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(input);

export function isUtcSecond(input: unknown): input is string {
  if (typeof input !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(input);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59;
}

function isRelativePath(input: unknown): input is string {
  // IP-D2: retain NFC Unicode/spaces; canonical validation runs before shape checks.
  return typeof input === "string" && input.length > 0 && !/[\\\u0000-\u001f\u007f]/.test(input)
    && !/^[A-Za-z]:/.test(input)
    && input.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function decodeBase64(input: unknown, byteLength: 32 | 64): ComponentResult<Uint8Array> {
  if ((byteLength !== 32 && byteLength !== 64) || typeof input !== "string"
    || !/^[A-Za-z0-9+/]+={1,2}$/.test(input)) return componentError("invalid_input");
  const bytes = Buffer.from(input, "base64");
  if (bytes.length !== byteLength || bytes.toString("base64") !== input) return componentError("invalid_input");
  return componentValue(bytes);
}

export function requiredRole(purpose: string): Role | undefined {
  switch (purpose) {
    case "s2_activation_approval": return "approver";
    case "s2_source_evidence":
    case "s2_activation_inclusion": return "importer";
    default: return undefined; // Not a claim that other upstream purposes are invalid.
  }
}

function record(value: CanonicalValue, keys: string[]): value is Record<string, CanonicalValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
const roles: readonly string[] = ["approver", "authoring_reviewer", "controller", "custodian", "importer", "reviewer"];
const nullableDigest = (input: unknown) => input === null || isDigest(input);
const nullableTime = (input: unknown) => input === null || isUtcSecond(input);

function validShape(kind: keyof WireTypes, value: CanonicalValue): boolean {
  switch (kind) {
    case "BlobRef": return record(value, ["path", "byteLength", "rawSha256"])
      && isRelativePath(value.path) && typeof value.byteLength === "number"
      && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0 && isDigest(value.rawSha256);
    case "GitFileRef": return record(value, ["commit", "path", "rawSha256"])
      && typeof value.commit === "string" && /^[0-9a-f]{40}$/.test(value.commit)
      && isRelativePath(value.path) && isDigest(value.rawSha256);
    case "SignaturePayload": return record(value, ["schemaVersion", "purpose", "signerId", "keyId", "trustEpoch", "contentDigest", "issuedAt"])
      && value.schemaVersion === 1 && isAsciiId(value.purpose) && isAsciiId(value.signerId)
      && isKeyId(value.keyId) && isAsciiId(value.trustEpoch) && isDigest(value.contentDigest) && isUtcSecond(value.issuedAt);
    case "SignatureReceipt": return record(value, ["payload", "signatureBase64"])
      && validShape("SignaturePayload", value.payload) && decodeBase64(value.signatureBase64, 64).ok;
    case "TrustAnchor": return record(value, ["trustEpoch", "signerId", "keyId", "publicKeyBase64", "roles", "validFrom", "validUntil", "revokedAt", "registrationReceipt", "previousEpochDigest"])
      && isAsciiId(value.trustEpoch) && isAsciiId(value.signerId) && isKeyId(value.keyId)
      && decodeBase64(value.publicKeyBase64, 32).ok && Array.isArray(value.roles)
      && value.roles.every((role, index, list) => typeof role === "string" && roles.includes(role)
        && (index === 0 || (list[index - 1] as string) < role))
      && isUtcSecond(value.validFrom) && nullableTime(value.validUntil) && nullableTime(value.revokedAt)
      && validShape("BlobRef", value.registrationReceipt) && nullableDigest(value.previousEpochDigest);
    default: return false;
  }
}

export function checkWire<K extends keyof WireTypes>(kind: K, input: unknown): ComponentResult<WireTypes[K]> {
  // Obtain a data-only snapshot before reading any field. Never trust caller
  // accessors, hidden fields, prototypes or subsequent mutation of the input.
  const encoded = encodeCanonical(input);
  if (!encoded.ok) return encoded;
  const decoded = decodeCanonical(encoded.value);
  if (!decoded.ok || !validShape(kind, decoded.value)) return componentError("invalid_input");
  return componentValue(decoded.value as unknown as WireTypes[K]);
}
