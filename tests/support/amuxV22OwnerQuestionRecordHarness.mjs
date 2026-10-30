import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
const audits = [];
mock.module(mod("lib/adminAudit.ts"), {
  namedExports: { writeSystemAuditLog: async (entry) => { audits.push(entry); } },
});

const { recordAmuxV22TaskResult, v22TaskResultSha256 } =
  await import(mod("lib/amux/v22TaskResultStore.ts"));
const { AMUX_V22_OWNER_QUESTION_MARKER, amuxV22OwnerQuestionSha256 } =
  await import(mod("lib/amux/v22OwnerQuestionCore.ts"));

const attemptId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const ideaId = "00000000-0000-4000-8000-000000000003";
const keys = { masterKeyId: "synthetic", masterKeyVersion: 1,
  masterKey: Buffer.alloc(32, 3), digestKeyId: "synthetic-digest",
  digestKey: Buffer.alloc(32, 4) };
const question = { question: "Which copy?", unblocks: "the copy",
  options: [{ id: "a", label: "Short" }] };

async function record(text, asked) {
  const created = [];
  const cancelled = [];
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
    amuxV22TaskResult: { findUnique: async () => null, create: async () => {} },
    amuxV22TaskPatch: { findUnique: async () => null, create: async () => {} },
    amuxV22TaskQuestion: {
      findMany: async ({ where }) => {
        assert.deepEqual(where, { taskId });
        return asked;
      },
      create: async ({ data }) => { created.push(data); },
      updateMany: async ({ where, data }) => {
        assert.deepEqual(where, { taskId, state: "open", attemptId: { not: attemptId } });
        assert.deepEqual(data, { state: "cancelled" });
        cancelled.push(where);
        return { count: 0 };
      },
    },
  };
  audits.length = 0;
  await recordAmuxV22TaskResult(tx, { attemptId, worker: "worker-1", ideaId,
    text, sourceSha256: v22TaskResultSha256(text), keys });
  return { created, cancelled, metadata: audits[0]?.metadata };
}

const asking = `Partial work.\n${AMUX_V22_OWNER_QUESTION_MARKER} ${JSON.stringify(question)}`;

// The first question opens; its row keeps the digest, never the text.
let run = await record(asking, []);
assert.equal(run.created.length, 1);
assert.equal(run.created[0].sequence, 1);
assert.equal(run.created[0].state, "open");
assert.equal(run.created[0].attemptId, attemptId);
assert.equal(run.created[0].worker, "worker-1");
assert.equal(run.created[0].questionSha256, amuxV22OwnerQuestionSha256(question));
assert.ok(!JSON.stringify(run.created[0]).includes("Which copy?"));
assert.equal(run.metadata.ownerQuestionSequence, 1);
// A question left open by an earlier, lost attempt is closed first.
assert.equal(run.cancelled.length, 1);

// The fourth is recorded as over the limit.
run = await record(asking, [1, 2, 3].map((sequence) =>
  ({ sequence, state: "resumed" })));
assert.equal(run.created[0].sequence, 4);
assert.equal(run.created[0].state, "cancelled");

// A question while another still waits is not recorded.
for (const state of ["open", "answered"]) {
  run = await record(asking, [{ sequence: 1, state }]);
  assert.equal(run.created.length, 0, state);
  assert.equal(run.metadata.ownerQuestionSequence, null);
}

// A result without the line asks nothing and reads no question rows.
run = await record("All done.", null);
assert.equal(run.created.length, 0);

console.log("AMUX_V22_OWNER_QUESTION_RECORD_OK");
