import {
  componentError, componentValue, copyByteInput, decodeCanonical, encodeCanonical, rawSha256,
  type ComponentResult,
} from "./canonicalJson";
import {
  checkWire, isApproverId, isAsciiId, isDigest, isKeyId, isUtcSecond, requiredRole,
  type ComponentCheck,
} from "./wire";

// Local comparison arguments, NOT a registration schema. No registration parser,
// epoch history resolver, digest construction, callback or signature verifier.
export interface BindingExpectation {
  purpose: string; signerId: string; keyId: string; trustEpoch: string;
  contentDigest: string; previousEpochDigest: string | null;
}
const matched = (): ComponentResult<ComponentCheck> => componentValue({
  scope: "offline_component_only", authorityEstablished: false, fieldsMatch: true,
});
const invalid = () => componentError("invalid_input");
const mismatch = () => componentError("binding_mismatch");

function expectation(input: unknown): ComponentResult<BindingExpectation> {
  const encoded = encodeCanonical(input);
  if (!encoded.ok) return encoded;
  const decoded = decodeCanonical(encoded.value);
  if (!decoded.ok) return decoded;
  const value = decoded.value;
  const keys = ["purpose", "signerId", "keyId", "trustEpoch", "contentDigest", "previousEpochDigest"];
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))
    || !isAsciiId(value.purpose) || !isAsciiId(value.signerId) || !isKeyId(value.keyId)
    || !isAsciiId(value.trustEpoch) || !isDigest(value.contentDigest)
    || !(value.previousEpochDigest === null || isDigest(value.previousEpochDigest))) return invalid();
  return componentValue(value as unknown as BindingExpectation);
}

export function compareTrustBinding(
  payloadInput: unknown, anchorInput: unknown, expectedInput: unknown, comparisonTime: unknown,
): ComponentResult<ComponentCheck> {
  const payload = checkWire("SignaturePayload", payloadInput);
  const anchor = checkWire("TrustAnchor", anchorInput);
  const expected = expectation(expectedInput);
  if (!payload.ok || !anchor.ok || !expected.ok || !isUtcSecond(comparisonTime)) return invalid();
  const p = payload.value, a = anchor.value, e = expected.value;
  // Only the new D activation approver gets this additional handle grammar.
  if ((p.purpose === "s2_activation_approval" && !isApproverId(p.signerId))
    || (e.purpose === "s2_activation_approval" && !isApproverId(e.signerId))
    || (p.purpose === "s2_activation_approval" && !isApproverId(a.signerId))) return invalid();
  const role = requiredRole(p.purpose);
  if (!role || !requiredRole(e.purpose)) return componentError("unsupported_subset");
  if (p.purpose !== e.purpose || p.signerId !== a.signerId || p.signerId !== e.signerId
    || p.keyId !== a.keyId || p.keyId !== e.keyId || p.trustEpoch !== a.trustEpoch
    || p.trustEpoch !== e.trustEpoch || p.contentDigest !== e.contentDigest
    || a.previousEpochDigest !== e.previousEpochDigest || !a.roles.includes(role)) return mismatch();
  // No clock is consulted. Fixed-width validated UTC timestamps sort by time.
  // Exact boundaries are intentionally inconclusive, never an invented policy.
  if ((a.validUntil !== null && a.validUntil < a.validFrom)
    || comparisonTime < a.validFrom || (a.validUntil !== null && comparisonTime > a.validUntil)
    || (a.revokedAt !== null && comparisonTime > a.revokedAt)) return mismatch();
  if (comparisonTime === a.validFrom || comparisonTime === a.validUntil || comparisonTime === a.revokedAt) {
    return componentError("authority_unavailable");
  }
  return matched();
}

export function compareBlobRef(refInput: unknown, bytes: unknown, expectedInput: unknown): ComponentResult<ComponentCheck> {
  const ref = checkWire("BlobRef", refInput), expected = checkWire("BlobRef", expectedInput);
  const copy = copyByteInput(bytes);
  if (!ref.ok || !expected.ok || !copy.ok) return invalid();
  const hash = rawSha256(copy.value);
  if (!hash.ok) return invalid();
  // Bind bytes to the explicit expectation first; a changed ref field on its own
  // is a binding mismatch, not a misleading claim that the original bytes changed.
  if (hash.value !== expected.value.rawSha256 || copy.value.byteLength !== expected.value.byteLength) return componentError("bytes_mismatch");
  return ref.value.path === expected.value.path && ref.value.byteLength === expected.value.byteLength
    && ref.value.rawSha256 === expected.value.rawSha256 ? matched() : mismatch();
}

export function compareGitFileRef(refInput: unknown, bytes: unknown, expectedInput: unknown): ComponentResult<ComponentCheck> {
  const ref = checkWire("GitFileRef", refInput), expected = checkWire("GitFileRef", expectedInput);
  const copy = copyByteInput(bytes);
  if (!ref.ok || !expected.ok || !copy.ok) return invalid();
  const hash = rawSha256(copy.value);
  if (!hash.ok) return invalid();
  if (hash.value !== expected.value.rawSha256) return componentError("bytes_mismatch");
  return ref.value.commit === expected.value.commit && ref.value.path === expected.value.path
    && ref.value.rawSha256 === expected.value.rawSha256 ? matched() : mismatch();
}

export function compareTrustPolicyDigest(actual: unknown, expected: unknown): ComponentResult<ComponentCheck> {
  if (!isDigest(actual) || !isDigest(expected)) return invalid();
  return actual === expected ? matched() : mismatch();
}

export function comparePreviousEpochDigest(actual: unknown, expected: unknown): ComponentResult<ComponentCheck> {
  if (!(actual === null || isDigest(actual)) || !(expected === null || isDigest(expected))) return invalid();
  return actual === expected ? matched() : mismatch();
}

// Explicit negative capability queries; neither function parses a record or
// promotes matching local facts into an operational authorization/context.
export function checkRegistrationParsingAvailability(): ComponentResult<never> {
  return componentError("unsupported_subset");
}
export function checkAuthorityAvailability(): ComponentResult<never> {
  return componentError("authority_unavailable");
}
