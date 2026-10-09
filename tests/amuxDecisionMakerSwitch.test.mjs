// AMUX Decision Maker policy version 1, stage S1b: the switch store
// (docs/policy/amux-decision-maker.md §8, §10).
//
// Runs without a database: the pure mapping and vocabularies, their parity
// with the migration's CHECKs and trigger, the one-writer rule, and the exact
// statements each store operation sends (§9's statement budget), counted on a
// recording transaction. What the database itself refuses is exercised against
// PostgreSQL in tests/integration/amux-decision-maker-switch.db.test.ts.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import {
  AMUX_DECISION_MAKER_SYSTEM_AUDIT_ACTORS,
  SYSTEM_AUDIT_ACTORS,
  auditRowActorKind,
  isSystemAuditActor,
} from "../lib/adminAuditSystemActors.ts";
import { DM_INSTANCE_FOR_PROVIDER, routeDmQuestion } from "../lib/amux/decisionMakerCore.ts";
import {
  DM_INSTANCE_MODES,
  DM_INSTANCE_SCOPES,
  DM_KILL_SWITCH_SCOPE,
  DM_KILL_SWITCH_VALUES,
  DM_SWITCH_ACTOR_KINDS,
  DM_SWITCH_AUDIT_ACTIONS,
  DM_SWITCH_AUDIT_METADATA_KEYS,
  DM_SWITCH_AUDIT_TARGET_TYPE,
  DM_SWITCH_LATCH_ACTOR_FOR_INSTANCE,
  DM_SWITCH_LATCH_REASONS,
  DM_SWITCH_REASON_CODES,
  DM_SWITCH_SCOPES,
  DM_SWITCH_VALUES,
  decisionMakerSwitchStateFromRows,
  defaultDecisionMakerSwitches,
  dmOperatorSwitchAction,
  dmSwitchAuditMetadata,
  dmSwitchRoutingInput,
  parseDmOperatorSwitchChange,
  parseDmSwitchLatch,
  unreadableDecisionMakerSwitches,
} from "../lib/amux/decisionMakerSwitchCore.ts";
import { AMUX_DB_BOUNDARIES } from "../lib/amux/dbBoundary.ts";
import {
  DecisionMakerSwitchWriteError,
  latchDecisionMakerInstanceOff,
  readDecisionMakerSwitches,
  readDecisionMakerSwitchesOrThrow,
  recordDecisionMakerSwitchByOperator,
} from "../lib/amux/decisionMakerSwitchStore.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const STORE = "lib/amux/decisionMakerSwitchStore.ts";
const MIGRATION = "prisma/migrations/20261008030000_amux_decision_maker_switch/migration.sql";

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
// Vocabularies
// ---------------------------------------------------------------------------

test("the switch vocabularies are the policy's, and no list holds an autonomous value", () => {
  assert.deepEqual([...DM_SWITCH_SCOPES], ["kill_switch", "decision-maker-openai", "decision-maker-anthropic"]);
  assert.deepEqual([...DM_INSTANCE_MODES], ["off", "proposal"]);
  assert.deepEqual([...DM_KILL_SWITCH_VALUES], ["on", "off"]);
  assert.deepEqual([...DM_SWITCH_VALUES], ["on", "off", "proposal"]);
  assert.deepEqual([...DM_SWITCH_REASON_CODES], ["operator", "validation_latch", "cleanup_latch"]);
  assert.deepEqual([...DM_SWITCH_LATCH_REASONS], ["validation_latch", "cleanup_latch"]);
  assert.deepEqual([...DM_SWITCH_ACTOR_KINDS], ["human", "system"]);
  for (const list of [DM_SWITCH_SCOPES, DM_INSTANCE_MODES, DM_KILL_SWITCH_VALUES, DM_SWITCH_VALUES]) {
    assert.equal(list.some((value) => /autonom/i.test(value)), false);
  }
  // §10's action names for the switch store, and nothing else.
  assert.deepEqual(DM_SWITCH_AUDIT_ACTIONS, {
    mode: "amux.decision.mode",
    latchRelease: "amux.decision.latch_release",
    latch: "amux.decision.latch",
  });
  assert.equal(DM_SWITCH_AUDIT_TARGET_TYPE, "AmuxDecisionMakerSwitchEvent");
});

