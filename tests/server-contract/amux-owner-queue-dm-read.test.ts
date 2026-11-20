import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

type Row = Record<string, unknown>;
let rows: Row[] = [];
let lookupFails = false;
const statements: Array<{ sql: string; values: unknown[] }> = [];
const boundaries: unknown[] = [];
const cardReads: string[] = [];
let cardStates: Record<string, unknown> = {};
let cardFails: Set<string> = new Set();

mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_DB_BOUNDARIES: { ownerQueueSettlementRead: { operation: "owner_queue_settlement_read" } },
  withAmuxDbBoundary: async (boundary: unknown, run: (tx: unknown) => Promise<unknown>) => {
    boundaries.push(boundary);
    if (lookupFails) throw new Error("database unavailable");
    return run({ $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ sql: strings.join("?"), values });
      return rows;
    } });
  },
} });
mock.module(mod("lib/amux/v22OwnerQuestionDmRead.ts"), { namedExports: {
  readAmuxDmLocalCardState: async (cardId: string) => {
    cardReads.push(cardId);
    if (cardFails.has(cardId)) throw new Error("card read failed");
    return cardStates[cardId] ?? { state: "filed" };
  },
} });

const readModule = import(mod("lib/amux/ownerQueueDmRead.ts"));
const coreModule = import(mod("lib/amux/ownerQueueCore.ts"));
const readAmuxOwnerQueueDm = async (...args: Parameters<Awaited<typeof readModule>["readAmuxOwnerQueueDm"]>) =>
  (await readModule).readAmuxOwnerQueueDm(...args);

const SHOWN = {
  answerDigest: null, rationaleDigest: "3".repeat(64), optionId: "retry", irreversible: false,
  snapshotState: "none", snapshotTargetSha: null, snapshotManifestDigest: null,
};
const proposal = (optionId: string | null, answer: string | null = null, irreversible = false) => ({
  state: "proposal", requestId: "0b6f2a3e-5d1c-4e8f-9a7b-2c3d4e5f6a7b", answer, optionId,
  rationale: "The run's work is in.", irreversible,
  snapshot: { state: "none", targetSha: null, paths: [] },
  shown: { ...SHOWN, optionId, irreversible },
});
const row = (n: number, overrides: Row = {}): Row => ({
  escalationId: `esc-${n}`, settlementId: `set-${n}`, kind: "stopped", state: "open", decision: null,
  handoffReason: null, localCardId: `card-${n}`, ...overrides,
});
const card = (n: number) => ({ taskId: `task-${n}`, escalationId: `esc-${n}` });
const reset = () => {
  rows = []; lookupFails = false; statements.length = 0; boundaries.length = 0; cardReads.length = 0;
  cardStates = {}; cardFails = new Set();
};

