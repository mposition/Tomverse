import assert from "node:assert/strict";
import test from "node:test";

import { loadEngineeringAgentV22SettlementPatch } from
  "../lib/engineeringAgentV22SettlementPatch.ts";

const attemptId = "29cf907f-2741-4dd1-b6d4-d85c881eb357";
const row = { taskId: "card-1", baseSha: "a".repeat(40),
  bodyPurgedAt: null };
const evidence = { text: "diff --git a/x b/x\n", files: null,
  sha256: "b".repeat(64), baseSha: row.baseSha };
const ports = (overrides = {}) => ({
  readMeta: async () => row,
  readEvidence: async () => evidence,
  ...overrides,
});

test("settlement patch is read before the transaction and bound to the card and base", async () => {
  let read = 0;
  assert.deepEqual(await loadEngineeringAgentV22SettlementPatch(attemptId,
    ports({ readEvidence: async (attempt, card) => {
      assert.equal(attempt, attemptId);
      assert.equal(card, row.taskId);
      read++;
      return evidence;
    } })), { taskId: row.taskId, ...evidence, paths: null });
  assert.equal(read, 1);
});

// Owner decision 2026-11-15: the v52 inventory check covers every path the
// patch text names, not only the (at most five) files an older sidecar
// stored bytes for.
test("the settlement patch names every path its text changes, both sides of a rename", async () => {
  const text = ["diff --git a/lib/a.ts b/lib/a.ts",
    "deleted file mode 100644",
    "index 0123456..0000000",
    "--- a/lib/a.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-a",
    "diff --git a/lib/old.ts b/lib/new.ts",
    "similarity index 100%",
    "rename from lib/old.ts",
    "rename to lib/new.ts"].join("\n") + "\n";
  const value = await loadEngineeringAgentV22SettlementPatch(attemptId,
    ports({ readEvidence: async () => ({ ...evidence, text,
      files: [{ path: "lib/stored.ts", mode: "100644", bytesBase64: "YQ==" }] }) }));
  assert.deepEqual(value.paths.map((entry) => entry.path).sort(),
    ["lib/a.ts", "lib/new.ts", "lib/old.ts", "lib/stored.ts"]);
});

test("missing patch is a private result, but purged or corrupt patch blocks settlement", async () => {
  let read = 0;
  assert.equal(await loadEngineeringAgentV22SettlementPatch(attemptId,
    ports({ readMeta: async () => null,
      readEvidence: async () => { read++; return evidence; } })), null);
  assert.equal(read, 0);
  await assert.rejects(loadEngineeringAgentV22SettlementPatch(attemptId,
    ports({ readMeta: async () => ({ ...row, bodyPurgedAt: new Date() }) })),
  /v22_patch_purged_before_settlement/);
  await assert.rejects(loadEngineeringAgentV22SettlementPatch(attemptId,
    ports({ readEvidence: async () => null })),
  /v22_patch_unavailable_before_settlement/);
  await assert.rejects(loadEngineeringAgentV22SettlementPatch(attemptId,
    ports({ readEvidence: async () => ({ ...evidence,
      baseSha: "c".repeat(40) }) })),
  /v22_patch_unavailable_before_settlement/);
});