test("the instance scopes are the S1a router's instances, one per vendor", () => {
  assert.deepEqual([...DM_INSTANCE_SCOPES].sort(), Object.values(DM_INSTANCE_FOR_PROVIDER).sort());
  assert.equal(DM_KILL_SWITCH_SCOPE, "kill_switch");
});

test("the migration's CHECKs hold exactly the lists, and pair scope, value, actor and reason", () => {
  const sql = withoutSqlComments(read(MIGRATION));
  assert.deepEqual(checkList(sql, "AmuxDecisionMakerSwitchEvent_scope_check"), [...DM_SWITCH_SCOPES]);
  assert.deepEqual(checkList(sql, "AmuxDecisionMakerSwitchEvent_value_check"), [...DM_SWITCH_VALUES]);
  assert.deepEqual(checkList(sql, "AmuxDecisionMakerSwitchEvent_reason_code_check"), [...DM_SWITCH_REASON_CODES]);
  assert.deepEqual(checkList(sql, "AmuxDecisionMakerSwitchEvent_actor_kind_check"), [...DM_SWITCH_ACTOR_KINDS]);
  assert.match(
    sql,
    /\("scope" = 'kill_switch' AND "value" IN \('on', 'off'\)\)\s*OR \("scope" <> 'kill_switch' AND "value" IN \('off', 'proposal'\)\)/,
  );
  assert.match(sql, /CHECK \(\("actorKind" = 'human'\) = \("actorUserId" IS NOT NULL\)\)/);
  assert.match(
    sql,
    /\("actorKind" = 'human' AND "reasonCode" = 'operator'\)\s*OR \(\s*"actorKind" = 'system'\s*AND "reasonCode" IN \('validation_latch', 'cleanup_latch'\)\s*AND "scope" <> 'kill_switch'\s*AND "value" = 'off'\s*\)/,
  );
});

test("the migration is additive, and its trigger binds each event to its own transaction's audit", () => {
  const sql = withoutSqlComments(read(MIGRATION));
  assert.equal((sql.match(/^CREATE TABLE /gm) ?? []).length, 1);
  assert.equal((sql.match(/^CREATE OR REPLACE FUNCTION /gm) ?? []).length, 1);
  assert.equal((sql.match(/^CREATE TRIGGER /gm) ?? []).length, 1);
  assert.equal((sql.match(/^ALTER TABLE /gm) ?? []).length, 1);
  assert.doesNotMatch(sql, /\bDROP\b|\bTRUNCATE\b|\bVALIDATE\b|^INSERT\b|^UPDATE\b|^DELETE\b/im);
  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  // One audit row per event, and one that can never be removed under it.
  assert.match(sql, /CREATE UNIQUE INDEX "AmuxDecisionMakerSwitchEvent_auditLogId_key"/);
  assert.match(
    sql,
    /FOREIGN KEY \("auditLogId"\) REFERENCES "AdminAuditLog"\("id"\) ON DELETE RESTRICT ON UPDATE RESTRICT/,
  );
  assert.equal((sql.match(/REFERENCES/g) ?? []).length, 1);
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE ON "AmuxDecisionMakerSwitchEvent"/);

  const guard = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION "amux_decision_maker_switch_event_guard"'));
  assert.match(guard, /SET search_path = pg_catalog, pg_temp/);
  assert.match(guard, /IF TG_OP <> 'INSERT' THEN\s*RAISE EXCEPTION 'AMUX_DM_SWITCH_IMMUTABLE';/);
  assert.match(guard, /pg_advisory_xact_lock\(/);
  assert.match(guard, /AMUX_DM_SWITCH_OUT_OF_ORDER/);
  assert.match(guard, /AMUX_DM_SWITCH_UNAUDITED/);
  assert.match(guard, /NEW\."createdAt" := pg_catalog\.clock_timestamp\(\);/);
  // Both audit reads require the row to be this transaction's.
  assert.equal((guard.match(/xmin = pg_catalog\.pg_current_xact_id\(\)::xid/g) ?? []).length, 2);
  // The action rule is the core's.
  assert.match(
    guard,
    new RegExp(
      `WHEN newest_actor_kind = 'system' THEN '${DM_SWITCH_AUDIT_ACTIONS.latchRelease.replaceAll(".", "\\.")}'\\s*ELSE '${DM_SWITCH_AUDIT_ACTIONS.mode.replaceAll(".", "\\.")}'`,
    ),
  );
  assert.ok(guard.includes(`'${DM_SWITCH_AUDIT_ACTIONS.latch}'`));
  // The latch actor is the instance's own, as in the core.
  for (const [instance, actor] of Object.entries(DM_SWITCH_LATCH_ACTOR_FOR_INSTANCE)) {
    assert.ok(guard.includes(`WHEN '${instance}' THEN '${actor}'`), instance);
  }
});

