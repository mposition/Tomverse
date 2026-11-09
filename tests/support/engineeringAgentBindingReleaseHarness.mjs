import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

let bindings;
let calls;
let refuseMove = null;

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: { engineeringAgentBinding: { findMany: async (args) => { calls.push(["findMany", args]); return bindings; } } },
  },
});
class ReadError extends Error {}
class RefusedError extends Error {}
mock.module(mod("lib/engineeringAgentGitHubRead.ts"), {
  namedExports: {
    EngineeringAgentGitHubReadError: ReadError,
    readEngineeringAgentPullMerge: async () => { throw new Error("live read"); },
    readEngineeringAgentBranchPresent: async () => { throw new Error("live read"); },
  },
});
mock.module(mod("lib/engineeringAgentStore.ts"), {
  namedExports: {
    EngineeringAgentStoreRefusedError: RefusedError,
    runEngineeringAgentTransaction: async (_prisma, work) => work("engineering-tx"),
    moveEngineeringAgentBinding: async (tx, input) => {
      if (refuseMove === input.to) throw new RefusedError("switch_closed");
      calls.push(["move", tx, input]);
    },
  },
});

const { releaseEngineeringAgentBindings } = await import(mod("lib/engineeringAgentBindingRelease.ts"));

const MERGE = { merged: true, mergeCommitSha: "c".repeat(40) };
const binding = (overrides = {}) => ({
  id: "binding", prNumber: 3147, ref: "agent/engineering/240130630815", state: "open", mergeObservation: null,
  ...overrides,
});
const run = async (rows, ports, refuse = null) => {
  bindings = rows;
  calls = [];
  refuseMove = refuse;
  return releaseEngineeringAgentBindings(ports);
};
const moves = () => calls.filter(([kind]) => kind === "move").map(([, , input]) => input.to);
const never = async () => { throw new Error("not read"); };

// Only current bindings that still hold a slot are read.
await run([], { pull: never, branchPresent: never });
assert.deepEqual(calls[0][1].where, { state: { in: ["open", "closed"] }, supersededAt: null });

// The production case: merge recorded, branch deleted -> closed then pruned, with no pull read.
assert.deepEqual(await run([binding({ mergeObservation: MERGE })], { pull: never, branchPresent: async () => false }),
  [{ bindingId: "binding", outcome: "pruned" }]);
assert.deepEqual(moves(), ["closed", "pruned"]);
assert.equal(calls.find(([kind]) => kind === "move")[1], "engineering-tx");

// Merge recorded, branch still there: closed, and it keeps its slot.
assert.deepEqual(await run([binding({ mergeObservation: MERGE })], { pull: never, branchPresent: async () => true }),
  [{ bindingId: "binding", outcome: "closed" }]);
assert.deepEqual(moves(), ["closed"]);

// An open pull request is left alone.
assert.deepEqual(await run([binding()], { pull: async () => ({ state: "open", merged: false }), branchPresent: never }),
  [{ bindingId: "binding", outcome: "pull_open" }]);
assert.deepEqual(moves(), []);

// A merge the observer has not recorded yet stays open: the observer completes the card first.
assert.deepEqual(await run([binding()], { pull: async () => ({ state: "closed", merged: true }), branchPresent: never }),
  [{ bindingId: "binding", outcome: "merge_unrecorded" }]);
assert.deepEqual(moves(), []);

// Closed without a merge: closed, then pruned once the branch is gone.
assert.deepEqual(await run([binding()], { pull: async () => ({ state: "closed", merged: false }), branchPresent: async () => false }),
  [{ bindingId: "binding", outcome: "pruned" }]);
assert.deepEqual(moves(), ["closed", "pruned"]);

// An already closed binding: pruned when its branch is gone, kept while it remains.
assert.deepEqual(await run([binding({ state: "closed" })], { pull: never, branchPresent: async () => false }),
  [{ bindingId: "binding", outcome: "pruned" }]);
assert.deepEqual(moves(), ["pruned"]);
assert.deepEqual(await run([binding({ state: "closed" })], { pull: never, branchPresent: async () => true }),
  [{ bindingId: "binding", outcome: "branch_remains" }]);
assert.deepEqual(moves(), []);

// A read that fails decides nothing, and a move already made stays reported.
assert.deepEqual(await run([binding()], { pull: async () => { throw new ReadError("http_error"); }, branchPresent: never }),
  [{ bindingId: "binding", outcome: "unreadable" }]);
assert.deepEqual(moves(), []);
assert.deepEqual(await run([binding({ mergeObservation: MERGE })], { pull: never, branchPresent: async () => { throw new ReadError("http_error"); } }),
  [{ bindingId: "binding", outcome: "closed" }]);
assert.deepEqual(moves(), ["closed"]);

// A store refusal is that binding's answer; the next binding is still handled.
assert.deepEqual(await run([binding({ mergeObservation: MERGE }), binding({ id: "other", state: "closed" })],
  { pull: never, branchPresent: async () => false }, "closed"),
  [{ bindingId: "binding", outcome: "refused" }, { bindingId: "other", outcome: "pruned" }]);

// Any other failure is not swallowed.
await assert.rejects(run([binding()], { pull: async () => { throw new Error("boom"); }, branchPresent: never }), /boom/);
