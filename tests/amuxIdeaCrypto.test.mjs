import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { AMUX_CONTENT_UNIT_MAX_BYTES, AMUX_TASK_RESULT_UNIT_MAX_BYTES, openAmuxContent, sealAmuxContent,
  verifyAmuxContentDigest } from "../lib/amux/ideaCrypto.ts";
import { AMUX_INTAKE_SAFETY_MAX_BYTES } from "../lib/amux/intakeLimitsCore.ts";
import { AMUX_V22_TRANSPORT_MAX_BYTES } from "../lib/amux/v22LocalCliFlowCore.ts";

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

test("idea raw content has no crypto byte ceiling while other purposes stay bounded", () => {
  const keyring = keys();
  const raw = Buffer.alloc(1024 * 1024 + 257, 0x61);
  const sealed = sealAmuxContent(raw, "idea_raw", "idea-large-test-1", keyring);
  assert.deepEqual(openAmuxContent(
    sealed, "idea_raw", "idea-large-test-1", keyring,
  ), raw);
  assert.equal(verifyAmuxContentDigest(
    raw, "idea_raw", "idea-large-test-1", sealed.digest, sealed.digestKeyId, keyring,
  ), true);
  const changed = Buffer.from(raw);
  changed[changed.length - 1] ^= 1;
  assert.equal(verifyAmuxContentDigest(
    changed, "idea_raw", "idea-large-test-1", sealed.digest, sealed.digestKeyId, keyring,
  ), false);
  const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
  tampered.ciphertext[tampered.ciphertext.length - 1] ^= 1;
  assert.throws(() => openAmuxContent(
    tampered, "idea_raw", "idea-large-test-1", keyring,
  ));
  // Past the 4 MiB unit backstop, a bounded purpose is refused; raw is not.
  const huge = Buffer.alloc(AMUX_CONTENT_UNIT_MAX_BYTES + 257, 0x61);
  assert.equal(openAmuxContent(sealAmuxContent(huge, "idea_raw", "idea-large-test-1", keyring),
    "idea_raw", "idea-large-test-1", keyring).length, huge.length);
  assert.throws(() => sealAmuxContent(
    huge, "source_scope", "idea-large-test-1", keyring,
  ));
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

test("AMUX content fails closed on missing key configuration and oversized bounded content", () => {
  const keyring = keys();
  assert.throws(() => sealAmuxContent(Buffer.from("x"), "idea_raw", "../idea", keyring));
  assert.throws(() => sealAmuxContent(Buffer.from("x"), "idea_raw\0bad", "idea-test-1", keyring));
  assert.throws(() => sealAmuxContent(Buffer.from("x"), "idea_raw", "idea-test-1", {
    ...keyring,
    digestKeyId: "",
  }));
  // One sealed unit's backstop (owner decision 2026-11-15): the intake flow's
  // 4 MiB ceiling for its purposes, the v22 transport backstop for a report.
  assert.equal(AMUX_CONTENT_UNIT_MAX_BYTES, AMUX_INTAKE_SAFETY_MAX_BYTES);
  assert.equal(AMUX_TASK_RESULT_UNIT_MAX_BYTES, AMUX_V22_TRANSPORT_MAX_BYTES);
  const analysis = Buffer.alloc(3 * 1024 * 1024, 0x61);
  assert.deepEqual(openAmuxContent(sealAmuxContent(analysis, "analysis_result", "claim-test-1", keyring),
    "analysis_result", "claim-test-1", keyring), analysis, "an analysis answer past the old 1 MiB unit is sealed");
  assert.throws(() => sealAmuxContent(
    Buffer.alloc(AMUX_CONTENT_UNIT_MAX_BYTES + 1), "card_brief", "card-test-1", keyring,
  ));
  const report = Buffer.alloc(AMUX_CONTENT_UNIT_MAX_BYTES + 1, 0x62);
  assert.equal(openAmuxContent(sealAmuxContent(report, "task_result", "attempt-test-1", keyring),
    "task_result", "attempt-test-1", keyring).length, report.length, "a v22 report past 4 MiB is sealed");
  assert.throws(() => sealAmuxContent(
    Buffer.alloc(AMUX_TASK_RESULT_UNIT_MAX_BYTES + 1), "task_result", "attempt-test-1", keyring,
  ));
  assert.deepEqual(openAmuxContent(sealAmuxContent(Buffer.alloc(0), "idea_raw", "idea-test-1", keyring), "idea_raw", "idea-test-1", keyring), Buffer.alloc(0));
  assert.deepEqual(openAmuxContent(sealAmuxContent(Buffer.alloc(1024 * 1024), "idea_raw", "idea-test-1", keyring), "idea_raw", "idea-test-1", keyring), Buffer.alloc(1024 * 1024));
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
