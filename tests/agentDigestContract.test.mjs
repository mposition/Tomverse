import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AGENT_DIGEST_AGENT_KEYS,
  AGENT_DIGEST_BODY_RETENTION_DAYS,
  AGENT_DIGEST_KINDS,
  AGENT_DIGEST_MAX_PAYLOAD_BYTES,
  AGENT_DIGEST_META_RETENTION_DAYS,
} from "../lib/agentDigestContract.ts";

// scripts/check-enum-constraints.mjs compares the flat agentKey list. The kind
// CHECK is a per-agent compound condition its parser does not read, and the
// retention periods live in trigger bodies, so this test compares those
// directly against the migration that created them.

const SQL = readFileSync(
  new URL("../prisma/migrations/20261003000000_agent_digest_item/migration.sql", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

const quoted = (list) => [...list.matchAll(/'([^']*)'/g)].map((match) => match[1]);

const functionBody = (name) => {
  const match = SQL.match(new RegExp(`CREATE FUNCTION ${name}\\(\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`));
  assert.ok(match, `${name} not found`);
  return match[1];
};

test("the kind CHECK lists exactly the contract's kinds for each agent", () => {
  const check = SQL.match(/"AgentDigestItem_kind_check"\s*CHECK \(([\s\S]*?)\),\n/);
  assert.ok(check, "kind CHECK not found");
  const clauses = [...check[1].matchAll(/"agentKey" = '([^']+)' AND "kind" IN \(([^)]*)\)/g)];
  const fromSql = Object.fromEntries(clauses.map((clause) => [clause[1], quoted(clause[2]).sort()]));
  const fromContract = Object.fromEntries(
    AGENT_DIGEST_AGENT_KEYS.map((agent) => [agent, [...AGENT_DIGEST_KINDS[agent]].sort()]),
  );
  assert.deepEqual(fromSql, fromContract);
});

test("the insert trigger gives each agent the contract's body retention", () => {
  const body = functionBody("agent_digest_item_before_insert");
  const fromSql = Object.fromEntries(
    [...body.matchAll(/WHEN '([^']+)' THEN INTERVAL '(\d+) days'/g)].map((m) => [m[1], Number(m[2])]),
  );
  assert.deepEqual(fromSql, { ...AGENT_DIGEST_BODY_RETENTION_DAYS });
});

test("the delete trigger waits the contract's meta retention", () => {
  const body = functionBody("agent_digest_item_before_delete");
  assert.deepEqual(
    [...body.matchAll(/INTERVAL '(\d+) days'/g)].map((m) => Number(m[1])),
    [AGENT_DIGEST_META_RETENTION_DAYS],
  );
});

test("the size CHECK uses the contract's payload limit", () => {
  assert.match(SQL, new RegExp(`"sizeBytes" <= ${AGENT_DIGEST_MAX_PAYLOAD_BYTES}\\)`));
});

test("every function pins its search_path, and no trigger calls a function by name in this schema", () => {
  const functions = [...SQL.matchAll(/CREATE FUNCTION (\w+)\(\)[^$]*?LANGUAGE plpgsql\s+(SET search_path = pg_catalog, pg_temp)?/g)];
  assert.equal(functions.length, 3);
  for (const fn of functions) assert.ok(fn[2], fn[1]);
  assert.equal((SQL.match(/CREATE FUNCTION/g) ?? []).length, 3);
  assert.doesNotMatch(SQL, /agent_digest_body_retention/);
});
