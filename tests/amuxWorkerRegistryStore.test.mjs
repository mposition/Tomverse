// Orchestration policy version 31, stage R1: the worker registry store and its
// migration (docs/policy/development-agent-orchestration.md, "버전 31").
//
// Runs without a database: the core's vocabularies against the migration's
// CHECKs and guard, the one-store rule, and the exact statements each store
// operation sends, counted on a recording transaction. What the database
// itself refuses is exercised against PostgreSQL in
// tests/integration/amux-worker-registry.db.test.ts.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { AMUX_DB_BOUNDARIES } from "../lib/amux/dbBoundary.ts";
import {
  AMUX_WORKER_DESIRED_STATES,
  AMUX_WORKER_LATCH_ACTOR_KINDS,
  AMUX_WORKER_LATCH_EVENT_KINDS,
  AMUX_WORKER_OBSERVATION_STATUSES,
  AMUX_WORKER_PROVIDER_CLASSES,
  AMUX_WORKER_PROVIDER_CLASS_TABLE,
  AMUX_WORKER_REGISTRY_AUDIT_ACTIONS,
  AMUX_WORKER_REGISTRY_BOOTSTRAP_ACTIVE,
  AMUX_WORKER_ROLE_CEILINGS,
  AMUX_WORKER_TRIAL_COST_CAP_MICRO_USD,
  AMUX_WORKER_TRIAL_CARD_COUNT,
  AMUX_WORKER_TRIAL_OUTCOMES,
} from "../lib/amux/workerRegistryCore.ts";
import {
  AmuxWorkerRegistryWriteError,
  readAmuxWorkerRegistryOrThrow,
  recordAmuxWorkerRegistryChangeByOwner,
} from "../lib/amux/workerRegistryStore.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const STORE = "lib/amux/workerRegistryStore.ts";
const MIGRATION = "prisma/migrations/20261012090000_amux_worker_registry/migration.sql";
const TABLES = ["AmuxWorkerRegistryEvent", "AmuxWorkerObservation", "AmuxWorkerTrialEvidence", "AmuxWorkerLatchEvent"];

const withoutSqlComments = (sql) =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

