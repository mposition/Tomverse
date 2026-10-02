import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { amuxContentDigest, openAmuxContent, sealAmuxContent,
  verifyAmuxContentDigest } from "../lib/amux/ideaCrypto.ts";

const keys = () => ({
  masterKeyId: "amux-v4-master-test",
  masterKeyVersion: 1,
  masterKey: randomBytes(32),
  digestKeyId: "amux-v4-digest-test",
  digestKey: randomBytes(32),
});

test("AMUX content is sealed with a per-row data key and a subject-bound digest", () => {
  const keyring = keys();
  const raw = Buffer.from("사용자 아이디어: 긴 대화 기능 개선", "utf8");
  const first = sealAmuxContent(raw, "idea_raw", "idea-test-1", keyring);
  const second = sealAmuxContent(raw, "idea_raw", "idea-test-1", keyring);
  const other = sealAmuxContent(raw, "idea_raw", "idea-test-2", keyring);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.digest, second.digest);
  assert.notEqual(first.digest, other.digest);
  assert.deepEqual(openAmuxContent(first, "idea_raw", "idea-test-1", keyring), raw);
  assert.equal(verifyAmuxContentDigest(raw, "idea_raw", "idea-test-1", first.digest, first.digestKeyId, keyring), true);
  assert.equal(verifyAmuxContentDigest(raw, "idea_raw", "idea-test-2", first.digest, first.digestKeyId, keyring), false);
  assert.equal(first.ciphertext.includes(raw), false);
});

test("AMUX content rejects swapped purpose, subject, key, ciphertext and digest", () => {
  const keyring = keys();
  const sealed = sealAmuxContent(Buffer.from("synthetic-only"), "card_brief", "card-test-1", keyring);
  assert.throws(() => openAmuxContent(sealed, "card_title", "card-test-1", keyring));
  assert.throws(() => openAmuxContent(sealed, "card_brief", "card-test-2", keyring));
  assert.throws(() => openAmuxContent(sealed, "card_brief", "card-test-1", keys()));
  const modified = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
  modified.ciphertext[modified.ciphertext.length - 1] ^= 1;
  assert.throws(() => openAmuxContent(modified, "card_brief", "card-test-1", keyring));
  assert.deepEqual(openAmuxContent({ ...sealed, digest: "0".repeat(64) }, "card_brief", "card-test-1", keyring), Buffer.from("synthetic-only"));
  assert.equal(verifyAmuxContentDigest(Buffer.from("synthetic-only"), "card_brief", "card-test-1", "0".repeat(64), sealed.digestKeyId, keyring), false);
  assert.throws(() => openAmuxContent({ ...sealed, keyVersion: 2 }, "card_brief", "card-test-1", keyring));
  assert.throws(() => openAmuxContent({ ...sealed, keyId: "different-key" }, "card_brief", "card-test-1", keyring));
  assert.throws(() => openAmuxContent(
    { ...sealed, keyId: "different-key" }, "card_brief", "card-test-1",
    { ...keyring, masterKeyId: "different-key" },
  ));
  assert.throws(() => openAmuxContent(
    { ...sealed, keyVersion: 2 }, "card_brief", "card-test-1",
    { ...keyring, masterKeyVersion: 2 },
  ));
  const digestOnlyChanged = { ...keyring, digestKey: randomBytes(32) };
  assert.deepEqual(openAmuxContent(sealed, "card_brief", "card-test-1", digestOnlyChanged), Buffer.from("synthetic-only"));
  assert.equal(verifyAmuxContentDigest(Buffer.from("synthetic-only"), "card_brief", "card-test-1", sealed.digest, sealed.digestKeyId, digestOnlyChanged), false);
});

test("AMUX content fails closed on missing key configuration and oversized input", () => {
  const keyring = keys();
  assert.throws(() => sealAmuxContent(Buffer.from("x"), "idea_raw", "../idea", keyring));
  assert.throws(() => sealAmuxContent(Buffer.from("x"), "idea_raw\0bad", "idea-test-1", keyring));
  assert.throws(() => sealAmuxContent(Buffer.from("x"), "idea_raw", "idea-test-1", {
    ...keyring,
    digestKeyId: "",
  }));
  assert.throws(() => sealAmuxContent(Buffer.alloc(1024 * 1024 + 1), "idea_raw", "idea-test-1", keyring));
  assert.deepEqual(openAmuxContent(sealAmuxContent(Buffer.alloc(0), "idea_raw", "idea-test-1", keyring), "idea_raw", "idea-test-1", keyring), Buffer.alloc(0));
  assert.deepEqual(openAmuxContent(sealAmuxContent(Buffer.alloc(1024 * 1024), "idea_raw", "idea-test-1", keyring), "idea_raw", "idea-test-1", keyring), Buffer.alloc(1024 * 1024));
});

test("read-only scope preview digest binds exact bytes, purpose and idea", () => {
  const keyring = keys();
  const bytes = Buffer.from('{"version":1,"sources":[]}', "utf8");
  const binding = amuxContentDigest(bytes, "source_scope", "idea-test-1", keyring);
  assert.equal(binding.digestKeyId, keyring.digestKeyId);
  assert.equal(verifyAmuxContentDigest(bytes, "source_scope", "idea-test-1",
    binding.digest, binding.digestKeyId, keyring), true);
  assert.equal(verifyAmuxContentDigest(bytes, "source_scope", "idea-test-2",
    binding.digest, binding.digestKeyId, keyring), false);
  assert.equal(verifyAmuxContentDigest(bytes, "idea_raw", "idea-test-1",
    binding.digest, binding.digestKeyId, keyring), false);
  assert.equal(verifyAmuxContentDigest(Buffer.from('{"version":2,"sources":[]}', "utf8"),
    "source_scope", "idea-test-1", binding.digest, binding.digestKeyId, keyring), false);
});

test("AMUX envelope header and each authenticated segment reject tampering", () => {
  const keyring = keys();
  const sealed = sealAmuxContent(Buffer.from("synthetic"), "analysis_draft", "idea-test-1:0", keyring);
  for (const index of [0, 4, 5, 17, 33, 65, 77, 93]) {
    const modified = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    modified.ciphertext[index] ^= 1;
    assert.throws(() => openAmuxContent(modified, "analysis_draft", "idea-test-1:0", keyring), `byte ${index}`);
  }
  assert.throws(() => openAmuxContent({ ...sealed, ciphertext: sealed.ciphertext.subarray(0, 92) }, "analysis_draft", "idea-test-1:0", keyring));
});
