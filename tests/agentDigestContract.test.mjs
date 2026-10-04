import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
// directly against the migrations.
//
// A later migration may redefine a CHECK or a trigger function (a new agent
// widens both), so the definitions compared are the last ones in migration
// order -- the ones a database built from these migrations actually holds.

const SQL = readFileSync(
  new URL("../prisma/migrations/20261003000000_agent_digest_item/migration.sql", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

const MIGRATIONS_DIR = new URL("../prisma/migrations/", import.meta.url);
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .flatMap((name) => {
    try {
      return [readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS_DIR), "utf8").replace(/\r\n/g, "\n")];
    } catch {
      return [];
    }
  });

const lastMatch = (pattern) => {
  let found = null;
  for (const sql of MIGRATION_SQL) {
    for (const match of sql.matchAll(pattern)) found = match;
  }
  return found;
};

const quoted = (list) => [...list.matchAll(/'([^']*)'/g)].map((match) => match[1]);

const functionBody = (name) => {
  const match = lastMatch(
    new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name}\\(\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`, "g"),
  );
  assert.ok(match, `${name} not found`);
  return match[1];
};

test("the kind CHECK lists exactly the contract's kinds for each agent", () => {
  const check = lastMatch(/"AgentDigestItem_kind_check"\s*CHECK \(([\s\S]*?)\)(?:,\n|;)/g);
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

test("the billing-finance-ops registration widens the three per-agent values and nothing else", () => {
  const sql = readFileSync(
    new URL("../prisma/migrations/20261004000000_agent_digest_billing_finance_ops/migration.sql", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const code = sql.replace(/--[^\n]*/g, "");
  assert.deepEqual(
    [...code.matchAll(/DROP CONSTRAINT "([^"]+)"/g)].map((m) => m[1]),
    ["AgentDigestItem_agent_key_check", "AgentDigestItem_kind_check"],
  );
  assert.deepEqual(
    [...code.matchAll(/ADD CONSTRAINT "([^"]+)"/g)].map((m) => m[1]),
    ["AgentDigestItem_agent_key_check", "AgentDigestItem_kind_check"],
  );
  assert.deepEqual(
    [...code.matchAll(/CREATE (?:OR REPLACE )?FUNCTION "?(\w+)"?\(/g)].map((m) => m[1]),
    ["agent_digest_item_before_insert", "billing_finance_ops_assert_deadline"],
  );
  assert.match(code, /agent_digest_item_before_insert\(\) RETURNS trigger\s+LANGUAGE plpgsql\s+SET search_path = pg_catalog, pg_temp/);
  // The deadline check has the support_triage_assert_deadline() shape: no SET
  // clause, SECURITY INVOKER, a schema-qualified clock, raising on a NULL.
  const deadline = code.match(/FUNCTION "billing_finance_ops_assert_deadline"\(deadline TIMESTAMPTZ\)([\s\S]*?)\$\$;/);
  assert.ok(deadline, "deadline function not found");
  assert.doesNotMatch(deadline[1], /\bSET\b/);
  assert.match(deadline[1], /SECURITY INVOKER/);
  assert.match(deadline[1], /deadline IS NULL OR pg_catalog\.clock_timestamp\(\) > deadline/);
  assert.match(deadline[1], /ERRCODE = 'check_violation'/);
  assert.doesNotMatch(deadline[1], /EXCEPTION\s+WHEN/);
  // The baseline guard probes for that function, since nothing else here is
  // visible to prisma migrate diff.
  assert.match(sql, /^-- baseline-check: present-if-function "billing_finance_ops_assert_deadline"$/m);
  assert.doesNotMatch(code, /\b(?:DROP TABLE|DROP TRIGGER|CREATE TRIGGER|ALTER COLUMN|DELETE FROM|UPDATE "AgentDigestItem")\b/);
  // The app switch row starts off; only the Admin control route changes it.
  assert.match(code, /'billingFinanceOps\.control',\s*json_build_object\('enabled', false, 'revision', 0, 'enabledAt', NULL\)::text/);
  assert.match(code, /ON CONFLICT \("key"\) DO NOTHING;/);
});