// ---------------------------------------------------------------------------
// Row to state
// ---------------------------------------------------------------------------

test("no event reads as the default: kill switch off and both instances off", () => {
  assert.deepEqual(decisionMakerSwitchStateFromRows([]), {
    killSwitch: false,
    instances: { "decision-maker-openai": "off", "decision-maker-anthropic": "off" },
  });
  assert.deepEqual(defaultDecisionMakerSwitches(), decisionMakerSwitchStateFromRows([]));
});

test("each scope's newest event sets that scope only", () => {
  assert.deepEqual(
    decisionMakerSwitchStateFromRows([
      { scope: "decision-maker-openai", value: "proposal" },
      { scope: "kill_switch", value: "on" },
    ]),
    {
      killSwitch: true,
      instances: { "decision-maker-openai": "proposal", "decision-maker-anthropic": "off" },
    },
  );
  assert.deepEqual(
    decisionMakerSwitchStateFromRows([
      { scope: "kill_switch", value: "off" },
      { scope: "decision-maker-anthropic", value: "proposal" },
      { scope: "decision-maker-openai", value: "off" },
    ]),
    {
      killSwitch: false,
      instances: { "decision-maker-openai": "off", "decision-maker-anthropic": "proposal" },
    },
  );
});

test("any row the lists do not accept makes every field unreadable", () => {
  const unreadable = unreadableDecisionMakerSwitches();
  assert.deepEqual(unreadable, {
    killSwitch: null,
    instances: { "decision-maker-openai": null, "decision-maker-anthropic": null },
  });
  for (const rows of [
    null,
    undefined,
    "kill_switch",
    {},
    [null],
    ["kill_switch"],
    [{ scope: "decision-maker-openai", value: "autonomous" }],
    [{ scope: "kill_switch", value: "proposal" }],
    [{ scope: "decision-maker-openai", value: "on" }],
    [{ scope: "decision-maker-gemini", value: "off" }],
    [{ scope: "Kill_Switch", value: "off" }],
    [{ scope: "toString", value: "off" }],
    [{ scope: "kill_switch" }],
    // One newest event per scope; two is a read that cannot be trusted.
    [
      { scope: "decision-maker-openai", value: "off" },
      { scope: "decision-maker-openai", value: "proposal" },
    ],
    // A good row does not rescue a bad one.
    [
      { scope: "kill_switch", value: "off" },
      { scope: "decision-maker-anthropic", value: "autonomous" },
    ],
  ]) {
    assert.deepEqual(decisionMakerSwitchStateFromRows(rows), unreadable, JSON.stringify(rows));
  }
});

