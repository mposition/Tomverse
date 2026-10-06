import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BINDING_STATES,
  BINDING_TRANSITIONS,
  ENGINEERING_AGENT_FREEZE_SETTING_KEY,
  ENGINEERING_AGENT_MERGER_KINDS,
  ENGINEERING_AGENT_MODE_SETTING_KEY,
  ENGINEERING_AGENT_MODES,
  ENGINEERING_AGENT_NOT_APPROVED_REASONS,
  ENGINEERING_AGENT_WORK_ITEM_KINDS,
  FIRST_T1_WINDOW_DAYS,
  HALT_VALUES,
  OWNER_QUEUE_LIMITS,
  PARTIAL_REGISTRATION_DECISION_CAUSE_PREFIX,
  REGISTRATION_RESULTS,
  REGISTRATION_TRANSITIONS,
  REQUEST_STATES,
  REQUEST_TRANSITIONS,
  RUN_OUTCOMES,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  UNKNOWN_OUTCOME_DECISION_CAUSE_PREFIX,
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
const outcomeSql = readFileSync(
  new URL("../prisma/migrations/20261007010000_engineering_agent_private_result/migration.sql", import.meta.url),
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
const check = (name, source = sql) => {
  const start = source.lastIndexOf(`"${name}"`);
  assert.ok(start >= 0, `${name} exists`);
  const rest = source.slice(start + name.length + 2);
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
  assert.deepEqual(sorted(quoted(check("EngineeringAgentRun_outcome_check", outcomeSql))), sorted(RUN_OUTCOMES));
  assert.deepEqual(sorted(quoted(check("EngineeringAgentRun_halt_check"))), sorted(HALT_VALUES));
  assert.deepEqual(sorted(quoted(check("EngineeringAgentRun_modeAtStart_check"))), sorted(ENGINEERING_AGENT_MODES));
  // The trigger reads the mode as the core does: anything but a known on-mode is off.
  const reading = /NEW\."modeAtStart" := CASE WHEN mode_value IN \(([^)]*)\) THEN mode_value ELSE '([a-z0-9]+)' END;/.exec(sql);
  assert.ok(reading, "the run trigger records the mode it read");
  assert.deepEqual(sorted(quoted(reading[1])), sorted(ENGINEERING_AGENT_MODES.filter((mode) => mode !== "off")));
  assert.equal(reading[2], "off");
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

test("every work item kind can name the cause key it is created under", () => {
  const rule = /"EngineeringAgentWorkItem_causeKey_check" CHECK \("causeKey" ~ '([^']+)'\)/.exec(sql);
  assert.ok(rule, "the cause key rule");
  const pattern = new RegExp(rule[1]);
  for (const kind of ENGINEERING_AGENT_WORK_ITEM_KINDS) {
    assert.match(`${kind}:00000000-0000-0000-0000-000000000000`, pattern, kind);
  }
  assert.match(`${UNKNOWN_OUTCOME_DECISION_CAUSE_PREFIX}x:1`, pattern);
  assert.match(`${PARTIAL_REGISTRATION_DECISION_CAUSE_PREFIX}x`, pattern);
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
    [...sql.matchAll(/-- limit: ([A-Z_0-9]+(?:\.\w+)?)\n\s*\w+ CONSTANT INTEGER := (\d+);/g)].map((m) => [
      m[1],
      Number(m[2]),
    ]),
  );
  assert.deepEqual(
    Object.fromEntries(limits),
    {
      "OWNER_QUEUE_LIMITS.pr": OWNER_QUEUE_LIMITS.pr,
      "OWNER_QUEUE_LIMITS.prDuringFirstT1Days": OWNER_QUEUE_LIMITS.prDuringFirstT1Days,
      FIRST_T1_WINDOW_DAYS,
      "OWNER_QUEUE_LIMITS.decision": OWNER_QUEUE_LIMITS.decision,
      "REGISTRATION_CAPS.perRound": REGISTRATION_CAPS.perRound,
      "REGISTRATION_CAPS.perUtcDay": REGISTRATION_CAPS.perUtcDay,
      "REGISTRATION_CAPS.unpromoted": REGISTRATION_CAPS.unpromoted,
    },
  );
});

test("every string the database matches on is the string the code holds", () => {
  const strings = new Map(
    [...sql.matchAll(/-- (?:setting|cause): ([A-Z_0-9]+)\n\s*\w+ CONSTANT TEXT := '([^']*)';/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  assert.deepEqual(Object.fromEntries(strings), {
    ENGINEERING_AGENT_MODE_SETTING_KEY,
    ENGINEERING_AGENT_FREEZE_SETTING_KEY,
    UNKNOWN_OUTCOME_DECISION_CAUSE_PREFIX,
    PARTIAL_REGISTRATION_DECISION_CAUSE_PREFIX,
  });
});

test("every enum a JSON CHECK lists is the core list", () => {
  const lists = new Map(
    [...sql.matchAll(/-- (?:reasons|mergers): ([A-Z_]+)\n[^\n]*IN \(([^)]*)\)/g)].map((m) => [m[1], sorted(quoted(m[2]))]),
  );
  assert.deepEqual(Object.fromEntries(lists), {
    ENGINEERING_AGENT_NOT_APPROVED_REASONS: sorted(ENGINEERING_AGENT_NOT_APPROVED_REASONS),
    ENGINEERING_AGENT_MERGER_KINDS: sorted(ENGINEERING_AGENT_MERGER_KINDS),
  });
});

test("every trigger function pins search_path and reads its siblings through the trigger's schema", () => {
  const functions = [...sql.matchAll(/CREATE OR REPLACE FUNCTION "(\w+)"\(\)\n([\s\S]*?)\nAS \$\$\n([\s\S]*?)\n\$\$;/g)];
  const created = [...sql.matchAll(/CREATE OR REPLACE FUNCTION "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(functions.map((m) => m[1]), created, "every function has a header and a body");
  for (const [, name, header, body] of functions) {
    assert.match(header, /^RETURNS TRIGGER\nLANGUAGE plpgsql\nSET search_path = pg_catalog, pg_temp$/, name);
    // A table named in a body is named inside a format() string, after %I.
    for (const match of body.matchAll(/(%(?:1\$)?I\.)?"((?:EngineeringAgent|Amux|AppSetting|AdminAuditLog)\w*)"/g)) {
      assert.ok(match[1], `${name} names "${match[2]}" without the trigger's schema`);
    }
  }
});

test("time the triggers write or compare is the database clock in UTC, never the caller's", () => {
  assert.doesNotMatch(sql, /\bnow\(\)/i, "no transaction-start clock");
  const clocks = [...sql.matchAll(/clock_timestamp\(\)[^;\n]*/g)].map((m) => m[0]);
  assert.ok(clocks.length > 0);
  for (const clock of clocks) assert.match(clock, /^clock_timestamp\(\) AT TIME ZONE 'UTC'/);
});

test("the migration writes no row and holds no user content column", () => {
  assert.doesNotMatch(sql, /INSERT INTO/i);
  assert.doesNotMatch(sql, /"(?:title|body|message|content|prompt|email)"\s+TEXT/i);
});
