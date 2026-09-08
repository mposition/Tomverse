import { createPublicKey, verify } from "node:crypto";
import {
  componentError, componentValue, domainSha256, encodeCanonical, type ComponentResult,
} from "./canonicalJson";
import { checkWire, decodeBase64, requiredRole, type ComponentCheck } from "./wire";

// RFC 8410 SubjectPublicKeyInfo header for id-Ed25519 with absent parameters.
// The sole native algorithm selection is null + this Ed25519 public KeyObject.
// No signing, key generation, ph/ctx/options, trusted-root or operational API.
const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
const matched = (): ComponentResult<ComponentCheck> => componentValue({
  scope: "offline_component_only", authorityEstablished: false, fieldsMatch: true,
});

export function signatureMessage(input: unknown): ComponentResult<Uint8Array> {
  const payload = checkWire("SignaturePayload", input);
  if (!payload.ok) return payload;
  if (!requiredRole(payload.value.purpose)) return componentError("unsupported_subset");
  const body = encodeCanonical(payload.value);
  if (!body.ok) return body;
  return componentValue(Buffer.concat([Buffer.from("mem-signature-1\n", "utf8"), body.value]));
}

export function signatureReceiptDigest(input: unknown): ComponentResult<string> {
  const receipt = checkWire("SignatureReceipt", input);
  if (!receipt.ok) return receipt;
  if (!requiredRole(receipt.value.payload.purpose)) return componentError("unsupported_subset");
  return domainSha256("mem-signature-receipt-1", receipt.value);
}

export function verifyPureEd25519(
  message: unknown, publicKeyBase64: unknown, signatureBase64: unknown,
): ComponentResult<ComponentCheck> {
  const publicKey = decodeBase64(publicKeyBase64, 32);
  const signature = decodeBase64(signatureBase64, 64);
  if (!(message instanceof Uint8Array) || !publicKey.ok || !signature.ok) return componentError("invalid_input");
  try {
    const key = createPublicKey({
      key: Buffer.concat([spkiHeader, publicKey.value]), type: "spki", format: "der",
    });
    return verify(null, message, key, signature.value) ? matched() : componentError("signature_mismatch");
  } catch {
    // Do not expose native exception text, malformed key bytes or a key object.
    return componentError("invalid_input");
  }
}

// Expected payload is an explicit, untrusted comparison input. Equality does
// not prove that contentDigest came from an approval body or a trusted signer.
export function verifySignatureReceipt(
  input: unknown, publicKeyBase64: unknown, expectedPayload: unknown,
): ComponentResult<ComponentCheck> {
  const receipt = checkWire("SignatureReceipt", input);
  const expected = checkWire("SignaturePayload", expectedPayload);
  const key = decodeBase64(publicKeyBase64, 32);
  if (!receipt.ok || !expected.ok || !key.ok) return componentError("invalid_input");
  if (!requiredRole(receipt.value.payload.purpose) || !requiredRole(expected.value.purpose)) return componentError("unsupported_subset");
  const message = signatureMessage(receipt.value.payload);
  if (!message.ok) return message;
  const signature = verifyPureEd25519(message.value, publicKeyBase64, receipt.value.signatureBase64);
  if (!signature.ok) return signature;
  const actual = receipt.value.payload;
  const same = actual.schemaVersion === expected.value.schemaVersion && actual.purpose === expected.value.purpose
    && actual.signerId === expected.value.signerId && actual.keyId === expected.value.keyId
    && actual.trustEpoch === expected.value.trustEpoch && actual.contentDigest === expected.value.contentDigest
    && actual.issuedAt === expected.value.issuedAt;
  return same ? matched() : componentError("binding_mismatch");
}