const checkList = (sql, name) => {
  const match = new RegExp(`"${name}"\\s*CHECK \\("\\w+" IN \\(([^)]*)\\)\\)`).exec(sql);
  assert.ok(match, `CHECK ${name} was found`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((item) => item[1]);
};

// ---------------------------------------------------------------------------
// The migration holds the core's rules
// ---------------------------------------------------------------------------

test("the migration's CHECKs hold exactly the core's vocabularies", () => {
  const sql = withoutSqlComments(read(MIGRATION));
  assert.deepEqual(checkList(sql, "AmuxWorkerRegistryEvent_provider_class_check"), [...AMUX_WORKER_PROVIDER_CLASSES]);
  assert.deepEqual(checkList(sql, "AmuxWorkerRegistryEvent_role_ceiling_check"), [...AMUX_WORKER_ROLE_CEILINGS]);
  assert.deepEqual(checkList(sql, "AmuxWorkerRegistryEvent_desired_state_check"), [...AMUX_WORKER_DESIRED_STATES]);
  assert.deepEqual(checkList(sql, "AmuxWorkerObservation_status_check"), [...AMUX_WORKER_OBSERVATION_STATUSES]);
  assert.deepEqual(checkList(sql, "AmuxWorkerTrialEvidence_outcome_check"), [...AMUX_WORKER_TRIAL_OUTCOMES]);
  assert.deepEqual(checkList(sql, "AmuxWorkerLatchEvent_event_kind_check"), [...AMUX_WORKER_LATCH_EVENT_KINDS]);
  assert.deepEqual(checkList(sql, "AmuxWorkerLatchEvent_actor_kind_check"), [...AMUX_WORKER_LATCH_ACTOR_KINDS]);
  // Every table holds the same name grammar as the core.
  const grammar = "'^(claude|codex|cursor|copilot)-[a-z0-9]{1,24}$'";
  for (const table of TABLES) {
    assert.ok(sql.includes(`"${table}_worker_name_check"\n      CHECK ("workerName" ~ ${grammar})`), table);
  }
  // Section 2: the verified classes alone may hold contract.
  const verified = AMUX_WORKER_PROVIDER_CLASSES.filter((name) => AMUX_WORKER_PROVIDER_CLASS_TABLE[name].verified);
  const belowContract = AMUX_WORKER_ROLE_CEILINGS.filter((role) => role !== "contract");
  assert.ok(
    sql.includes(
      `CHECK ("providerClass" IN (${verified.map((v) => `'${v}'`).join(", ")}) OR "roleCeiling" IN (${belowContract.map((v) => `'${v}'`).join(", ")}))`,
    ),
  );
  for (const name of AMUX_WORKER_PROVIDER_CLASSES.filter((n) => !verified.includes(n))) {
    assert.equal(AMUX_WORKER_PROVIDER_CLASS_TABLE[name].maxRole, "implementation");
  }
  // Activation gate 2's trial count and cost cap.
  assert.ok(sql.includes(`CHECK ("trialNumber" BETWEEN 1 AND ${AMUX_WORKER_TRIAL_CARD_COUNT})`));
  assert.ok(sql.includes(`CHECK ("costMicroUsd" IS NULL OR "costMicroUsd" BETWEEN 0 AND ${AMUX_WORKER_TRIAL_COST_CAP_MICRO_USD})`));
  // A latch is opened by the system and released by a person.
  assert.match(
    sql,
    /\("eventKind" = 'opened' AND "actorKind" = 'system' AND "actorUserId" IS NULL\)\s*OR \("eventKind" = 'released' AND "actorKind" = 'human' AND pg_catalog\.length\("actorUserId"\) > 0\)/,
  );
});

test("the migration is additive, and the registry guard holds the core's change rule", () => {
  const sql = withoutSqlComments(read(MIGRATION));
  assert.equal((sql.match(/^CREATE TABLE /gm) ?? []).length, 4);
  assert.equal((sql.match(/^CREATE OR REPLACE FUNCTION /gm) ?? []).length, 4);
  assert.equal((sql.match(/^CREATE TRIGGER /gm) ?? []).length, 4);
  assert.doesNotMatch(sql, /\bDROP\b|\bTRUNCATE\b|\bVALIDATE\b|^INSERT\b|^UPDATE\b|^DELETE\b/im);
  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  for (const table of TABLES) {
    assert.match(sql, new RegExp(`BEFORE INSERT OR UPDATE OR DELETE ON "${table}"`), table);
  }
  // Three tables carry an audit row each, which can never be removed under them.
  assert.equal((sql.match(/REFERENCES "AdminAuditLog"\("id"\) ON DELETE RESTRICT ON UPDATE RESTRICT/g) ?? []).length, 3);
  assert.equal((sql.match(/REFERENCES/g) ?? []).length, 3);

  const guard = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION "amux_worker_registry_event_guard"'),
    sql.indexOf('CREATE TRIGGER "amux_worker_registry_event_guard"'),
  );
  assert.match(guard, /SET search_path = pg_catalog, pg_temp/);
  assert.match(guard, /current_setting\('transaction_isolation'\) <> 'read committed'/);
  assert.match(guard, /pg_advisory_xact_lock\(\s*pg_catalog\.hashtext\('tomverse-amux-worker-registry:' \|\| NEW\."workerName"\)/);
  // The bootstrap list in the guard is the core's seven, and nothing else.
  const bootstrap = /NEW\."workerName" IN \(([^)]*)\)/.exec(guard);
  assert.ok(bootstrap);
  assert.deepEqual(
    [...bootstrap[1].matchAll(/'([^']*)'/g)].map((item) => item[1]),
    [...AMUX_WORKER_REGISTRY_BOOTSTRAP_ACTIVE],
  );
  for (const code of [
    "IMMUTABLE",
    "ISOLATION",
    "STALE_REVISION",
    "FIRST_STATE",
    "OUT_OF_ORDER",
    "CLASS_CHANGED",
    "RETIRED",
    "ACTIVATION",
    "ROLE_WIDENING",
    "UNAUDITED",
  ]) {
    assert.ok(guard.includes(`'AMUX_WORKER_REGISTRY_${code}'`), code);
  }
  assert.ok(guard.includes(`ARRAY[${AMUX_WORKER_ROLE_CEILINGS.map((role) => `'${role}'`).join(", ")}]`));
  assert.ok(guard.includes(`expected_action := '${AMUX_WORKER_REGISTRY_AUDIT_ACTIONS.register}'`));
  assert.ok(guard.includes(`expected_action := '${AMUX_WORKER_REGISTRY_AUDIT_ACTIONS.change}'`));
  // A person's audit of this very transaction, never a system actor's.
  assert.match(guard, /"actorUserId" = \$5 AND NOT coalesce\(.*systemActor.*\) AND xmin = pg_catalog\.pg_current_xact_id\(\)::xid/);
  assert.match(guard, /NEW\."createdAt" := pg_catalog\.clock_timestamp\(\)/);

  // R4 and R5 have not been reviewed: their tables refuse every write.
  for (const [fn, code] of [
    ["amux_worker_observation_guard", "AMUX_WORKER_OBSERVATION_CLOSED"],
    ["amux_worker_trial_evidence_guard", "AMUX_WORKER_TRIAL_EVIDENCE_CLOSED"],
    ["amux_worker_latch_event_guard", "AMUX_WORKER_LATCH_CLOSED"],
  ]) {
    const body = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION "${fn}"`), sql.indexOf(`CREATE TRIGGER "${fn}"`));
    assert.match(body, new RegExp(`BEGIN\\s+RAISE EXCEPTION '${code}';\\s+END;`), fn);
  }
});

// ---------------------------------------------------------------------------
// One store
// ---------------------------------------------------------------------------

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|mts|cts|mjs|js|cjs)$/.test(name) ? [path] : [];
  });

const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("one store module reaches the four tables; nothing else in the application does", () => {
  const delegates = TABLES.map((table) => table[0].toLowerCase() + table.slice(1));
  const reaches = new RegExp(
    [
      ...delegates.map((name) => `\\.\\s*${name}\\b|\\[\\s*["'\`]${name}["'\`]\\s*\\]`),
      `\\b(from|into|update|join|table)\\s+"?(${TABLES.join("|")})"?\\b`,
    ].join("|"),
    "i",
  );
  const files = ["app", "lib", "components", "scripts", "packages"]
    .flatMap((top) => walk(join(root, top)))
    .map((path) => relative(root, path).split("\\").join("/"));
  assert.ok(files.length > 200, "the scan must reach the application");
  const offenders = files.filter(
    (path) => path !== STORE && reaches.test(withoutComments(readFileSync(join(root, path), "utf8"))),
  );
  assert.deepEqual(offenders, []);
  const store = withoutComments(read(STORE));
  assert.match(store, /INSERT INTO "AmuxWorkerRegistryEvent"/);
  // The store writes nothing but registry events, and only through the
  // administrator writer's audit.
  assert.equal((store.match(/INSERT INTO/g) ?? []).length, 1);
  assert.doesNotMatch(store, /UPDATE "|DELETE FROM|systemActor|writeSystemAuditLog/);
});

// ---------------------------------------------------------------------------
// Statements per operation
// ---------------------------------------------------------------------------

const recordingTx = ({ newest = [], registry = [], latches = [], observations = [] } = {}) => {
  const sent = [];
  const tx = {
    $executeRaw: (strings, ...values) => {
      sent.push({ kind: "execute", sql: strings.join("$"), values });
      return Promise.resolve(1);
    },
    $queryRaw: (strings, ...values) => {
      const sql = strings.join("$");
      sent.push({ kind: "query", sql, values });
      if (sql.includes("AT TIME ZONE 'UTC'")) return Promise.resolve([{ createdAt: new Date("2026-10-12T00:00:00.000Z") }]);
      if (sql.includes('INSERT INTO "AmuxWorkerRegistryEvent"')) {
        return Promise.resolve([{ sequence: 7n, createdAtEpochMs: 1_791_000_000_000n }]);
      }
      if (sql.includes('FROM "AmuxWorkerRegistryEvent"') && sql.includes("LIMIT 1")) return Promise.resolve(newest);
      if (sql.includes('FROM "AmuxWorkerRegistryEvent"')) return Promise.resolve(registry);
      if (sql.includes('FROM "AmuxWorkerLatchEvent"')) return Promise.resolve(latches);
      if (sql.includes('FROM "AmuxWorkerObservation"')) return Promise.resolve(observations);
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

test("the read is three statements: newest registration, latch and observation of each worker", async () => {
  const { tx, sent } = recordingTx({
    registry: [
      { workerName: "claude-impl", providerClass: "claude", roleCeiling: "implementation", desiredState: "active", revision: 1, changedAtEpochMs: 1_791_000_000_000n },
    ],
    latches: [{ workerName: "claude-impl", eventKind: "released" }],
    observations: [{ workerName: "claude-impl", status: "ok" }],
  });
  const view = await readAmuxWorkerRegistryOrThrow(tx);
  assert.equal(sent.length, 3);
  assert.match(sent[0].sql, /SELECT DISTINCT ON \("workerName"\)[\s\S]*FROM "AmuxWorkerRegistryEvent"\s+ORDER BY "workerName", "sequence" DESC/);
  assert.match(sent[1].sql, /FROM "AmuxWorkerLatchEvent"\s+ORDER BY "workerName", "sequence" DESC/);
  assert.match(sent[2].sql, /FROM "AmuxWorkerObservation"\s+ORDER BY "workerName", "sequence" DESC/);
  assert.deepEqual(view.registrations, [
    {
      workerName: "claude-impl",
      providerClass: "claude",
      roleCeiling: "implementation",
      desiredState: "active",
      revision: 1,
      changedAt: new Date(1_791_000_000_000).toISOString(),
    },
  ]);
  assert.equal(view.latches.get("claude-impl"), "released");
  assert.equal(view.observations.get("claude-impl"), "ok");
});

test("a registry row the guard would not have accepted makes the registry unreadable; a bad latch throws", async () => {
  const bad = recordingTx({
    registry: [
      { workerName: "claude-impl", providerClass: "claude", roleCeiling: "implementation", desiredState: "active", revision: 1, changedAtEpochMs: 1n },
      { workerName: "cursor-impl", providerClass: "cursor", roleCeiling: "contract", desiredState: "requested", revision: 1, changedAtEpochMs: 1n },
    ],
  });
  assert.equal((await readAmuxWorkerRegistryOrThrow(bad.tx)).registrations, null);
  const latch = recordingTx({ latches: [{ workerName: "claude-impl", eventKind: "closed" }] });
  await assert.rejects(readAmuxWorkerRegistryOrThrow(latch.tx), /latch row outside its vocabulary/);
  const observation = recordingTx({ observations: [{ workerName: "claude-impl", status: "fine" }] });
  await assert.rejects(readAmuxWorkerRegistryOrThrow(observation.tx), /observation row outside its vocabulary/);
});

for (const [label, key, auditStatements] of [
  ["without", null, 3],
  ["with", "unit-test-integrity-key", 4],
]) {
  test(`an owner's registration sends ${3 + auditStatements} statements ${label} an integrity key, in order`, async () => {
    await withIntegrityKey(key, async () => {
      const { tx, sent } = recordingTx();
      const result = await recordAmuxWorkerRegistryChangeByOwner(tx, {
        session,
        workerName: "cursor-impl",
        roleCeiling: "implementation",
        desiredState: "requested",
        expectedRevision: 0,
      });
      assert.equal(sent.length, 3 + auditStatements);
      assert.deepEqual(
        sent.map((statement) => statement.kind),
        key === null
          ? ["execute", "query", "execute", "query", "create", "query"]
          : ["execute", "query", "execute", "query", "findFirst", "create", "query"],
      );
      assert.match(sent[0].sql, /pg_advisory_xact_lock\(hashtext\('tomverse-admin-audit-chain'\)\)/);
      assert.match(sent[1].sql, /FROM "AmuxWorkerRegistryEvent"\s+WHERE "workerName" = \$\s+ORDER BY "sequence" DESC\s+LIMIT 1/);
      assert.deepEqual(sent[1].values, ["cursor-impl"]);
      const audit = sent.find((statement) => statement.kind === "create").data;
      assert.equal(audit.action, "amux.worker.register");
      assert.equal(audit.targetType, "AmuxWorkerRegistryEvent");
      assert.equal(audit.targetId, result.eventId);
      assert.equal(audit.actorUserId, "owner-1");
      assert.deepEqual(audit.metadata, {
        event_id: result.eventId,
        worker_name: "cursor-impl",
        provider_class: "cursor",
        role_ceiling: "implementation",
        desired_state: "requested",
        revision: 1,
        previous_role_ceiling: null,
        previous_desired_state: null,
      });
      const insert = sent.at(-1);
      assert.match(insert.sql, /INSERT INTO "AmuxWorkerRegistryEvent"/);
      assert.deepEqual(insert.values, [result.eventId, "cursor-impl", "cursor", "implementation", "requested", 1, "owner-1", "audit-row-1"]);
      assert.deepEqual(result, {
        eventId: result.eventId,
        auditLogId: "audit-row-1",
        action: "amux.worker.register",
        workerName: "cursor-impl",
        revision: 1,
        sequence: "7",
        createdAt: new Date(1_791_000_000_000).toISOString(),
      });
    });
  });
}

test("a later change is audited as a change, over the revision the owner saw", async () => {
  await withIntegrityKey(null, async () => {
    const { tx, sent } = recordingTx({
      newest: [{ workerName: "claude-impl", providerClass: "claude", roleCeiling: "implementation", desiredState: "active", revision: 3 }],
    });
    const result = await recordAmuxWorkerRegistryChangeByOwner(tx, {
      session,
      workerName: "claude-impl",
      roleCeiling: "chore",
      desiredState: "paused",
      expectedRevision: 3,
    });
    assert.equal(result.action, "amux.worker.change");
    assert.equal(result.revision, 4);
    const audit = sent.find((statement) => statement.kind === "create").data;
    assert.equal(audit.metadata.previous_desired_state, "active");
    assert.equal(audit.metadata.previous_role_ceiling, "implementation");
    assert.equal(sent.at(-1).values[5], 4);
  });
});

test("a refused change writes nothing: bad input sends no statement, a refused rule stops after the read", async () => {
  for (const input of [
    { workerName: "devin-worker", roleCeiling: "chore", desiredState: "requested", expectedRevision: 0 },
    { workerName: "cursor-impl", roleCeiling: "review", desiredState: "requested", expectedRevision: 0 },
    { workerName: "cursor-impl", roleCeiling: "chore", desiredState: "autonomous", expectedRevision: 0 },
    { workerName: "cursor-impl", roleCeiling: "chore", desiredState: "requested", expectedRevision: "0" },
  ]) {
    const { tx, sent } = recordingTx();
    await assert.rejects(
      recordAmuxWorkerRegistryChangeByOwner(tx, { session, ...input }),
      (error) => error instanceof AmuxWorkerRegistryWriteError && error.code === "invalid_change",
    );
    assert.equal(sent.length, 0);
  }
  {
    const { tx, sent } = recordingTx();
    await assert.rejects(
      recordAmuxWorkerRegistryChangeByOwner(tx, {
        session: { expires: session.expires },
        workerName: "cursor-impl",
        roleCeiling: "chore",
        desiredState: "requested",
        expectedRevision: 0,
      }),
      (error) => error instanceof AmuxWorkerRegistryWriteError && error.code === "no_operator",
    );
    assert.equal(sent.length, 0);
  }
  for (const [newest, input, code] of [
    [[], { workerName: "cursor-impl", roleCeiling: "chore", desiredState: "active", expectedRevision: 0 }, "activation_requires_trial"],
    [[], { workerName: "cursor-impl", roleCeiling: "contract", desiredState: "requested", expectedRevision: 0 }, "role_above_class"],
    [
      [{ workerName: "codex-impl", providerClass: "codex", roleCeiling: "implementation", desiredState: "retired", revision: 2 }],
      { workerName: "codex-impl", roleCeiling: "implementation", desiredState: "requested", expectedRevision: 2 },
      "retired",
    ],
    [
      [{ workerName: "codex-impl", providerClass: "codex", roleCeiling: "implementation", desiredState: "active", revision: 2 }],
      { workerName: "codex-impl", roleCeiling: "implementation", desiredState: "paused", expectedRevision: 1 },
      "stale_revision",
    ],
    [
      [{ workerName: "codex-impl", providerClass: "claude", roleCeiling: "implementation", desiredState: "active", revision: 2 }],
      { workerName: "codex-impl", roleCeiling: "implementation", desiredState: "paused", expectedRevision: 2 },
      "unreadable_previous",
    ],
  ]) {
    const { tx, sent } = recordingTx({ newest });
    await assert.rejects(
      recordAmuxWorkerRegistryChangeByOwner(tx, { session, ...input }),
      (error) => error instanceof AmuxWorkerRegistryWriteError && error.code === code,
      code,
    );
    assert.deepEqual(sent.map((statement) => statement.kind), ["execute", "query"], code);
  }
});

test("the Admin route's DB boundaries are the store's statements at their largest, plus setup and fence", async () => {
  const largest = await withIntegrityKey("unit-test-integrity-key", async () => {
    const { tx, sent } = recordingTx();
    await recordAmuxWorkerRegistryChangeByOwner(tx, {
      session,
      workerName: "claude-impl",
      roleCeiling: "implementation",
      desiredState: "active",
      expectedRevision: 0,
    });
    return sent.length;
  });
  assert.equal(largest, 7);
  assert.deepEqual(AMUX_DB_BOUNDARIES.workerRegistryChange, {
    operation: "worker_registry_change",
    prismaCallCeiling: largest + 2,
    isolation: "mutation",
  });
  const { tx, sent } = recordingTx();
  await readAmuxWorkerRegistryOrThrow(tx);
  assert.deepEqual(AMUX_DB_BOUNDARIES.workerRegistryRead, {
    operation: "worker_registry_read",
    prismaCallCeiling: sent.length + 2,
    isolation: "read",
  });
});