test("the settlement lookup is one bounded statement inside its own read boundary", async () => {
  reset();
  rows = [row(1)];
  await readAmuxOwnerQueueDm([card(1), card(2), { taskId: "task-3", escalationId: null }], true);
  assert.equal(statements.length, 1);
  assert.equal(boundaries.length, 1);
  assert.match(statements[0].sql, /FROM "AmuxDmOwnerSettlement"/);
  assert.match(statements[0].sql, /"escalationId" = ANY\(/);
  assert.deepEqual(statements[0].values, [["esc-1", "esc-2"]], "a card with no escalation is not looked up");
  // setup + one statement + fence, like the idea lane's board read.
  const source = readFileSync(resolve(root, "lib/amux/dbBoundary.ts"), "utf8");
  assert.match(source, /ownerQueueSettlementRead: \{\s+operation: "owner_queue_settlement_read",\s+prismaCallCeiling: 3,\s+isolation: "read",/);
  // Nothing to look up is no statement at all.
  statements.length = 0;
  assert.equal((await readAmuxOwnerQueueDm([{ taskId: "task-9", escalationId: null }], true)).size, 0);
  assert.equal(statements.length, 0);
});

test("an open settlement carries its Decision Maker proposal and may be confirmed; a card with none is absent", async () => {
  reset();
  rows = [row(1), row(2, { kind: "t2_pr", state: "applied", decision: "approve" })];
  cardStates = { "card-1": proposal("retry") };
  const byTask = await readAmuxOwnerQueueDm([card(1), card(2), card(3)], true);
  const open = byTask.get("task-1");
  assert.equal(open?.status, "read");
  if (open?.status !== "read") return;
  assert.equal(open.state, "open");
  assert.equal(open.settlementId, "set-1");
  assert.equal(open.dm.state, "proposal");
  assert.equal(open.confirmable, true);
  // A settled one reads no Decision Maker card: nothing is left to confirm.
  const applied = byTask.get("task-2");
  assert.equal(applied?.status === "read" && applied.confirmable, false);
  assert.deepEqual(cardReads, ["card-1"]);
  assert.equal(byTask.has("task-3"), false, "no settlement, no entry");
  const { amuxOwnerQueueWithDmSettlements } = await coreModule;
  const merged = amuxOwnerQueueWithDmSettlements({ items: [
    { taskId: "task-1" }, { taskId: "task-3" },
  ] as never, total: 2, processedToday: null, generatedAt: "x" }, byTask);
  assert.equal(merged.items[0].dmSettlement?.status, "read");
  assert.equal(merged.items[1].dmSettlement, null);
});

test("a handed-off settlement is never confirmable, and an answer outside its fixed words is not either", async () => {
  reset();
  rows = [
    row(1, { kind: "t2_pr", handoffReason: "outside_dm_merge_allowlist" }),
    row(2),
    row(3),
    row(4, { kind: "t2_pr" }),
  ];
  cardStates = {
    "card-1": proposal("approve"),
    "card-2": proposal(null, "do something else"),
    "card-3": proposal(null, "remake\nFile the new idea", true),
    // approve is not a word of a stopped Task's settlement.
    "card-4": proposal("approve"),
  };
  const byTask = await readAmuxOwnerQueueDm([card(1), card(2), card(3), card(4)], true);
  const at = (n: number) => {
    const entry = byTask.get(`task-${n}`);
    assert.equal(entry?.status, "read");
    return entry as Extract<typeof entry, { status: "read" }>;
  };
  assert.equal(at(1).handoffReason, "outside_dm_merge_allowlist");
  assert.equal(at(1).confirmable, false);
  assert.equal(at(2).confirmable, false);
  // The Decision Maker's irreversible mark is shown, and a person may still confirm a fixed word.
  assert.equal(at(3).confirmable, true);
  assert.equal((at(3).dm as { irreversible: boolean }).irreversible, true);
  assert.equal(at(4).confirmable, true);
});

test("without ops:write the bodies are restricted and no Decision Maker card is read", async () => {
  reset();
  rows = [row(1)];
  const byTask = await readAmuxOwnerQueueDm([card(1)], false);
  const entry = byTask.get("task-1");
  assert.equal(entry?.status === "read" && entry.dm.state, "restricted");
  assert.equal(entry?.status === "read" && entry.confirmable, false);
  assert.deepEqual(cardReads, []);
});

test("an open settlement not yet filed on the host waits for the relay", async () => {
  reset();
  rows = [row(1, { localCardId: null })];
  const entry = (await readAmuxOwnerQueueDm([card(1)], true)).get("task-1");
  assert.deepEqual(entry?.status === "read" && entry.dm, { state: "not_sent", reason: "waiting_relay" });
  assert.equal(entry?.status === "read" && entry.confirmable, false);
});

test("a failed settlement lookup marks each card unread and fails nothing", async () => {
  reset();
  lookupFails = true;
  const byTask = await readAmuxOwnerQueueDm([card(1), card(2), { taskId: "task-3", escalationId: null }], true);
  assert.deepEqual([...byTask.entries()], [
    ["task-1", { status: "unread" }], ["task-2", { status: "unread" }],
  ]);
});

test("a card whose Decision Maker state cannot be read is unavailable on that card only", async () => {
  reset();
  rows = [row(1), row(2), row(3)];
  cardStates = { "card-1": proposal("retry"), "card-2": { state: "unavailable" } };
  cardFails = new Set(["card-3"]);
  const byTask = await readAmuxOwnerQueueDm([card(1), card(2), card(3)], true);
  const dm = (n: number) => { const e = byTask.get(`task-${n}`); return e?.status === "read" ? e.dm.state : e?.status; };
  assert.deepEqual([dm(1), dm(2), dm(3)], ["proposal", "unavailable", "unavailable"]);
});

test("a stored row this read cannot name is unread for its card, not a card without a settlement", async () => {
  reset();
  rows = [row(1, { kind: "something_else" }), row(2)];
  const byTask = await readAmuxOwnerQueueDm([card(1), card(2)], true);
  assert.deepEqual(byTask.get("task-1"), { status: "unread" });
  assert.equal(byTask.get("task-2")?.status, "read");
});

test("only a bounded number of Decision Maker cards is read per call; the rest say so", async () => {
  reset();
  const { AMUX_OWNER_QUEUE_DM_READ_LIMIT } = await readModule;
  const total = AMUX_OWNER_QUEUE_DM_READ_LIMIT + 5;
  rows = Array.from({ length: total }, (_, index) => row(index));
  const byTask = await readAmuxOwnerQueueDm(Array.from({ length: total }, (_, index) => card(index)), true);
  assert.equal(cardReads.length, AMUX_OWNER_QUEUE_DM_READ_LIMIT);
  const over = byTask.get(`task-${total - 1}`);
  assert.equal(over?.status === "read" && over.dm.state, "unavailable");
  assert.equal(over?.status === "read" && over.confirmable, false);
});
