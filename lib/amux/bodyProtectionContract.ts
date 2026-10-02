/** Dark, provider-neutral candidate for backup-aware AMUX v4 body protection.
 * This module has no provider adapter, credential, database writer, or live caller. */

export const AMUX_EXTERNAL_BODY_FORMAT = "amux-v4-external-body-v1" as const;

export type AmuxProtectedBodyPurpose =
  | "idea_raw"
  | "source_scope"
  | "transfer_payload"
  | "analysis_draft"
  | "analysis_freeform"
  | "node_content"
  | "card_title"
  | "card_brief";

export type AmuxProtectedBodyIdentity = Readonly<{
  bodyId: string;
  ownerId: string;
  purpose: AmuxProtectedBodyPurpose;
  bodyVersion: number;
}>;

export type AmuxExternalKeyHandle = Readonly<{
  id: string;
  version: number;
}>;

export type AmuxProtectedBodyEnvelope = Readonly<{
  format: typeof AMUX_EXTERNAL_BODY_FORMAT;
  identity: AmuxProtectedBodyIdentity;
  keyHandle: AmuxExternalKeyHandle;
  ciphertext: Buffer;
}>;

export type AmuxKeyDestructionObservation = Readonly<{
  operationId: string;
  keyHandle: AmuxExternalKeyHandle;
  state: "active" | "pending" | "reported_destroyed" | "outcome_unknown";
  evidenceDigest: string | null;
}>;

/** The implementation may encrypt within a key service or wrap a local data key.
 * Its plaintext location and destruction proof require a separate approval. */
export interface AmuxBodyProtectionPort {
  seal(input: {
    identity: AmuxProtectedBodyIdentity;
    plaintext: Buffer;
    /** Stable idempotency key; an uncertain result requires read-back. The caller
     * must check the result with assertAmuxEnvelopeBinding before persisting. */
    requestId: string;
  }): Promise<AmuxProtectedBodyEnvelope>;

  open(input: {
    identity: AmuxProtectedBodyIdentity;
    envelope: AmuxProtectedBodyEnvelope;
  }): Promise<Buffer>;

  requestDestruction(input: {
    identity: AmuxProtectedBodyIdentity;
    envelope: AmuxProtectedBodyEnvelope;
    operationId: string;
  }): Promise<AmuxKeyDestructionObservation>;

  inspectDestruction(input: {
    identity: AmuxProtectedBodyIdentity;
    envelope: AmuxProtectedBodyEnvelope;
    operationId: string;
  }): Promise<AmuxKeyDestructionObservation>;
}

const OPAQUE_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const HANDLE_ID = /^[A-Za-z0-9:_-]{1,192}$/;
const OPERATION_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const MAX_BODY_BYTES = 1024 * 1024;
const PURPOSES: ReadonlySet<string> = new Set<AmuxProtectedBodyPurpose>([
  "idea_raw", "source_scope", "transfer_payload", "analysis_draft", "analysis_freeform",
  "node_content", "card_title", "card_brief",
]);

function validatedIdentity(identity: AmuxProtectedBodyIdentity): AmuxProtectedBodyIdentity {
  const value = identity && typeof identity === "object" ? {
    bodyId: identity.bodyId,
    ownerId: identity.ownerId,
    purpose: identity.purpose,
    bodyVersion: identity.bodyVersion,
  } : null;
  if (!value || typeof value.bodyId !== "string" || !OPAQUE_ID.test(value.bodyId) ||
      typeof value.ownerId !== "string" || !OPAQUE_ID.test(value.ownerId) ||
      !PURPOSES.has(value.purpose) ||
      !Number.isSafeInteger(value.bodyVersion) || value.bodyVersion < 1) {
    throw new Error("AMUX protected body identity is invalid");
  }
  return value;
}