test("the router reads the state fail-closed: unreadable and default both reach the operator", () => {
  const card = {
    askType: "decision",
    resolution: null,
    type: "task",
    tags: [],
    title: "Pick a cache key layout",
    question: "Should the cache key include the locale or only the model id?",
    options: [
      { id: "a", label: "Model id only" },
      { id: "b", label: "Model id and locale" },
    ],
    unblocks: "The cache module can be finished.",
    context: "Both layouts pass the current tests.",
    contextPaths: ["lib/cache.ts"],
  };
  const route = (state, askingProvider = "claude") =>
    routeDmQuestion({
      ...dmSwitchRoutingInput(state, DM_INSTANCE_FOR_PROVIDER[askingProvider] ?? null),
      card,
      askingProvider,
      throughput: { lastHour: 0, lastDay: 0 },
    });
  assert.deepEqual(route(unreadableDecisionMakerSwitches()).refusals, ["settings_unreadable"]);
  assert.deepEqual(route(decisionMakerSwitchStateFromRows([])).refusals, ["instance_off"]);
  const proposing = decisionMakerSwitchStateFromRows([{ scope: "decision-maker-openai", value: "proposal" }]);
  assert.equal(route(proposing).route, "dm_proposal");
  // The other instance is still off.
  assert.deepEqual(route(proposing, "codex").refusals, ["instance_off"]);
  const killed = decisionMakerSwitchStateFromRows([
    { scope: "decision-maker-openai", value: "proposal" },
    { scope: "kill_switch", value: "on" },
  ]);
  assert.deepEqual(route(killed).refusals, ["kill_switch_on"]);
  assert.deepEqual(dmSwitchRoutingInput(proposing, null), { killSwitch: false, instanceMode: null });
  assert.deepEqual(dmSwitchRoutingInput(proposing, "constructor"), { killSwitch: false, instanceMode: null });
});

// ---------------------------------------------------------------------------
// Writer inputs
// ---------------------------------------------------------------------------

test("a person may set the kill switch on or off and an instance off or proposal, nothing else", () => {
  assert.deepEqual(parseDmOperatorSwitchChange("kill_switch", "on"), { scope: "kill_switch", value: "on" });
  assert.deepEqual(parseDmOperatorSwitchChange("kill_switch", "off"), { scope: "kill_switch", value: "off" });
  for (const instance of DM_INSTANCE_SCOPES) {
    assert.deepEqual(parseDmOperatorSwitchChange(instance, "off"), { scope: instance, value: "off" });
    assert.deepEqual(parseDmOperatorSwitchChange(instance, "proposal"), { scope: instance, value: "proposal" });
  }
  for (const [scope, value] of [
    ["decision-maker-openai", "autonomous"],
    ["decision-maker-anthropic", "on"],
    ["kill_switch", "proposal"],
    ["kill_switch", "autonomous"],
    ["kill_switch", true],
    ["decision-maker-gemini", "off"],
    ["", "off"],
    [null, "off"],
    ["toString", "off"],
  ]) {
    assert.equal(parseDmOperatorSwitchChange(scope, value), null, `${scope}/${value}`);
  }
});

test("the system only latches an instance, for a latch reason", () => {
  assert.deepEqual(parseDmSwitchLatch("decision-maker-openai", "validation_latch"), {
    instance: "decision-maker-openai",
    reason: "validation_latch",
  });
  assert.deepEqual(parseDmSwitchLatch("decision-maker-anthropic", "cleanup_latch"), {
    instance: "decision-maker-anthropic",
    reason: "cleanup_latch",
  });
  for (const [instance, reason] of [
    ["kill_switch", "validation_latch"],
    ["decision-maker-openai", "operator"],
    ["decision-maker-openai", ""],
    ["decision-maker-gemini", "cleanup_latch"],
  ]) {
    assert.equal(parseDmSwitchLatch(instance, reason), null, `${instance}/${reason}`);
  }
});

test("a person's first change after a system latch is recorded as its release", () => {
  assert.equal(dmOperatorSwitchAction(null), "amux.decision.mode");
  assert.equal(dmOperatorSwitchAction("human"), "amux.decision.mode");
  assert.equal(dmOperatorSwitchAction("system"), "amux.decision.latch_release");
});

test("switch audit metadata carries closed keys and short identifiers only", () => {
  assert.deepEqual(
    dmSwitchAuditMetadata({ event_id: "e", scope: "kill_switch", value: "on", reason_code: "operator", previous_value: null }),
    { event_id: "e", scope: "kill_switch", value: "on", reason_code: "operator" },
  );
  assert.deepEqual([...DM_SWITCH_AUDIT_METADATA_KEYS], ["event_id", "scope", "value", "reason_code", "previous_value"]);
  assert.throws(() => dmSwitchAuditMetadata({ systemActor: "amux-decision-router" }), /key refused/);
  assert.throws(() => dmSwitchAuditMetadata({ note: "x" }), /key refused/);
  assert.throws(() => dmSwitchAuditMetadata({ value: "Turn it on please" }), /value refused/);
  assert.throws(() => dmSwitchAuditMetadata({ value: "x".repeat(65) }), /value refused/);
});

