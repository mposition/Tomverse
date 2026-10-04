import { createHmac, timingSafeEqual, type Hmac } from "node:crypto";

import type { AmuxDigestKey } from "./ideaCrypto.ts";

/** Per-unit ceiling only. The transfer preview must separately enforce its
 * 8 KiB total excerpt cap, including every unit selected for that turn. */
export const AMUX_SOURCE_PLAN_UNIT_MAX_BYTES = 8_192;

export type AmuxSourcePlanUnit = {
  sourceKind: "operator_idea" | "approved_excerpt" | "owner_answer";
  sourceReceiptDigest: string;
  bytes: Buffer;
};

export type AmuxSourcePlanManifestInput = {
  ideaId: string;
  actorUserId: string;
  revisionId: string;
  revisionNumber: number;
  startChunkIndex: number;
  predecessorId: string | null;
  orderedUnits: AmuxSourcePlanUnit[];
};

export type AmuxSourcePlanManifest = {
  sourceUnitCount: number;
  /** Never use a unit digest alone as approval evidence; header identity is
   * bound only by manifestDigest over the entire ordered array. */
  unitDigests: string[];
  manifestDigest: string;
  manifestDigestKeyId: string;
};

export type AmuxSourcePlanManifestDecision =
  | { decision: "ready"; manifest: AmuxSourcePlanManifest }
  | { decision: "hold"; reason: "invalid_identity" | "invalid_key" | "invalid_units" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTOR_ID = /^[A-Za-z0-9:_-]{1,160}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_DB_INT = 2_147_483_647;
const SOURCE_KINDS = new Set(["operator_idea", "approved_excerpt", "owner_answer"]);
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const TYPED_ARRAY_OFFSET = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;

const exactRecord = (value: unknown, keys: readonly string[]): Record<string, unknown> | null => {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length ||
        !keys.every((key) => Object.hasOwn(descriptors, key) && "value" in descriptors[key])) {
      return null;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) result[key] = descriptors[key].value;
    return result;
  } catch {
    return null;
  }
};

/** AmuxContentKeys may contain master-key fields as well. Only the two own
 * data properties needed here are read; accessor-backed credentials fail. */
const digestKeyRecord = (value: unknown): Record<"digestKeyId" | "digestKey", unknown> | null => {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!("value" in (descriptors.digestKeyId ?? {})) ||
        !("value" in (descriptors.digestKey ?? {}))) return null;
    return { digestKeyId: descriptors.digestKeyId.value,
      digestKey: descriptors.digestKey.value };
  } catch {
    return null;
  }
};

const ownArray = (value: unknown): unknown[] | null => {
  try {
    if (!Array.isArray(value)) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_DB_INT ||
        Reflect.ownKeys(value).length !== length + 1) return null;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !("value" in descriptor)) return null;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
};

const dbIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DB_INT;

/** Copy through captured TypedArray intrinsics, not Buffer.from(buffer),
 * which consults a caller-owned valueOf method before copying. */
const copyPlainBuffer = (raw: unknown, maxBytes: number): Buffer | null => {
  try {
    if (!Buffer.isBuffer(raw) || Object.getPrototypeOf(raw) !== Buffer.prototype ||
        !TYPED_ARRAY_BUFFER || !TYPED_ARRAY_OFFSET || !TYPED_ARRAY_LENGTH) return null;
    const length = TYPED_ARRAY_LENGTH.call(raw) as number;
    if (!Number.isSafeInteger(length) || length < 1 || length > maxBytes) return null;
    const ownKeys = Reflect.ownKeys(raw);
    if (ownKeys.length !== length || ownKeys.some((key, index) => key !== String(index))) return null;
    const backing = TYPED_ARRAY_BUFFER.call(raw) as ArrayBuffer;
    if (typeof SharedArrayBuffer !== "undefined" && backing instanceof SharedArrayBuffer) return null;
    const offset = TYPED_ARRAY_OFFSET.call(raw) as number;
    const copy = Buffer.allocUnsafe(length);
    TYPED_ARRAY_SET.call(copy, new Uint8Array(backing, offset, length));
    return copy;
  } catch {
    return null;
  }
};

const field = (hmac: Hmac, bytes: Buffer): void => {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hmac.update(length).update(bytes);
};

const textField = (hmac: Hmac, value: string): void => field(hmac, Buffer.from(value, "utf8"));

const integerField = (hmac: Hmac, value: number): void => {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  field(hmac, bytes);
};

const digestEquals = (left: string, right: string): boolean =>
  DIGEST.test(left) && DIGEST.test(right) &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

/** Hash only exact, already-confirmed bytes. The caller still must prove the
 * source receipt, preview, current-plan pointer and owner audit in one writer
 * transaction. This helper authorizes no transfer, DB write or CLI call. */
