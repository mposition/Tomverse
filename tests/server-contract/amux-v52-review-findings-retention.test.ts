import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// Owner decision 2026-11-15: a rejected review's sealed findings live as long
// as the attempt's result (90 days after the Task ends) and go with it: the
// purge clears the body and queues the key's deletion in the same
// transaction, and a findings row that does not match its key stops the purge.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const attemptId = "00000000-0000-4000-8000-0000000000a1";
const taskId = "c48886b9-86f8-4631-8db8-c0b288a707af";
const ideaId = "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

let keyStore: typeof import("../../lib/amux/ideaKeyStore.ts");
const load = async () => { keyStore ??= await import(mod("lib/amux/ideaKeyStore.ts")); };
const id = (purpose: string) => keyStore.amuxContentUnitKeyId({ ideaId,
  purpose: purpose as never, subjectId: attemptId });

let findingsRow: Record<string, unknown> | null = null;
let patchRow: Record<string, unknown> | null = null;
let cleared: Array<{ model: string; data: Record<string, unknown> }> = [];
let purges: Array<{ purpose: string; digest?: string }> = [];
let lockedTables: string[] = [];

const result = () => ({ attemptId, taskId, ideaId, ciphertext: new Uint8Array([1]),
  keyId: id("task_result"), keyVersion: 1, digest: "a".repeat(64), digestKeyId: "dk",
  bodyPurgedAt: null, createdAt: new Date("2026-06-01T00:00:00.000Z") });

const tx = {
  $queryRaw: async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("clock_timestamp")) return [{ now: new Date("2026-11-15T00:00:00.000Z") }];
    const table = /FROM "(\w+)"/.exec(sql)?.[1];
    if (table) lockedTables.push(table);
    return [];
  },
  amuxV22TaskResult: {
    findUnique: async () => result(),
    updateMany: async (input: { data: Record<string, unknown> }) => {
      cleared.push({ model: "result", data: input.data }); return { count: 1 };
    },
  },
  amuxV22TaskPatch: { findUnique: async () => patchRow },
  amuxV52ReviewFindings: {
    findUnique: async () => findingsRow,
    updateMany: async (input: { data: Record<string, unknown> }) => {
      cleared.push({ model: "findings", data: input.data }); return { count: 1 };
    },
  },
  amuxWorkItem: { findUnique: async () => ({ status: "done",
    v4TerminalAt: new Date("2026-07-01T00:00:00.000Z"), archivedAt: null,
    updatedAt: new Date("2026-07-01T00:00:00.000Z") }) },
};

mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  amuxIdeaContentKeyRetirement: { findMany: async () => [] },
  amuxV22TaskResult: { findMany: async () => [{ attemptId }] },
  // The changed-path lists purge on their own pass (none due here).
  amuxV22TaskChangedPaths: { findMany: async () => [] },
  $queryRaw: async () => [{ now: new Date("2026-11-15T00:00:00.000Z") }],
  $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx),
} } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: { takeAuditChainLock: async () => {} } });
mock.module(mod("lib/amux/ideaRetentionHoldRead.ts"), { namedExports: {
  amuxIdeaHasActiveRetentionHold: async () => false,
} });
mock.module(mod("lib/amux/ideaContentKeyRetirementService.ts"), { namedExports: {
  AmuxContentRetirementError: class extends Error {
    constructor(readonly code: string, readonly target?: unknown) { super(code); }
  },
  recordAmuxContentBodyPurge: async (_tx: unknown, target: { purpose: string },
    _at: Date, digest?: string) => { purges.push({ purpose: target.purpose, digest }); },
  retireVerifiedAmuxContentKey: async () => "deleted",
} });

const retention = () => import(mod("lib/amux/v22TaskResultRetention.ts"));

const sealedFindings = (overrides: Record<string, unknown> = {}) => ({ attemptId, taskId, ideaId,
  ciphertext: new Uint8Array([2]), keyId: id("review_findings"), keyVersion: 1,
  digest: "f".repeat(64), digestKeyId: "dk", bodyPurgedAt: null, ...overrides });

const reset = async () => { await load(); findingsRow = null; patchRow = null; cleared = []; purges = []; lockedTables = []; };

test("the purge clears the findings with the result and queues their key's deletion", async () => {
  await reset();
  findingsRow = sealedFindings();
  const outcome = await (await retention()).purgeDueAmuxV22TaskResults();
  assert.equal(outcome.bodiesPurged, 1);
  assert.deepEqual(cleared.map((item) => item.model).sort(), ["findings", "result"]);
  const body = cleared.find((item) => item.model === "findings")!.data;
  assert.deepEqual([body.ciphertext, body.keyId, body.keyVersion], [null, null, null]);
  assert.ok(body.bodyPurgedAt instanceof Date);
  assert.deepEqual(purges.map((item) => item.purpose).sort(), ["review_findings", "task_result"]);
  assert.equal(purges.find((item) => item.purpose === "review_findings")?.digest, "f".repeat(64));
  assert.ok(lockedTables.includes("AmuxV52ReviewFindings"), "the findings row is locked with the result and the patch");
});

test("a result with no review rejection purges as before", async () => {
  await reset();
  const outcome = await (await retention()).purgeDueAmuxV22TaskResults();
  assert.equal(outcome.bodiesPurged, 1);
  assert.deepEqual(cleared.map((item) => item.model), ["result"]);
  assert.deepEqual(purges.map((item) => item.purpose), ["task_result"]);
});

test("findings that do not match their key, idea or state stop the purge before anything is cleared", async () => {
  for (const wrong of [{ keyId: "amux2-other" }, { keyVersion: 2 }, { ideaId: "other-idea" },
    { taskId: "other-task" }, { ciphertext: null, keyId: null, keyVersion: null,
      bodyPurgedAt: new Date("2026-10-01T00:00:00.000Z") }]) {
    await reset();
    findingsRow = sealedFindings(wrong);
    await assert.rejects((await retention()).purgeDueAmuxV22TaskResults(), /integrity_unavailable/,
      JSON.stringify(wrong));
    assert.deepEqual(cleared, [], "nothing is cleared when the findings cannot be verified");
    assert.deepEqual(purges, []);
  }
});