// ---------------------------------------------------------------------------
// System actors
// ---------------------------------------------------------------------------

test("the three DM actors are listed system actors, and a row they mark is never a person", () => {
  assert.deepEqual([...AMUX_DECISION_MAKER_SYSTEM_AUDIT_ACTORS], [
    "amux-decision-router",
    "amux-decision-maker-openai",
    "amux-decision-maker-anthropic",
  ]);
  for (const actor of AMUX_DECISION_MAKER_SYSTEM_AUDIT_ACTORS) {
    assert.ok(SYSTEM_AUDIT_ACTORS.includes(actor), actor);
    assert.equal(isSystemAuditActor(actor), true, actor);
    const row = {
      action: "amux.decision.latch",
      targetType: DM_SWITCH_AUDIT_TARGET_TYPE,
      actorUserId: null,
      actorEmail: null,
      ipAddress: null,
      userAgent: null,
      metadata: { systemActor: actor },
    };
    assert.equal(auditRowActorKind(row), "system", actor);
    // A marker beside a person's id is not a person either (§1).
    assert.equal(auditRowActorKind({ ...row, actorUserId: "someone" }), "unknown", actor);
  }
  for (const actor of Object.values(DM_SWITCH_LATCH_ACTOR_FOR_INSTANCE)) {
    assert.ok(AMUX_DECISION_MAKER_SYSTEM_AUDIT_ACTORS.includes(actor), actor);
  }
  assert.deepEqual(Object.keys(DM_SWITCH_LATCH_ACTOR_FOR_INSTANCE).sort(), [...DM_INSTANCE_SCOPES].sort());
});

// ---------------------------------------------------------------------------
// One writer
// ---------------------------------------------------------------------------

const walk = (directory) =>
  readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|mts|cts|mjs|js|cjs)$/.test(name) ? [path] : [];
  });

