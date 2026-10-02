import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AGENT_DIGEST_AGENT_KEYS,
  AGENT_DIGEST_BODY_RETENTION_DAYS,
  AGENT_DIGEST_KINDS,
  AGENT_DIGEST_MAX_PAYLOAD_BYTES,
} from "../lib/agentDigestContract.ts";

// scripts/check-enum-constraints.mjs compares the flat agentKey list. The kind
// CHECK is a per-agent compound condition its parser does not read, and the
// retention lives in a function, so this test compares those two directly
// against the migration that created them.

const SQL = readFileSync(
  new URL("../prisma/migrations/20261003000000_agent_digest_item/migration.sql", import.meta.url),
  "utf8",
);

const quoted = (list) => [...list.matchAll(/'([^']*)'/g)].map((match) => match[1]);

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

test("the retention function gives each agent the contract's body retention", () => {
  const body = SQL.match(/CREATE FUNCTION agent_digest_body_retention[\s\S]*?\$\$([\s\S]*?)\$\$/);
  assert.ok(body, "retention function not found");
  const fromSql = Object.fromEntries(
    [...body[1].matchAll(/WHEN '([^']+)' THEN INTERVAL '(\d+) days'/g)].map((m) => [m[1], Number(m[2])]),
  );
  assert.deepEqual(fromSql, { ...AGENT_DIGEST_BODY_RETENTION_DAYS });
});

test("the size CHECK uses the contract's payload limit", () => {
  assert.match(SQL, new RegExp(`"sizeBytes" <= ${AGENT_DIGEST_MAX_PAYLOAD_BYTES}\\)`));
});
