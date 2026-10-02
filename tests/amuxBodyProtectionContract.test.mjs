import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";

import {
  AMUX_EXTERNAL_BODY_FORMAT,
  amuxProtectedBodyAad,
  assertAmuxBodyOperationId,
  assertAmuxBodyPlaintext,
  assertAmuxEnvelopeBinding,
  assertAmuxExternalKeyHandle,
  assertAmuxKeyDestructionObservation,
  assertAmuxProtectedBodyIdentity,
} from "../lib/amux/bodyProtectionContract.ts";

// Synthetic memory-only port. It is not a provider adapter or backup deletion proof.
function fakeBodyProtectionPort({ loseFirstDestructionResponse = false, unknownInspectionOnce = false } = {}) {
  const keys = new Map();
  const destroyed = new Map();
  const seals = new Map();
  let loseResponse = loseFirstDestructionResponse;
  let loseInspection = unknownInspectionOnce;
  return {
    async seal({ identity, plaintext, requestId }) {
      assertAmuxBodyPlaintext(plaintext);
      assertAmuxBodyOperationId(requestId);
      const fingerprint = createHash("sha256")
        .update(amuxProtectedBodyAad(identity, { id: "synthetic-seal", version: 1 }))
        .update(plaintext).digest("hex");
      const existing = seals.get(requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("seal idempotency conflict");
        return existing.envelope;
      }
      const keyHandle = { id: randomBytes(16).toString("hex"), version: 1 };
      const key = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(amuxProtectedBodyAad(identity, keyHandle));
      const ciphertext = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      keys.set(keyHandle.id, key);
      const envelope = { format: AMUX_EXTERNAL_BODY_FORMAT, identity: { ...identity }, keyHandle, ciphertext };
      seals.set(requestId, { fingerprint, envelope });
      return envelope;
    },
    async open({ identity, envelope }) {
      assertAmuxEnvelopeBinding(envelope, identity);
      const key = keys.get(envelope.keyHandle.id);
      if (!key) throw new Error("key unavailable");
      const bytes = envelope.ciphertext;
      const iv = bytes.subarray(0, 12);
      const tag = bytes.subarray(bytes.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(amuxProtectedBodyAad(identity, envelope.keyHandle));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    },
    async requestDestruction({ identity, envelope, operationId }) {
      assertAmuxEnvelopeBinding(envelope, identity);
      assertAmuxBodyOperationId(operationId);
      const existing = destroyed.get(envelope.keyHandle.id);
      if (existing && existing.operationId !== operationId) throw new Error("operation mismatch");
      if (!existing) {
        const key = keys.get(envelope.keyHandle.id);
        if (!key) throw new Error("key unavailable");
        key.fill(0);
        keys.delete(envelope.keyHandle.id);
        destroyed.set(envelope.keyHandle.id, { operationId });
      }
      if (loseResponse) {
        loseResponse = false;
        throw new Error("synthetic timeout after destruction");
      }
      return this.inspectDestruction({ identity, envelope, operationId });
    },
    async inspectDestruction({ identity, envelope, operationId }) {
      assertAmuxEnvelopeBinding(envelope, identity);
      assertAmuxBodyOperationId(operationId);
      const record = destroyed.get(envelope.keyHandle.id);
      if (loseInspection) {
        loseInspection = false;
        return { operationId, keyHandle: envelope.keyHandle, state: "outcome_unknown", evidenceDigest: null };
      }
      if (record && record.operationId !== operationId) {
        return { operationId, keyHandle: envelope.keyHandle, state: "outcome_unknown", evidenceDigest: null };
      }
      if (!record && keys.has(envelope.keyHandle.id)) {
        return { operationId, keyHandle: envelope.keyHandle, state: "active", evidenceDigest: null };
      }
      if (!record) {
        return { operationId, keyHandle: envelope.keyHandle, state: "outcome_unknown", evidenceDigest: null };
      }
      return {
        operationId,
        keyHandle: envelope.keyHandle,
        state: "reported_destroyed",
        evidenceDigest: null, // No external provider proof exists in this synthetic fake.
      };
    },
  };
}

const identity = () => ({ bodyId: "idea-1:raw", ownerId: "owner-1", purpose: "idea_raw", bodyVersion: 1 });

test("AMUX external body AAD binds owner, body, purpose, version and handle", () => {
  const base = identity();
  const handle = { id: "key-1", version: 1 };
  const value = amuxProtectedBodyAad(base, handle);
  for (const changed of [
    [{ ...base, ownerId: "owner-2" }, handle],
    [{ ...base, bodyId: "idea-2:raw" }, handle],
    [{ ...base, purpose: "card_brief" }, handle],
    [{ ...base, bodyVersion: 2 }, handle],
    [base, { ...handle, id: "key-2" }],
    [base, { ...handle, version: 2 }],
  ]) {
    assert.notDeepEqual(amuxProtectedBodyAad(...changed), value);
  }
  let bodyReads = 0;
  const withGetter = {
    ...base,
    get bodyId() {
      bodyReads += 1;
      return bodyReads === 1 ? base.bodyId : "idea-2:raw";
    },
  };
  assert.deepEqual(amuxProtectedBodyAad(withGetter, handle), value);
  assert.equal(bodyReads, 1);
});

test("AMUX external body contract rejects invalid or swapped identities and handles", () => {
  assert.throws(() => assertAmuxProtectedBodyIdentity({ ...identity(), bodyId: "../idea" }));
  assert.throws(() => assertAmuxProtectedBodyIdentity({ ...identity(), bodyId: "idea\0other" }));
  assert.throws(() => assertAmuxProtectedBodyIdentity({ ...identity(), ownerId: 2 }));
  assert.throws(() => assertAmuxProtectedBodyIdentity({ ...identity(), bodyVersion: 0 }));
  assert.throws(() => assertAmuxProtectedBodyIdentity({ ...identity(), purpose: "other" }));
  assert.throws(() => assertAmuxExternalKeyHandle({ id: "key\0bad", version: 1 }));
  assert.throws(() => assertAmuxExternalKeyHandle({ id: "key-1", version: -1 }));
  assert.throws(() => assertAmuxBodyOperationId("../operation"));
  assert.throws(() => assertAmuxBodyPlaintext(Buffer.alloc(1024 * 1024 + 1)));
  assertAmuxBodyPlaintext(Buffer.alloc(1024 * 1024));
  const envelope = {
    format: AMUX_EXTERNAL_BODY_FORMAT,
    identity: identity(),
    keyHandle: { id: "key-1", version: 1 },
    ciphertext: Buffer.from("ciphertext"),
  };
  assertAmuxEnvelopeBinding(envelope, identity());
  assert.throws(() => assertAmuxEnvelopeBinding(envelope, { ...identity(), ownerId: "owner-2" }), /identity does not match envelope/);
  assert.throws(() => assertAmuxEnvelopeBinding({ ...envelope, format: "AMX4" }, identity()));
  assert.throws(() => assertAmuxEnvelopeBinding({ ...envelope, ciphertext: Buffer.alloc(0) }, identity()));
  assert.throws(() => assertAmuxEnvelopeBinding({ ...envelope, ciphertext: Buffer.alloc(2 * 1024 * 1024 + 1) }, identity()));
});

test("synthetic in-memory revocation makes a ciphertext copy unreadable within this fake", async () => {
  const port = fakeBodyProtectionPort();
  const body = identity();
  const raw = Buffer.from("synthetic AMUX idea", "utf8");
  const envelope = await port.seal({ identity: body, plaintext: raw, requestId: "seal-1" });
  assert.strictEqual(await port.seal({ identity: body, plaintext: raw, requestId: "seal-1" }), envelope);
  await assert.rejects(port.seal({ identity: body, plaintext: Buffer.from("different"), requestId: "seal-1" }), /idempotency conflict/);
  const backupCopy = { ...envelope, ciphertext: Buffer.from(envelope.ciphertext) };
  assert.deepEqual(await port.open({ identity: body, envelope: backupCopy }), raw);
  await assert.rejects(port.open({ identity: { ...body, ownerId: "owner-2" }, envelope: backupCopy }), /identity does not match envelope/);
  const receipt = await port.requestDestruction({ identity: body, envelope, operationId: "revoke-1" });
  assert.equal(receipt.state, "reported_destroyed");
  assert.equal(receipt.evidenceDigest, null);
  assert.deepEqual(
    await port.inspectDestruction({ identity: body, envelope, operationId: "revoke-1" }),
    receipt,
  );
  assert.deepEqual(await port.requestDestruction({ identity: body, envelope, operationId: "revoke-1" }), receipt);
  assert.equal((await port.inspectDestruction({ identity: body, envelope, operationId: "revoke-2" })).state, "outcome_unknown");
  await assert.rejects(port.open({ identity: body, envelope: backupCopy }), /key unavailable/);
  await assert.rejects(port.requestDestruction({ identity: body, envelope, operationId: "revoke-2" }), /operation mismatch/);
});

test("synthetic cipher authentication rejects consistently swapped fields and bytes", async () => {
  const port = fakeBodyProtectionPort();
  const body = identity();
  const envelope = await port.seal({ identity: body, plaintext: Buffer.from("synthetic"), requestId: "seal-1" });
  for (const altered of [
    { ...body, ownerId: "owner-2" },
    { ...body, bodyId: "idea-2:raw" },
    { ...body, purpose: "card_brief" },
    { ...body, bodyVersion: 2 },
  ]) {
    await assert.rejects(
      port.open({ identity: altered, envelope: { ...envelope, identity: altered } }),
      /authenticat|Unsupported state/,
    );
  }
  await assert.rejects(
    port.open({ identity: body, envelope: { ...envelope, keyHandle: { ...envelope.keyHandle, version: 2 } } }),
    /authenticat|Unsupported state/,
  );
  const tampered = { ...envelope, ciphertext: Buffer.from(envelope.ciphertext) };
  tampered.ciphertext[tampered.ciphertext.length - 1] ^= 1;
  await assert.rejects(port.open({ identity: body, envelope: tampered }), /authenticat|Unsupported state/);
});

test("a missing destruction observation is not successful destruction", async () => {
  const port = fakeBodyProtectionPort();
  const body = identity();
  const envelope = await port.seal({ identity: body, plaintext: Buffer.from("synthetic"), requestId: "seal-1" });
  const observation = await port.inspectDestruction({ identity: body, envelope, operationId: "revoke-1" });
  assert.equal(observation.state, "active");
  assert.equal(observation.evidenceDigest, null);
  assert.deepEqual(await port.open({ identity: body, envelope }), Buffer.from("synthetic"));
});

test("destruction observations must match the operation and handle without implying proof", () => {
  const handle = { id: "key-1", version: 1 };
  const pending = { operationId: "revoke-1", keyHandle: handle, state: "pending", evidenceDigest: null };
  assertAmuxKeyDestructionObservation(pending, "revoke-1", handle);
  assertAmuxKeyDestructionObservation({ ...pending, state: "outcome_unknown" }, "revoke-1", handle);
  assertAmuxKeyDestructionObservation({ ...pending, state: "reported_destroyed" }, "revoke-1", handle);
  assert.throws(() => assertAmuxKeyDestructionObservation({ ...pending, operationId: "revoke-2" }, "revoke-1", handle));
  assert.throws(() => assertAmuxKeyDestructionObservation({ ...pending, keyHandle: { ...handle, id: "key-2" } }, "revoke-1", handle));
  assert.throws(() => assertAmuxKeyDestructionObservation({ ...pending, keyHandle: { ...handle, version: 2 } }, "revoke-1", handle));
  assert.throws(() => assertAmuxKeyDestructionObservation({ ...pending, state: "verified_destroyed" }, "revoke-1", handle));
  assert.throws(() => assertAmuxKeyDestructionObservation({ ...pending, evidenceDigest: undefined }, "revoke-1", handle));
});

test("uncertain synthetic destruction stops until read-back resolves the same operation", async () => {
  const port = fakeBodyProtectionPort({ loseFirstDestructionResponse: true, unknownInspectionOnce: true });
  const body = identity();
  const envelope = await port.seal({ identity: body, plaintext: Buffer.from("synthetic"), requestId: "seal-1" });
  await assert.rejects(
    port.requestDestruction({ identity: body, envelope, operationId: "revoke-1" }),
    /synthetic timeout/,
  );
  const unresolved = await port.inspectDestruction({ identity: body, envelope, operationId: "revoke-1" });
  assert.equal(unresolved.state, "outcome_unknown");
  assert.notEqual(unresolved.state, "reported_destroyed");
  const resolved = await port.inspectDestruction({ identity: body, envelope, operationId: "revoke-1" });
  assert.equal(resolved.state, "reported_destroyed");
  assert.equal(resolved.evidenceDigest, null);
  assert.deepEqual(await port.requestDestruction({ identity: body, envelope, operationId: "revoke-1" }), resolved);
});
