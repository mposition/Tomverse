import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";

import { inspectAmuxTrackedCheckoutReadManifest,
  parseAmuxTrackedCheckoutReadManifest } from
  "../lib/amux/ideaTrackedCheckoutReadManifestCore.ts";
import { openAmuxContent, sealAmuxContent } from "../lib/amux/ideaCrypto.ts";
import { AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V19_MAX_READ_MANIFEST_CLAIM_BOUND_ACTION,
  AMUX_V19_MAX_READ_MANIFEST_CLAIM_BOUND_SCOPE,
  AMUX_V19_READ_MANIFEST_KEY_INTENT_TARGET,
  auditRowActorKind, systemAuditActionAllowed } from
  "../lib/adminAuditSystemActors.ts";

const valid = () => ({ manifestId: randomUUID(), ideaId: randomUUID(),
  referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40),
  observed: { kind: "verified_success", readFiles: ["src/b.ts", "README.md"] } });

test("Max manifest intent claim binding has one scoped audit action", () => {
  assert.equal(systemAuditActionAllowed(AMUX_V4_IDEA_SYSTEM_ACTOR,
    AMUX_V19_MAX_READ_MANIFEST_CLAIM_BOUND_ACTION,
    AMUX_V19_READ_MANIFEST_KEY_INTENT_TARGET), true);
  assert.equal(systemAuditActionAllowed(AMUX_V4_IDEA_SYSTEM_ACTOR,
    AMUX_V19_MAX_READ_MANIFEST_CLAIM_BOUND_ACTION,
    "AmuxIdeaSubmission"), false);
  assert.equal(auditRowActorKind({
    action: AMUX_V19_MAX_READ_MANIFEST_CLAIM_BOUND_ACTION,
    targetType: AMUX_V19_READ_MANIFEST_KEY_INTENT_TARGET,
    actorUserId: null, actorEmail: null, ipAddress: null, userAgent: null,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V19_MAX_READ_MANIFEST_CLAIM_BOUND_SCOPE },
  }), "system");
});

test("read manifest canonicalizes verified paths without an arbitrary file limit", () => {
  const inspected = inspectAmuxTrackedCheckoutReadManifest(valid());
  assert.ok(inspected);
  assert.deepEqual(inspected.files, ["README.md", "src/b.ts"]);
  assert.deepEqual(parseAmuxTrackedCheckoutReadManifest(inspected.plaintext, 2),
    inspected.files);
  const many = Array.from({ length: 70000 }, (_, i) => `src/file-${i}.ts`);
  const large = inspectAmuxTrackedCheckoutReadManifest({ ...valid(),
    observed: { kind: "verified_success", readFiles: many } });
  assert.equal(large?.files.length, many.length);
  assert.ok(large.plaintext.length > 1024 * 1024);
  const keys = { masterKeyId: "synthetic", masterKeyVersion: 1,
    masterKey: randomBytes(32), digestKeyId: "synthetic-digest",
    digestKey: randomBytes(32) };
  try {
    const sealed = sealAmuxContent(large.plaintext,
      "repository_read_manifest", large.manifestId, keys);
    assert.deepEqual(openAmuxContent(sealed, "repository_read_manifest",
      large.manifestId, keys), large.plaintext);
  } finally { keys.masterKey.fill(0); keys.digestKey.fill(0); }
});

test("read manifest rejects unknown outcomes, duplicate and unsafe paths", () => {
  for (const observed of [
    { kind: "outcome_unknown", readFiles: ["README.md"] },
    { kind: "verified_success", readFiles: ["README.md", "README.md"] },
    { kind: "verified_success", readFiles: ["../secret"] },
    { kind: "verified_success", readFiles: [".git/config"] },
    { kind: "verified_success", readFiles: ["src\\file.ts"] },
  ]) assert.equal(inspectAmuxTrackedCheckoutReadManifest({ ...valid(), observed }), null);
  assert.throws(() => parseAmuxTrackedCheckoutReadManifest(
    Buffer.from('{"version":1,"files":["../secret"]}'), 1),
  /invalid_read_manifest/);
});
