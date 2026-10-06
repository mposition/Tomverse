import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
mock.module(mod("lib/adminAudit.ts"), {
  namedExports: { writeSystemAuditLog: async () => {} },
});

const { recordAmuxV22TaskResult, v22TaskResultSha256 } =
  await import(mod("lib/amux/v22TaskResultStore.ts"));

const attemptId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const ideaId = "00000000-0000-4000-8000-000000000003";
const baseSha = "a".repeat(40);
const patchText = "diff --git a/lib/x.ts b/lib/x.ts\n";
const keys = { masterKeyId: "synthetic", masterKeyVersion: 1,
  masterKey: Buffer.alloc(32, 3), digestKeyId: "synthetic-digest",
  digestKey: Buffer.alloc(32, 4) };

async function recordWith(run, assignmentRole = "implement") {
  const saved = { result: null, patch: null };
  const tx = {
    $queryRaw: async (parts) => {
      const sql = parts.join("?");
      if (sql.includes("set_config")) return [{ statement_limit: "5000" }];
      if (sql.includes('FROM "AmuxExecutionAttempt"'))
        return [{ taskId, worker: "worker-1", endedAt: null,
          v22AssignmentId: "assignment-1" }];
      if (sql.includes('FROM "AmuxWorkItem"'))
        return [{ id: taskId, sourceSystem: "admin-idea-v4",
          sourceSnapshot: { schemaVersion: "amux-v4", ideaId },
          status: "doing", owner: "worker-1",
          v22AssignmentId: "assignment-1" }];
      throw new Error(`unexpected SQL: ${sql}`);
    },
    amuxV22WorkerAssignment: { findUnique: async () =>
      ({ role: assignmentRole, workItemId: taskId }) },
    engineeringAgentRun: { findUnique: async () => run },
    amuxV22TaskResult: {
      findUnique: async () => null,
      create: async ({ data }) => { saved.result = data; },
    },
    amuxV22TaskPatch: {
      create: async ({ data }) => { saved.patch = data; },
    },
  };
  const resultText = "Synthetic private Task result";
  const result = await recordAmuxV22TaskResult(tx, {
    attemptId, worker: "worker-1", ideaId, text: resultText,
    sourceSha256: v22TaskResultSha256(resultText), keys,
    patch: { text: patchText, sha256: createHash("sha256")
      .update(patchText).digest("hex"), baseSha, keys },
  });
  assert.ok(saved.result, "the private result is always recorded");
  return { result, saved };
}

for (const [name, run, role, expectedPatch] of [
  ["matching active run", { status: "active", baseSha }, "implement", true],
  ["ended run", { status: "finished", baseSha }, "implement", false],
  ["changed base", { status: "active", baseSha: "b".repeat(40) }, "implement", false],
  ["wrong role", { status: "active", baseSha }, "review", false],
]) {
  const { result, saved } = await recordWith(run, role);
  assert.equal(saved.patch !== null, expectedPatch, name);
  assert.equal(result.patchSha256 !== null, expectedPatch, name);
}

console.log("AMUX_V22_RESULT_STORE_OK");
