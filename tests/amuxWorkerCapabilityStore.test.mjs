// Orchestration policy version 35, stage R2a: the worker capability store and
// its migration. Runs without a database: the core's closed lists against the
// migration's CHECKs and guard, the one-store rule, and the exact statements
// each operation sends. The guard itself runs against PostgreSQL in
// tests/integration/amux-worker-capability.db.test.ts.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { AMUX_DB_BOUNDARIES } from "../lib/amux/dbBoundary.ts";
import {
  AMUX_WORKER_CAPABILITY_AUDIT_ACTION,
  AMUX_WORKER_ROUTING_TAGS,
  AMUX_WORKER_V22_ROLES,
  AMUX_WORKER_V22_TOOLS,
} from "../lib/amux/workerCapabilityCore.ts";
import {
  AmuxWorkerCapabilityWriteError,
  readAmuxWorkerCapabilitiesOrThrow,
  recordAmuxWorkerCapabilityByOwner,
} from "../lib/amux/workerCapabilityStore.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const STORE = "lib/amux/workerCapabilityStore.ts";
const MIGRATION = "prisma/migrations/20261013100000_amux_worker_capability/migration.sql";

const withoutSqlComments = (sql) =>
  sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

const arrayList = (sql, column) => {
  const match = new RegExp(`"${column}" <@ ARRAY\\[([^\\]]*)\\]`).exec(sql);
  assert.ok(match, `array CHECK on ${column}`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((item) => item[1]);
};

test("the migration's closed lists are the core's", () => {
  const sql = withoutSqlComments(read(MIGRATION));
  assert.deepEqual(arrayList(sql, "routingTags"), [...AMUX_WORKER_ROUTING_TAGS]);
  assert.deepEqual(arrayList(sql, "v22Roles"), [...AMUX_WORKER_V22_ROLES]);
  assert.deepEqual(arrayList(sql, "v22Tools"), [...AMUX_WORKER_V22_TOOLS]);
  assert.ok(sql.includes(`CHECK ("workerName" ~ '^(claude|codex|cursor|copilot)-[a-z0-9]{1,24}$')`));
});

test("the migration is additive and its guard holds the ceiling rule, the registry lock and the audit", () => {
  const sql = withoutSqlComments(read(MIGRATION));
  assert.equal((sql.match(/^CREATE TABLE /gm) ?? []).length, 1);
  assert.equal((sql.match(/^CREATE OR REPLACE FUNCTION /gm) ?? []).length, 1);
  assert.equal((sql.match(/^CREATE TRIGGER /gm) ?? []).length, 1);
  assert.doesNotMatch(sql, /\bDROP\b|\bTRUNCATE\b|\bVALIDATE\b|^INSERT\b|^UPDATE\b|^DELETE\b/im);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE ON "AmuxWorkerCapabilityEvent"/);
  assert.equal((sql.match(/REFERENCES "AdminAuditLog"\("id"\) ON DELETE RESTRICT ON UPDATE RESTRICT/g) ?? []).length, 1);
  const guard = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION "amux_worker_capability_event_guard"'));
  assert.match(guard, /SET search_path = pg_catalog, pg_temp/);
  assert.match(guard, /current_setting\('transaction_isolation'\) <> 'read committed'/);
  // The registry's lock first, then this table's.
  const registryLock = guard.indexOf("'tomverse-amux-worker-registry:'");
  const capabilityLock = guard.indexOf("'tomverse-amux-worker-capability:'");
  assert.ok(registryLock > 0 && capabilityLock > registryLock);
  for (const code of ["IMMUTABLE", "ISOLATION", "NOT_REGISTERED", "RETIRED", "DUPLICATE", "TOOLS", "TAG_CEILING", "TAG_VERIFIED",
    "V22_CLASS", "V22_ROLE", "STALE_REVISION", "OUT_OF_ORDER", "UNAUDITED"]) {
    assert.ok(guard.includes(`'AMUX_WORKER_CAPABILITY_${code}'`), code);
  }
  assert.ok(guard.includes(`'${AMUX_WORKER_CAPABILITY_AUDIT_ACTION}'`));
  assert.match(guard, /tag IN \('contract', 'architecture', 'security'\) AND ceiling_rank < 3/);
  assert.match(guard, /tag = 'implementation' AND ceiling_rank < 2/);
  assert.match(guard, /verified := registry_class IN \('claude', 'codex'\)/);
  assert.match(guard, /role = 'investigate' AND NOT \('repo_read' = ANY/);
});

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|mts|cts|mjs|js|cjs)$/.test(name) ? [path] : [];
  });
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("one store module reaches the capability table", () => {
  const reaches = /\.\s*amuxWorkerCapabilityEvent\b|\[\s*["'`]amuxWorkerCapabilityEvent["'`]\s*\]|\b(from|into|update|join|table)\s+"?AmuxWorkerCapabilityEvent"?\b/i;
  const files = ["app", "lib", "components", "scripts", "packages"]
    .flatMap((top) => walk(join(root, top)))
    .map((path) => relative(root, path).split("\\").join("/"));
  assert.ok(files.length > 200);
  const offenders = files.filter((path) => path !== STORE && reaches.test(withoutComments(readFileSync(join(root, path), "utf8"))));
  assert.deepEqual(offenders, []);
  const store = withoutComments(read(STORE));
  assert.equal((store.match(/INSERT INTO/g) ?? []).length, 1);
  assert.doesNotMatch(store, /UPDATE "|DELETE FROM|systemActor|writeSystemAuditLog/);
});

const recordingTx = ({ registry = [], capability = [], all = [] } = {}) => {
  const sent = [];
  const tx = {
    $executeRaw: (strings, ...values) => {
      sent.push({ kind: "execute", sql: strings.join("$"), values });
      return Promise.resolve(1);
    },
    $queryRaw: (strings, ...values) => {
      const sql = strings.join("$");
      sent.push({ kind: "query", sql, values });
      if (sql.includes("AT TIME ZONE 'UTC'")) return Promise.resolve([{ createdAt: new Date("2026-10-13T00:00:00.000Z") }]);
      if (sql.includes('INSERT INTO "AmuxWorkerCapabilityEvent"')) return Promise.resolve([{ sequence: 3n, createdAtEpochMs: 1_791_100_000_000n }]);
      if (sql.includes('FROM "AmuxWorkerRegistryEvent"')) return Promise.resolve(registry);
      if (sql.includes('FROM "AmuxWorkerCapabilityEvent"') && sql.includes("LIMIT 1")) return Promise.resolve(capability);
      if (sql.includes('FROM "AmuxWorkerCapabilityEvent"')) return Promise.resolve(all);
      return Promise.reject(new Error(`unexpected statement: ${sql}`));
    },
    adminAuditLog: {
      findFirst: (query) => {
        sent.push({ kind: "findFirst", query });
        return Promise.resolve(null);
      },
      create: (query) => {
        sent.push({ kind: "create", data: query.data });
        return Promise.resolve({ id: "audit-row-1" });
      },
    },
  };
  return { tx, sent };
};

const withIntegrityKey = async (key, work) => {
  const names = ["ADMIN_AUDIT_INTEGRITY_KEY", "ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS", "NEXTAUTH_SECRET"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  if (key !== null) process.env.ADMIN_AUDIT_INTEGRITY_KEY = key;
  try {
    return await work();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
};

const session = { user: { id: "owner-1", email: "owner@example.test" }, expires: "2099-01-01T00:00:00.000Z" };
const CHORE = [{ workerName: "claude-chore", providerClass: "claude", roleCeiling: "chore", desiredState: "active", revision: 1 }];
const CAPABILITY = {
  model: null,
  routingTags: ["chore"],
  toolCapabilities: [],
  v22: { model: "claude-opus-5-5", roles: ["investigate"], tools: ["repo_read"] },
};

test("the read is one statement; a row outside its shape throws", async () => {
  const { tx, sent } = recordingTx({
    all: [{ workerName: "claude-chore", revision: 2, model: null, routingTags: ["chore"], toolCapabilities: [], v22Model: null, v22Roles: null, v22Tools: null, changedAtEpochMs: 1n }],
  });
  const entries = await readAmuxWorkerCapabilitiesOrThrow(tx);
  assert.equal(sent.length, 1);
  assert.deepEqual(entries.get("claude-chore").capability, { model: null, routingTags: ["chore"], toolCapabilities: [], v22: null });
  const bad = recordingTx({ all: [{ workerName: "devin-worker", revision: 1, routingTags: [], toolCapabilities: [], changedAtEpochMs: 1n }] });
  await assert.rejects(readAmuxWorkerCapabilitiesOrThrow(bad.tx), /outside its shape/);
  // A row the guard would not have accepted fails the read too.
  const base = { workerName: "claude-chore", revision: 1, model: null, routingTags: ["chore"], toolCapabilities: [], v22Model: null, v22Roles: null, v22Tools: null, changedAtEpochMs: 1n };
  for (const row of [
    { ...base, routingTags: [] },
    { ...base, revision: 0 },
    { ...base, v22Model: "claude-opus-5-5" },
    { ...base, v22Model: "claude-opus-5-5", v22Roles: [], v22Tools: ["repo_read"] },
  ]) {
    await assert.rejects(readAmuxWorkerCapabilitiesOrThrow(recordingTx({ all: [row] }).tx), /outside its shape/);
  }
});

for (const [label, key, auditStatements] of [["without", null, 3], ["with", "unit-test-integrity-key", 4]]) {
  test(`an owner's capability write sends ${4 + auditStatements} statements ${label} an integrity key, in order`, async () => {
    await withIntegrityKey(key, async () => {
      const { tx, sent } = recordingTx({ registry: CHORE });
      const result = await recordAmuxWorkerCapabilityByOwner(tx, { session, workerName: "claude-chore", expectedRevision: 0, capability: CAPABILITY });
      assert.equal(sent.length, 4 + auditStatements);
      assert.match(sent[0].sql, /pg_advisory_xact_lock\(hashtext\('tomverse-admin-audit-chain'\)\)/);
      assert.match(sent[1].sql, /FROM "AmuxWorkerRegistryEvent"/);
      assert.match(sent[2].sql, /FROM "AmuxWorkerCapabilityEvent"/);
      const audit = sent.find((statement) => statement.kind === "create").data;
      assert.equal(audit.action, "amux.worker.capability");
      assert.equal(audit.targetType, "AmuxWorkerCapabilityEvent");
      assert.equal(audit.targetId, result.eventId);
      const insert = sent.at(-1);
      assert.match(insert.sql, /INSERT INTO "AmuxWorkerCapabilityEvent"/);
      assert.deepEqual(insert.values, [result.eventId, "claude-chore", 1, null, ["chore"], [], "claude-opus-5-5", ["investigate"], ["repo_read"], "owner-1", "audit-row-1"]);
      assert.equal(result.revision, 1);
    });
  });
}

test("a refused write sends no audit: bad shape sends nothing; a rule refusal stops after the reads", async () => {
  for (const input of [
    { workerName: "Devin_worker", expectedRevision: 0, capability: CAPABILITY },
    { workerName: "claude-chore", expectedRevision: "0", capability: CAPABILITY },
    { workerName: "claude-chore", expectedRevision: 0, capability: { ...CAPABILITY, routingTags: "chore" } },
  ]) {
    const { tx, sent } = recordingTx({ registry: CHORE });
    await assert.rejects(recordAmuxWorkerCapabilityByOwner(tx, { session, ...input }),
      (error) => error instanceof AmuxWorkerCapabilityWriteError && error.code === "invalid_change");
    assert.equal(sent.length, 0);
  }
  for (const [registry, capability, expectedRevision, code, current] of [
    [CHORE, { ...CAPABILITY, routingTags: ["implementation"] }, 0, "tag_above_ceiling", []],
    [[], CAPABILITY, 0, "not_registered", []],
    [CHORE, CAPABILITY, 0, "stale_revision", [{ revision: 2 }]],
  ]) {
    const { tx, sent } = recordingTx({ registry, capability: current });
    await assert.rejects(recordAmuxWorkerCapabilityByOwner(tx, { session, workerName: "claude-chore", expectedRevision, capability }),
      (error) => error instanceof AmuxWorkerCapabilityWriteError && error.code === code, code);
    assert.deepEqual(sent.map((statement) => statement.kind), ["execute", "query", "query"], code);
  }
});

test("the boundaries are the store's statements at their largest, plus setup and fence", async () => {
  const largest = await withIntegrityKey("unit-test-integrity-key", async () => {
    const { tx, sent } = recordingTx({ registry: CHORE });
    await recordAmuxWorkerCapabilityByOwner(tx, { session, workerName: "claude-chore", expectedRevision: 0, capability: CAPABILITY });
    return sent.length;
  });
  assert.equal(largest, 8);
  assert.deepEqual(AMUX_DB_BOUNDARIES.workerCapabilityChange, { operation: "worker_capability_change", prismaCallCeiling: largest + 2, isolation: "mutation" });
  const { tx, sent } = recordingTx();
  await readAmuxWorkerCapabilitiesOrThrow(tx);
  assert.deepEqual(AMUX_DB_BOUNDARIES.workerCapabilityRead, { operation: "worker_capability_read", prismaCallCeiling: sent.length + 2, isolation: "read" });
});