export function buildAmuxSourcePlanManifest(
  raw: unknown,
  key: AmuxDigestKey,
): AmuxSourcePlanManifestDecision {
  const input = exactRecord(raw, ["ideaId", "actorUserId", "revisionId", "revisionNumber",
    "startChunkIndex", "predecessorId", "orderedUnits"]);
  if (!input || typeof input.ideaId !== "string" || !UUID.test(input.ideaId) ||
      typeof input.revisionId !== "string" || !UUID.test(input.revisionId) ||
      typeof input.actorUserId !== "string" || !ACTOR_ID.test(input.actorUserId) ||
      !dbIndex(input.revisionNumber) || input.revisionNumber < 1 ||
      !dbIndex(input.startChunkIndex) ||
      (input.revisionNumber === 1 && (input.predecessorId !== null || input.startChunkIndex !== 0)) ||
      (input.revisionNumber > 1 &&
       (typeof input.predecessorId !== "string" || !UUID.test(input.predecessorId) ||
        input.predecessorId === input.revisionId || input.startChunkIndex === 0))) {
    return { decision: "hold", reason: "invalid_identity" };
  }
  const keyRecord = digestKeyRecord(key);
  if (!keyRecord || typeof keyRecord.digestKeyId !== "string" ||
      !KEY_ID.test(keyRecord.digestKeyId)) {
    return { decision: "hold", reason: "invalid_key" };
  }
  const digestKey = copyPlainBuffer(keyRecord.digestKey, 32);
  if (!digestKey || digestKey.length !== 32) return { decision: "hold", reason: "invalid_key" };
  const digestKeyId = keyRecord.digestKeyId;
  const sourceKey = createHmac("sha256", digestKey)
    .update("amux-v4-source-plan-subkey-v1", "ascii").digest();
  try {
    const units = ownArray(input.orderedUnits);
    if (!units) return { decision: "hold", reason: "invalid_units" };

    const unitDigests: string[] = [];
    for (const [ordinal, rawUnit] of units.entries()) {
      const unit = exactRecord(rawUnit, ["sourceKind", "sourceReceiptDigest", "bytes"]);
      if (!unit || typeof unit.sourceKind !== "string" || !SOURCE_KINDS.has(unit.sourceKind) ||
          typeof unit.sourceReceiptDigest !== "string" || !DIGEST.test(unit.sourceReceiptDigest)) {
        return { decision: "hold", reason: "invalid_units" };
      }
      // Copy a potentially mutable caller-owned Buffer before hashing this unit.
      const exactBytes = copyPlainBuffer(unit.bytes, AMUX_SOURCE_PLAN_UNIT_MAX_BYTES);
      if (!exactBytes) return { decision: "hold", reason: "invalid_units" };
      try {
        const hmac = createHmac("sha256", sourceKey);
        textField(hmac, "amux-v4-source-unit-v1");
        textField(hmac, input.ideaId);
        textField(hmac, input.revisionId);
        integerField(hmac, ordinal);
        textField(hmac, unit.sourceKind);
        field(hmac, Buffer.from(unit.sourceReceiptDigest, "hex"));
        field(hmac, exactBytes);
        unitDigests.push(hmac.digest("hex"));
      } finally {
        exactBytes.fill(0);
      }
    }

    const hmac = createHmac("sha256", sourceKey);
    textField(hmac, "amux-v4-source-manifest-v1");
    textField(hmac, input.ideaId);
    textField(hmac, input.actorUserId);
    textField(hmac, input.revisionId);
    integerField(hmac, input.revisionNumber);
    integerField(hmac, input.startChunkIndex);
    textField(hmac, typeof input.predecessorId === "string" ? input.predecessorId : "");
    integerField(hmac, unitDigests.length);
    for (const digest of unitDigests) field(hmac, Buffer.from(digest, "hex"));
    return { decision: "ready", manifest: {
      sourceUnitCount: unitDigests.length,
      unitDigests,
      manifestDigest: hmac.digest("hex"),
      manifestDigestKeyId: digestKeyId,
    } };
  } finally {
    sourceKey.fill(0);
    digestKey.fill(0);
  }
}

/** Recompute from the confirmed exact bytes; never trust a stored manifest
 * string as evidence that its source was owner-approved. */
export function verifyAmuxSourcePlanManifest(
  raw: unknown,
  expectedRaw: unknown,
  key: AmuxDigestKey,
): boolean {
  const expected = exactRecord(expectedRaw, ["sourceUnitCount", "unitDigests",
    "manifestDigest", "manifestDigestKeyId"]);
  const keyRecord = digestKeyRecord(key);
  if (!expected || !dbIndex(expected.sourceUnitCount) ||
      typeof expected.manifestDigest !== "string" || !DIGEST.test(expected.manifestDigest) ||
      !keyRecord || expected.manifestDigestKeyId !== keyRecord.digestKeyId) return false;
  const expectedUnits = ownArray(expected.unitDigests);
  if (!expectedUnits || expectedUnits.length !== expected.sourceUnitCount ||
      !expectedUnits.every((entry) => typeof entry === "string" && DIGEST.test(entry))) return false;
  const calculated = buildAmuxSourcePlanManifest(raw, key);
  if (calculated.decision !== "ready" ||
      calculated.manifest.sourceUnitCount !== expected.sourceUnitCount ||
      calculated.manifest.manifestDigestKeyId !== expected.manifestDigestKeyId ||
      !digestEquals(calculated.manifest.manifestDigest, expected.manifestDigest)) return false;
  return calculated.manifest.unitDigests.every((digest, index) =>
    digestEquals(digest, expectedUnits[index] as string));
}
