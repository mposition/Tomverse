import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The merge lane's list of Decision Maker approvals (lib/amux/dmT2MergeService.ts)
// over an in-memory table: approvals that stay unmergeable never hide the ones
// behind them (review r-20261113-135805-1535ac). The table's order is the
// reader's own, least recently visited first; the visit is the service's write.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

const HEAD = "c".repeat(40);
const DIFF = "d".repeat(64);
const ON = { TOMVERSE_AMUX_DM_T2_MERGE: "enabled" };

let rows;
let clock;
let statements;

const fakeTx = {
  $executeRaw: async (strings, ...values) => {
    const sql = strings.join("?");
    statements.push(sql.includes(`"updatedAt"`) ? "visit" : "other");
    assert.match(sql, /UPDATE "AmuxDmOwnerSettlement" SET "updatedAt"/);
    assert.match(sql, /"state" = 'applied'/);
    const ids = values[0];
    for (const row of rows) if (ids.includes(row.settlementId)) row.visited = (clock += 1);
    return ids.length;
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
      statements.push("approvals");
      return [...rows]
        .filter((row) => !input.prNumbers || input.prNumbers.includes(row.prNumber))
        .sort((a, b) => a.visited - b.visited || a.settlementId.localeCompare(b.settlementId))
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

const approval = (index) => ({
  settlementId: `s-${String(index).padStart(2, "0")}`, taskId: `t-${index}`, attemptId: `a-${index}`,
  bindingId: `b-${index}`, prNumber: 1000 + index, headRef: `agent/engineering/${700 + index}`,
  approvedHeadSha: HEAD, approvedDiffDigest: DIFF, decidedAt: new Date(), visited: 0,
});
const change = (good) => async (prNumber) => ({ state: "open", baseRef: "develop",
  headRef: `agent/engineering/${700 + prNumber - 1000}`, headSha: HEAD,
  diffDigest: good.has(prNumber) ? DIFF : "e".repeat(64), changedFiles: ["components/X.tsx"] });

// Eleven approvals that stay unmergeable ahead of one that holds: it is listed
// within the rounds a full turn takes (ceil(12 / 5) = 3), and again a turn later.
rows = Array.from({ length: 12 }, (_, index) => approval(index));
clock = 0;
statements = [];
const good = new Set([1011]);
const rounds = [];
for (let round = 0; round < 6; round += 1) {
  rounds.push((await readAmuxDmT2MergeLanePulls(ON, { change: change(good) })).map((entry) => entry.number));
  // Every approval is looked at within the first full turn.
  if (round === 2) assert.ok(rows.every((row) => row.visited > 0), JSON.stringify(rows.map((row) => row.visited)));
}
const firstListed = rounds.findIndex((listed) => listed.includes(1011));
assert.ok(firstListed >= 0 && firstListed < 3, `listed in round ${firstListed}: ${JSON.stringify(rounds)}`);
assert.ok(rounds.slice(firstListed + 1).some((listed) => listed.includes(1011)), "listed again a turn later");
assert.ok(rounds.every((listed) => listed.every((number) => number === 1011)), "the unmergeable ones are never listed");
// Each round: the switches, five approvals and one visit of exactly those -- within the boundary's five calls with setup and fence.
assert.deepEqual(statements.slice(0, 3), ["switches", "approvals", "visit"]);
assert.equal(statements.filter((entry) => entry === "visit").length, 6);

// Off, or nothing approved: no visit is written.
statements = [];
assert.deepEqual(await readAmuxDmT2MergeLanePulls({}, { change: change(good) }), []);
rows = [];
assert.deepEqual(await readAmuxDmT2MergeLanePulls(ON, { change: change(good) }), []);
assert.deepEqual(statements, ["switches", "approvals"]);
