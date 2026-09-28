import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BINDING_STATES,
  BINDING_TRANSITIONS,
  ENGINEERING_AGENT_WORK_ITEM_KINDS,
  HALT_VALUES,
  OWNER_QUEUE_LIMITS,
  REGISTRATION_RESULTS,
  REGISTRATION_TRANSITIONS,
  REQUEST_STATES,
  REQUEST_TRANSITIONS,
  RUN_OUTCOMES,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  workItemInitialState,
  workItemStates,
  workItemTransitions,
} from "../lib/engineeringAgentCore.ts";
import { REGISTRATION_CAPS } from "../lib/engineeringAgentRegistrationGuard.ts";

/**
 * The migration's triggers and CHECK constraints are written out in SQL; the
 * tables they enforce live in lib/engineeringAgentCore.ts. This reads both and
 * fails when they differ, so neither can be edited alone.
 */
const sql = readFileSync(
  new URL("../prisma/migrations/20260928120000_engineering_agent_state/migration.sql", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

const pairs = (text) => [...text.matchAll(/\('([a-z_0-9]+)',\s*'([a-z_0-9]+)'\)/g)].map((m) => `${m[1]}->${m[2]}`);
const quoted = (text) => [...text.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
const sorted = (list) => [...list].sort();
const asPairs = (table) => sorted(table.map(([from, to]) => `${from}->${to}`));

/** Every `-- transitions: <table> <kind>` block, as sorted from->to pairs. */
const transitionBlocks = () => {
  const blocks = new Map();
  for (const match of sql.matchAll(/-- transitions: (\w+) (\w+)\n([\s\S]*?)-- end transitions/g)) {
    const key = `${match[1]} ${match[2]}`;
    assert.ok(!blocks.has(key), `one block per table and kind: ${key}`);
    blocks.set(key, sorted(pairs(match[3])));
  }
  return blocks;
};

/** The text of one named CHECK constraint, up to the next constraint or statement end. */
const check = (name) => {
  const start = sql.indexOf(`"${name}"`);
  assert.ok(start >= 0, `${name} exists`);
  const rest = sql.slice(start + name.length + 2);
  const end = rest.search(/\n\s*ADD CONSTRAINT|;\n/);
  return rest.slice(0, end);
};

test("every transition trigger allows exactly the core table's transitions", () => {
  const blocks = transitionBlocks();
  const expected = new Map([
    ["EngineeringAgentRun run", asPairs(RUN_TRANSITIONS)],
    ["EngineeringAgentBinding binding", asPairs(BINDING_TRANSITIONS)],
    ["EngineeringAgentRegistration registration", asPairs(REGISTRATION_TRANSITIONS)],
    ["EngineeringAgentRequest request", asPairs(REQUEST_TRANSITIONS)],
    ...ENGINEERING_AGENT_WORK_ITEM_KINDS.map((kind) => [
      `EngineeringAgentWorkItem ${kind}`,
      asPairs(workItemTransitions(kind)),
    ]),
  ]);
  assert.deepEqual(sorted(blocks.keys()), sorted(expected.keys()));
  for (const [key, table] of expected) assert.deepEqual(blocks.get(key), table, key);
});

test("every state and value list in a CHECK is exactly the core list", () => {
  assert.deepEqual(sorted(quoted(check("EngineeringAgentRun_status_check"))), sorted(RUN_STATUSES));
  assert.deepEqual(sorted(quoted(check("EngineeringAgentRun_outcome_check"))), sorted(RUN_OUTCOMES));
  assert.deepEqual(sorted(quoted(check("EngineeringAgentRun_halt_check"))), sorted(HALT_VALUES));
  assert.deepEqual(sorted(quoted(check("EngineeringAgentBinding_state_check"))), sorted(BINDING_STATES));
  assert.deepEqual(sorted(quoted(check("EngineeringAgentRegistration_result_check"))), sorted(REGISTRATION_RESULTS));
  assert.deepEqual(sorted(quoted(check("EngineeringAgentRequest_state_check"))), sorted(REQUEST_STATES));
  assert.deepEqual(
    sorted(quoted(check("EngineeringAgentWorkItem_kind_check"))),
    sorted(ENGINEERING_AGENT_WORK_ITEM_KINDS),
  );

  // The work item state CHECK is one disjunct per kind.
  const states = check("EngineeringAgentWorkItem_state_check");
  for (const kind of ENGINEERING_AGENT_WORK_ITEM_KINDS) {
    const disjunct = new RegExp(`\\("kind" = '${kind}' AND "state" IN \\(([^)]*)\\)\\)`).exec(states);
    assert.ok(disjunct, `a state list for ${kind}`);
    assert.deepEqual(sorted(quoted(disjunct[1])), sorted(workItemStates(kind)), kind);
  }
});

test("a work item is created in its kind's initial state and nowhere else", () => {
  const insert = /IF TG_OP = 'INSERT' THEN\n\s*IF NOT \(([\s\S]*?)\) THEN\n\s*RAISE EXCEPTION 'EngineeringAgentWorkItem starts/.exec(sql);
  assert.ok(insert, "the work item insert rule");
  for (const kind of ENGINEERING_AGENT_WORK_ITEM_KINDS) {
    const initial = workItemInitialState(kind);
    const clause = [...insert[1].matchAll(/\(NEW\."kind" IN \(([^)]*)\) AND NEW\."state" = '([a-z_]+)'\)/g)].find((m) =>
      quoted(m[1]).includes(kind),
    );
    assert.ok(clause, `an initial state for ${kind}`);
    assert.equal(clause[2], initial, kind);
  }
});

test("every cap the database counts is the number the code holds", () => {
  const limits = new Map(
    [...sql.matchAll(/-- limit: ([A-Z_]+)\.(\w+)\n\s*\w+ CONSTANT INTEGER := (\d+);/g)].map((m) => [
      `${m[1]}.${m[2]}`,
      Number(m[3]),
    ]),
  );
  assert.deepEqual(
    Object.fromEntries(limits),
    {
      "OWNER_QUEUE_LIMITS.pr": OWNER_QUEUE_LIMITS.pr,
      "OWNER_QUEUE_LIMITS.decision": OWNER_QUEUE_LIMITS.decision,
      "REGISTRATION_CAPS.perRound": REGISTRATION_CAPS.perRound,
      "REGISTRATION_CAPS.perUtcDay": REGISTRATION_CAPS.perUtcDay,
      "REGISTRATION_CAPS.unpromoted": REGISTRATION_CAPS.unpromoted,
    },
  );
});

test("time the triggers write or compare is the database clock in UTC, never the caller's", () => {
  assert.doesNotMatch(sql, /\bnow\(\)/i, "no transaction-start clock");
  const clocks = [...sql.matchAll(/clock_timestamp\(\)[^;\n]*/g)].map((m) => m[0]);
  assert.ok(clocks.length > 0);
  for (const clock of clocks) assert.match(clock, /^clock_timestamp\(\) AT TIME ZONE 'UTC'/);
});

test("the migration writes no row and holds no user content column", () => {
  assert.doesNotMatch(sql, /^\s*INSERT INTO/im);
  assert.doesNotMatch(sql, /"(?:title|body|message|content|prompt|email)"\s+TEXT/i);
});