function validatedHandle(handle: AmuxExternalKeyHandle): AmuxExternalKeyHandle {
  const value = handle && typeof handle === "object" ? { id: handle.id, version: handle.version } : null;
  if (!value || typeof value.id !== "string" || !HANDLE_ID.test(value.id) ||
      !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new Error("AMUX external key handle is invalid");
  }
  return value;
}

export function assertAmuxProtectedBodyIdentity(identity: AmuxProtectedBodyIdentity): void {
  validatedIdentity(identity);
}

export function assertAmuxExternalKeyHandle(handle: AmuxExternalKeyHandle): void {
  validatedHandle(handle);
}

export function assertAmuxBodyPlaintext(plaintext: Buffer): void {
  if (!Buffer.isBuffer(plaintext) || plaintext.length > MAX_BODY_BYTES) {
    throw new Error("AMUX protected body plaintext is invalid");
  }
}

export function assertAmuxBodyOperationId(operationId: string): void {
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) {
    throw new Error("AMUX protected body operation id is invalid");
  }
}

/** Binds ciphertext to its owner, immutable body version, purpose, and key handle.
 * All string fields are restricted to ASCII without NUL, so separators are unambiguous. */
export function amuxProtectedBodyAad(
  identity: AmuxProtectedBodyIdentity,
  handle: AmuxExternalKeyHandle,
): Buffer {
  const body = validatedIdentity(identity);
  const key = validatedHandle(handle);
  return Buffer.from([
    AMUX_EXTERNAL_BODY_FORMAT,
    body.ownerId,
    body.bodyId,
    body.purpose,
    String(body.bodyVersion),
    key.id,
    String(key.version),
  ].join("\0"), "utf8");
}

export function assertAmuxEnvelopeBinding(
  envelope: AmuxProtectedBodyEnvelope,
  identity: AmuxProtectedBodyIdentity,
): void {
  const requested = validatedIdentity(identity);
  if (!envelope || envelope.format !== AMUX_EXTERNAL_BODY_FORMAT ||
      !envelope.identity || !Buffer.isBuffer(envelope.ciphertext) ||
      envelope.ciphertext.length === 0 || envelope.ciphertext.length > 2 * 1024 * 1024) {
    throw new Error("AMUX protected body envelope is invalid");
  }
  const sealed = validatedIdentity(envelope.identity);
  validatedHandle(envelope.keyHandle);
  if (sealed.bodyId !== requested.bodyId ||
      sealed.ownerId !== requested.ownerId ||
      sealed.purpose !== requested.purpose ||
      sealed.bodyVersion !== requested.bodyVersion) {
    throw new Error("AMUX protected body identity does not match envelope");
  }
}

/** Verifies response shape and request binding only. A provider's destruction
 * claim is not proof that its key versions, replicas, and backups are gone. */
export function assertAmuxKeyDestructionObservation(
  observation: unknown,
  expectedOperationId: string,
  expectedHandle: AmuxExternalKeyHandle,
): asserts observation is AmuxKeyDestructionObservation {
  assertAmuxBodyOperationId(expectedOperationId);
  const expected = validatedHandle(expectedHandle);
  if (!observation || typeof observation !== "object") {
    throw new Error("AMUX key destruction observation is invalid");
  }
  const candidate = observation as Partial<AmuxKeyDestructionObservation>;
  const operationId = candidate.operationId;
  const handle = candidate.keyHandle;
  const state = candidate.state;
  const evidenceDigest = candidate.evidenceDigest;
  if (operationId !== expectedOperationId || !handle ||
      !["active", "pending", "reported_destroyed", "outcome_unknown"].includes(state ?? "") ||
      (evidenceDigest !== null &&
        (typeof evidenceDigest !== "string" || !/^[a-f0-9]{64}$/.test(evidenceDigest)))) {
    throw new Error("AMUX key destruction observation is invalid");
  }
  const actual = validatedHandle(handle);
  if (actual.id !== expected.id || actual.version !== expected.version) {
    throw new Error("AMUX key destruction observation does not match key handle");
  }
}
