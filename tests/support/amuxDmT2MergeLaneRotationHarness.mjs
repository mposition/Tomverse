import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The merge lane's list of Decision Maker approvals (lib/amux/dmT2MergeService.ts)
// over an in-memory table: one approval per state read, the least recently
// visited, recorded as visited whatever its check finds (reviews
// r-20261113-135805-1535ac, r-20261113-140634-2ede9b). The table's order is the
// reader's own -- updatedAt, then id -- and a visit always lands after every
// other row's, as the service's GREATEST(clock, max + 1 ms) write does.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

const HEAD = "c".repeat(40);
const DIFF = "d".repeat(64);
const ON = { TOMVERSE_AMUX_DM_T2_MERGE: "enabled" };

let rows;
let statements;

const fakeTx = {
  $executeRaw: async (strings, ...values) => {
    const sql = strings.join("?");
    statements.push("visit");
    assert.match(sql, /UPDATE "AmuxDmOwnerSettlement" SET "updatedAt" = GREATEST\(clock_timestamp\(\)/);
    assert.match(sql, /max\(o\."updatedAt"\)/);
    assert.match(sql, /interval '1 millisecond'/);
    assert.match(sql, /"state" = 'applied'/);
    const [id] = values;
    assert.equal(typeof id, "string", "one approval per visit");
    const after = Math.max(...rows.map((row) => row.updatedAt)) + 1;
    for (const row of rows) if (row.settlementId === id) row.updatedAt = after;
    return 1;
  },
};

mock.module(mod("lib/amux/dbBoundary.ts"), {
  namedExports: {
    AMUX_DB_BOUNDARIES: {
      dmT2MergeLaneRead: { operation: "dm_t2_merge_lane_read", prismaCallCeiling: 5, isolation: "mutation" },
      dmT2MergeReadyPick: { operation: "dm_t2_merge_ready_pick", prismaCallCeiling: 4, isolation: "mutation" },
    },
    withAmuxDbBoundary: async (_boundary, work) => work(fakeTx, { dbNow: new Date() }),
  },
});
mock.module(mod("lib/amux/decisionMakerSwitchStore.ts"), {
  namedExports: {
    readDecisionMakerSwitches: async () => { statements.push("switches"); return { killSwitch: false }; },
    readDecisionMakerSwitchesOrThrow: async () => ({ killSwitch: false }),
  },
});
mock.module(mod("lib/amux/dmT2MergeRead.ts"), {
  namedExports: {
    readAmuxDmT2MergeApprovals: async (_tx, input) => {
      statements.push(`approvals:${input.limit}`);
      return [...rows]
        .filter((row) => !input.prNumbers || input.prNumbers.includes(row.prNumber))
        .sort((a, b) => a.updatedAt - b.updatedAt || a.settlementId.localeCompare(b.settlementId))
        .slice(0, input.limit)
        .map((row) => ({ ...row }));
    },
    readAmuxDmT2MergeObservedFacts: async () => null,
  },
});
mock.module(mod("lib/adminAudit.ts"), {
  namedExports: { takeAuditChainLock: async () => {}, writeSystemAuditLog: async () => "audit" },
});
mock.module(mod("lib/engineeringAgentGitHubRead.ts"), {
  namedExports: { readEngineeringAgentPullChange: async () => { throw new Error("live read"); } },
});

const { readAmuxDmT2MergeLanePulls } = await import(mod("lib/amux/dmT2MergeService.ts"));

// Every approval shares one updatedAt to start with: the tie's id order must never trap one.
const approval = (index) => ({
  settlementId: `s-${String(index).padStart(2, "0")}`, taskId: `t-${index}`, attemptId: `a-${index}`,
  bindingId: `b-${index}`, prNumber: 1000 + index, headRef: `agent/engineering/${700 + index}`,
  approvedHeadSha: HEAD, approvedDiffDigest: DIFF, decidedAt: new Date(), updatedAt: 0,
});
const github = (behaviour) => {
  const checked = [];
  return {
    checked,
    change: async (prNumber) => {
      checked.push(prNumber);
      const kind = behaviour(prNumber);
      if (kind === "throw") throw new Error("http_error");
      return { state: "open", baseRef: "develop", headRef: `agent/engineering/${700 + prNumber - 1000}`,
        headSha: HEAD, diffDigest: kind === "good" ? DIFF : "e".repeat(64), changedFiles: ["components/X.tsx"],
        crossRepository: false };
    },
  };
};

// N approvals are each checked exactly once in N rounds, one per round.
{
  const N = 9;
  rows = Array.from({ length: N }, (_, index) => approval(index));
  statements = [];
  const gh = github(() => "changed");
  for (let round = 0; round < N; round += 1) {
    assert.deepEqual(await readAmuxDmT2MergeLanePulls(ON, { change: gh.change }), []);
  }
  assert.equal(gh.checked.length, N);
  assert.equal(new Set(gh.checked).size, N, `each once: ${JSON.stringify(gh.checked)}`);
  // Per round: the switches, one approval, its one visit -- five calls with setup and fence.
  assert.deepEqual(statements.slice(0, 3), ["switches", "approvals:1", "visit"]);
  assert.equal(statements.filter((entry) => entry === "visit").length, N);
}

// Approvals whose read fails every time, ahead of one that holds, never hold it up.
{
  rows = Array.from({ length: 6 }, (_, index) => approval(index));
  statements = [];
  const gh = github((prNumber) => prNumber === 1005 ? "good" : "throw");
  const listed = [];
  for (let round = 0; round < 12; round += 1) {
    listed.push((await readAmuxDmT2MergeLanePulls(ON, { change: gh.change })).map((entry) => entry.number));
  }
  assert.deepEqual(listed, [[], [], [], [], [], [1005], [], [], [], [], [], [1005]],
    "listed on its turn, and again a turn later; the failing ones never");
}

// Off, or nothing approved: no visit is written and nothing is read.
{
  statements = [];
  const gh = github(() => "good");
  assert.deepEqual(await readAmuxDmT2MergeLanePulls({}, { change: gh.change }), []);
  rows = [];
  assert.deepEqual(await readAmuxDmT2MergeLanePulls(ON, { change: gh.change }), []);
  assert.deepEqual(statements, ["switches", "approvals:1"]);
  assert.deepEqual(gh.checked, []);
}
