import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
const attemptId = "00000000-0000-4000-8000-000000000001";
const ideaId = "00000000-0000-4000-8000-000000000002";
const baseSha = "a".repeat(40);
const resultText = "Synthetic private Task result";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const patchText = "diff --git a/lib/x.ts b/lib/x.ts\n";
const patch = { text: patchText, sha256: sha256(patchText), baseSha };
const received = [];
let savedPatch = false;
let priorResult = null;
let priorPatch = null;
const keys = () => ({ masterKeyId: "synthetic", masterKeyVersion: 1,
  masterKey: Buffer.alloc(32, 3), digestKeyId: "synthetic-digest",
  digestKey: Buffer.alloc(32, 4) });

mock.module(mod("lib/amux/guard.ts"), {
  namedExports: { isAmuxSyncAuthorized: () => true },
});
mock.module(mod("lib/amux/ideaKeyStore.ts"), {
  namedExports: {
    createAmuxContentUnitKeys: async () => keys(),
    loadAmuxContentUnitKeys: async () => keys(),
  },
});
mock.module(mod("lib/amux/v22TaskResultStore.ts"), {
  namedExports: {
    AmuxV22TaskResultError: class extends Error {},
    recordAmuxV22TaskResult: async (_tx, input) => {
      received.push(input);
      return { attemptId, sourceSha256: input.sourceSha256,
        patchSha256: savedPatch ? input.patch?.sha256 ?? null : null,
        duplicate: false };
    },
    readAmuxV22TaskPatchEvidence: async () => null,
    v22TaskResultIdeaId: (snapshot) => snapshot?.ideaId ?? null,
    v22TaskResultSha256: sha256,
  },
});
mock.module(mod("lib/prisma.ts"), {
  namedExports: { prisma: {
    engineeringAgentRun: { findUnique: async () => {
      throw new Error("private patch storage must not read the publication run");
    } },
    amuxV22TaskResult: { findUnique: async () => priorResult },
    amuxV22TaskPatch: { findUnique: async () => priorPatch },
    amuxExecutionAttempt: { findUnique: async () => ({ worker: "worker-1",
      endedAt: null, v22AssignmentId: "assignment-1",
      task: { sourceSystem: "admin-idea-v4",
        sourceSnapshot: { schemaVersion: "amux-v4", ideaId },
        status: "doing", owner: "worker-1",
        v22AssignmentId: "assignment-1" } }) },
    $transaction: async (callback) => callback({}),
  } },
});

const { POST } = await import(mod("app/api/internal/amux/v22/execution/result/route.ts"));
const endpoint = "https://tomverse.test/api/internal/amux/v22/execution/result";
const post = (submittedPatch) => POST(new Request(endpoint, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ attemptId, worker: "worker-1", resultText,
    sourceSha256: sha256(resultText), patch: submittedPatch }),
}));

process.env.TOMVERSE_AMUX_V22_TASK_RESULT_WRITE = "enabled";
const validResponse = await post(patch);
assert.equal(validResponse.status, 200);
const validBody = await validResponse.json();
assert.equal(validBody.patchSha256, null);
assert.equal(validBody.filesDigest, null);
assert.equal(validBody.patchRejected, true);
assert.ok(received[0].patch, "a valid optional patch reaches the store");

savedPatch = true;
const storedResponse = await post(patch);
assert.equal(storedResponse.status, 200);
const storedBody = await storedResponse.json();
assert.equal(storedBody.patchSha256, patch.sha256);
assert.equal(storedBody.patchRejected, false);
assert.equal(storedBody.filesDigest, null);

const { amuxContentDigest } = await import(mod("lib/amux/ideaCrypto.ts"));
const { encodeV22PatchEvidence } = await import(mod("lib/amux/v22PatchEvidence.ts"));
const evidence = encodeV22PatchEvidence(patch.text);
const digest = amuxContentDigest(evidence, "task_patch", attemptId, keys());
priorResult = { sourceSha256: sha256(resultText), bodyPurgedAt: null };
priorPatch = { patchSha256: patch.sha256, baseSha, bodyPurgedAt: null,
  digest: digest.digest, digestKeyId: digest.digestKeyId,
  byteLength: evidence.length, ideaId };
evidence.fill(0);
const duplicateResponse = await post(patch);
assert.equal(duplicateResponse.status, 200);
const duplicateBody = await duplicateResponse.json();
assert.equal(duplicateBody.duplicate, true);
assert.equal(duplicateBody.patchRejected, false);
assert.equal(duplicateBody.patchSha256, patch.sha256);
priorResult = null;
priorPatch = null;

const invalidResponse = await post({ ...patch, sha256: "b".repeat(64) });
assert.equal(invalidResponse.status, 200);
const invalidBody = await invalidResponse.json();
assert.equal(invalidBody.patchSha256, null);
assert.equal(invalidBody.patchRejected, true);
assert.equal(received.at(-1).patch, undefined);

console.log("AMUX_V22_RESULT_ROUTE_POST_OK");