const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("one store module reads and writes the table; nothing else in the application reaches it", () => {
  // §10: "단일 writer 모듈이 위 표들에 쓴다." A delegate or a SQL statement on the
  // table anywhere else is a second writer, or a reader that bypasses the
  // fail-closed mapping.
  const reaches =
    /\.\s*amuxDecisionMakerSwitchEvent\b|\[\s*["'`]amuxDecisionMakerSwitchEvent["'`]\s*\]|\b(from|into|update|join|table)\s+"?AmuxDecisionMakerSwitchEvent"?\b/i;
  const files = ["app", "lib", "components", "scripts", "packages"]
    .flatMap((top) => walk(join(root, top)))
    .map((path) => relative(root, path).split("\\").join("/"));
  assert.ok(files.length > 200, "the scan must reach the application");
  const offenders = files.filter(
    (path) => path !== STORE && reaches.test(withoutComments(readFileSync(join(root, path), "utf8"))),
  );
  assert.deepEqual(offenders, []);
  const store = read(STORE);
  assert.match(store, /INSERT INTO "AmuxDecisionMakerSwitchEvent"/);
  assert.match(store, /FROM "AmuxDecisionMakerSwitchEvent"/);
  // The store never names the reserved marker: it writes a person's entry
  // through the administrator writer, and the latch's system entry through
  // its own module.
  assert.doesNotMatch(store, /systemActor|writeSystemAuditLog/);
  assert.match(read("lib/amux/decisionMakerSwitchSystemAudit.ts"), /writeSystemAuditLog\(\{/);
  assert.doesNotMatch(read("lib/amux/decisionMakerSwitchSystemAudit.ts"), /writeAdminAuditLog/);
  // Nothing updates or deletes an event.
  assert.doesNotMatch(withoutComments(store), /UPDATE "AmuxDecisionMakerSwitchEvent"|DELETE FROM "AmuxDecisionMakerSwitchEvent"/);
});

// ---------------------------------------------------------------------------
// Statements per operation (§9: 12 at most, pinned exactly)
// ---------------------------------------------------------------------------

const recordingTx = ({ newest = [], failRead = false } = {}) => {
  const sent = [];
  const tx = {
    $executeRaw: (strings, ...values) => {
      sent.push({ kind: "execute", sql: strings.join("$"), values });
      return Promise.resolve(1);
    },
    $queryRaw: (strings, ...values) => {
      const sql = strings.join("$");
      sent.push({ kind: "query", sql, values });
      if (failRead) return Promise.reject(new Error("relation does not exist"));
      if (sql.includes("AT TIME ZONE 'UTC'")) return Promise.resolve([{ createdAt: new Date("2026-10-07T00:00:00.000Z") }]);
      if (sql.includes('INSERT INTO "AmuxDecisionMakerSwitchEvent"')) {
        return Promise.resolve([{ sequence: 41n, createdAtEpochMs: 1_790_000_000_000n }]);
      }
      if (sql.includes('SELECT "actorKind", "value"')) return Promise.resolve(newest);
      if (sql.includes("DISTINCT ON")) return Promise.resolve([{ scope: "decision-maker-openai", value: "proposal" }]);
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

const session = { user: { id: "operator-1", email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" };

test("the read is one statement, and a failed read is the unreadable state", async () => {
  const ok = recordingTx();
  assert.deepEqual(await readDecisionMakerSwitches(ok.tx), {
    killSwitch: false,
    instances: { "decision-maker-openai": "proposal", "decision-maker-anthropic": "off" },
  });
  assert.equal(ok.sent.length, 1);
  assert.match(ok.sent[0].sql, /SELECT DISTINCT ON \("scope"\) "scope", "value"\s+FROM "AmuxDecisionMakerSwitchEvent"\s+ORDER BY "scope", "sequence" DESC/);
  const failed = recordingTx({ failRead: true });
  assert.deepEqual(await readDecisionMakerSwitches(failed.tx), unreadableDecisionMakerSwitches());
});

for (const [label, key, auditStatements] of [
  ["without", null, 3],
  ["with", "unit-test-integrity-key", 4],
]) {
  test(`a person's change sends ${3 + auditStatements} statements ${label} an integrity key, in order`, async () => {
    await withIntegrityKey(key, async () => {
      const { tx, sent } = recordingTx();
      const result = await recordDecisionMakerSwitchByOperator(tx, {
        session,
        scope: "decision-maker-openai",
        value: "proposal",
      });
      assert.equal(sent.length, 3 + auditStatements);
      assert.ok(sent.length <= 12);
      const kinds = sent.map((statement) => statement.kind);
      assert.deepEqual(
        kinds,
        key === null
          ? ["execute", "query", "execute", "query", "create", "query"]
          : ["execute", "query", "execute", "query", "findFirst", "create", "query"],
      );
      // Chain lock first, then the scope's newest event, then the audit, then the event.
      assert.match(sent[0].sql, /pg_advisory_xact_lock\(hashtext\('tomverse-admin-audit-chain'\)\)/);
      assert.match(sent[1].sql, /SELECT "actorKind", "value"\s+FROM "AmuxDecisionMakerSwitchEvent"\s+WHERE "scope" = \$/);
      assert.deepEqual(sent[1].values, ["decision-maker-openai"]);
      const audit = sent.find((statement) => statement.kind === "create").data;
      assert.equal(audit.action, "amux.decision.mode");
      assert.equal(audit.targetType, "AmuxDecisionMakerSwitchEvent");
      assert.equal(audit.targetId, result.eventId);
      assert.equal(audit.actorUserId, "operator-1");
      assert.deepEqual(audit.metadata, {
        event_id: result.eventId,
        scope: "decision-maker-openai",
        value: "proposal",
        reason_code: "operator",
      });
      const insert = sent.at(-1);
      assert.match(insert.sql, /INSERT INTO "AmuxDecisionMakerSwitchEvent"/);
      assert.match(insert.sql, /'operator', 'human'/);
      assert.deepEqual(insert.values, [result.eventId, "decision-maker-openai", "proposal", "operator-1", "audit-row-1"]);
      assert.deepEqual(result, {
        eventId: result.eventId,
        auditLogId: "audit-row-1",
        sequence: "41",
        createdAt: new Date(1_790_000_000_000).toISOString(),
        action: "amux.decision.mode",
      });
    });
  });

  test(`a latch sends ${1 + auditStatements} statements ${label} an integrity key, under the instance's own actor`, async () => {
    await withIntegrityKey(key, async () => {
      const { tx, sent } = recordingTx();
      const result = await latchDecisionMakerInstanceOff(tx, {
        instance: "decision-maker-anthropic",
        reason: "validation_latch",
      });
      assert.equal(sent.length, 1 + auditStatements);
      assert.ok(sent.length <= 12);
      const audit = sent.find((statement) => statement.kind === "create").data;
      assert.equal(audit.action, "amux.decision.latch");
      assert.equal(audit.actorUserId, null);
      assert.equal(audit.targetId, result.eventId);
      assert.deepEqual(audit.metadata, {
        event_id: result.eventId,
        scope: "decision-maker-anthropic",
        value: "off",
        reason_code: "validation_latch",
        systemActor: "amux-decision-maker-anthropic",
      });
      const insert = sent.at(-1);
      assert.match(insert.sql, /'off', \$, 'system', NULL, \$/);
      assert.deepEqual(insert.values, [result.eventId, "decision-maker-anthropic", "validation_latch", "audit-row-1"]);
    });
  });
}

test("the Admin route's DB boundaries are the store's statements at their largest, plus setup and fence", async () => {
  // A ceiling below the count refuses every change; one above it lets a
  // statement the tests here never counted run inside the budget.
  const largest = await withIntegrityKey("unit-test-integrity-key", async () => {
    const { tx, sent } = recordingTx();
    await recordDecisionMakerSwitchByOperator(tx, { session, scope: "kill_switch", value: "on" });
    return sent.length;
  });
  assert.equal(largest, 7);
  assert.deepEqual(AMUX_DB_BOUNDARIES.decisionMakerSwitchChange, {
    operation: "decision_maker_switch_change",
    prismaCallCeiling: largest + 2,
    isolation: "mutation",
  });
  const { tx, sent } = recordingTx();
  await readDecisionMakerSwitchesOrThrow(tx);
  assert.deepEqual(AMUX_DB_BOUNDARIES.decisionMakerSwitchRead, {
    operation: "decision_maker_switch_read",
    prismaCallCeiling: sent.length + 2,
    isolation: "read",
  });
});

test("a person's change after a system latch is written as the latch release", async () => {
  await withIntegrityKey(null, async () => {
    const { tx, sent } = recordingTx({ newest: [{ actorKind: "system", value: "off" }] });
    const result = await recordDecisionMakerSwitchByOperator(tx, {
      session,
      scope: "decision-maker-openai",
      value: "off",
    });
    assert.equal(result.action, "amux.decision.latch_release");
    const audit = sent.find((statement) => statement.kind === "create").data;
    assert.equal(audit.action, "amux.decision.latch_release");
    assert.equal(audit.metadata.previous_value, "off");
  });
});

test("a refused change or latch sends nothing at all", async () => {
  for (const [scope, value] of [
    ["decision-maker-openai", "autonomous"],
    ["kill_switch", "proposal"],
    ["decision-maker-gemini", "off"],
  ]) {
    const { tx, sent } = recordingTx();
    await assert.rejects(
      recordDecisionMakerSwitchByOperator(tx, { session, scope, value }),
      (error) => error instanceof DecisionMakerSwitchWriteError && error.code === "invalid_change",
    );
    assert.equal(sent.length, 0);
  }
  {
    const { tx, sent } = recordingTx();
    await assert.rejects(
      recordDecisionMakerSwitchByOperator(tx, { session: { expires: session.expires }, scope: "kill_switch", value: "on" }),
      (error) => error instanceof DecisionMakerSwitchWriteError && error.code === "no_operator",
    );
    assert.equal(sent.length, 0);
  }
  for (const [instance, reason] of [
    ["kill_switch", "validation_latch"],
    ["decision-maker-openai", "operator"],
  ]) {
    const { tx, sent } = recordingTx();
    await assert.rejects(
      latchDecisionMakerInstanceOff(tx, { instance, reason }),
      (error) => error instanceof DecisionMakerSwitchWriteError && error.code === "invalid_latch",
    );
    assert.equal(sent.length, 0);
  }
});
