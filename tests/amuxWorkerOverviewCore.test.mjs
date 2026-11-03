// AMUX › Operations settings › Workers: the pure join of the registry, the
// recorded capabilities and the live reading into one row per worker.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_WORKER_ACTION_TARGET,
  amuxWorkerBridgeUnit,
  amuxWorkerEnableCommand,
  amuxWorkerFilterCount,
  buildAmuxWorkerOverview,
  filterAmuxWorkerRows,
  groupAmuxWorkerRows,
} from "../lib/amux/workerOverviewCore.ts";
import {
  buildAmuxWorkerRegistryAdminView,
} from "../lib/amux/workerRegistryCore.ts";
import { buildAmuxWorkerCapabilityAdminView } from "../lib/amux/workerCapabilityCore.ts";

// The fixtures' names start with their CLI; the registry no longer reads it from them.
const amuxWorkerProviderClassOf = (name) => name.slice(0, name.indexOf("-"));


const NOW = Date.parse("2026-10-20T04:00:00.000Z");
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

const reg = (workerName, desiredState, roleCeiling = "implementation", revision = 1) => ({
  workerName,
  providerClass: amuxWorkerProviderClassOf(workerName),
  roleCeiling,
  desiredState,
  revision,
  changedAt: "2026-10-13T00:00:00.000Z",
});

const registryOf = (registrations, { latches = new Map(), observations = new Map() } = {}) =>
  buildAmuxWorkerRegistryAdminView({ registrations, latches, observations, writesLatch: true });

const capabilitiesOf = (registrations, current = new Map()) =>
  buildAmuxWorkerCapabilityAdminView({ registrations, current, writesLatch: true });

const liveOf = (workers) => ({ kind: "observed", catalogConfigured: true, workers });
const seat = (name, state, secondsAgo = 12) => ({
  name,
  provider: "x",
  state,
  heartbeatAt: secondsAgo === null ? null : at(secondsAgo),
});

const RECORDED = {
  revision: 1,
  capability: { model: null, routingTags: ["implementation"], toolCapabilities: [], v22: null },
  changedAt: "2026-10-13T00:00:00.000Z",
};

const REGISTRATIONS = [
  reg("claude-chore", "active", "chore"),
  reg("codex-impl", "active"),
  reg("codex-contract", "active", "contract"),
  reg("cursor-impl", "requested"),
  reg("copilot-impl", "paused"),
  reg("copilot-chore", "retired", "chore"),
];

const build = (overrides = {}) =>
  buildAmuxWorkerOverview({
    registry: registryOf(REGISTRATIONS),
    capabilities: capabilitiesOf(REGISTRATIONS),
    live: liveOf([
      seat("claude-chore", "lost", 600),
      seat("codex-impl", "ready"),
      seat("codex-contract", "busy", 3),
    ]),
    nowMs: NOW,
    ...overrides,
  });

const rowOf = (overview, name) => overview.rows.find((row) => row.workerName === name);

test("an unreadable registry gives no overview at all", () => {
  assert.equal(build({ registry: null }), null);
  assert.equal(build({ registry: { ...registryOf([]), registryReadable: false } }), null);
});

test("each worker lands in the group its desired state and live reading say", () => {
  const overview = build();
  assert.equal(rowOf(overview, "claude-chore").group, "attention");
  assert.equal(rowOf(overview, "claude-chore").status, "connection_lost");
  assert.equal(rowOf(overview, "codex-impl").group, "assignable");
  assert.equal(rowOf(overview, "codex-impl").status, "assignable_ready");
  assert.equal(rowOf(overview, "codex-contract").status, "assignable_busy");
  assert.equal(rowOf(overview, "cursor-impl").group, "waiting");
  assert.equal(rowOf(overview, "copilot-impl").group, "paused");
  assert.equal(rowOf(overview, "copilot-chore").group, "retired");
});

test("the list opens with what needs a look, then in use, waiting, paused and kept", () => {
  const order = build().rows.map((row) => row.group);
  assert.deepEqual(order, ["attention", "assignable", "assignable", "waiting", "paused", "retired"]);
});

test("a live state decides an active worker; every unhealthy one needs a look", () => {
  const cases = {
    ready: ["assignable", "assignable_ready"],
    idle: ["assignable", "assignable_ready"],
    busy: ["assignable", "assignable_busy"],
    starting: ["assignable", "assignable_starting"],
    lost: ["attention", "connection_lost"],
    error: ["attention", "bridge_error"],
    stopped: ["attention", "bridge_stopped"],
    not_running: ["attention", "bridge_not_started"],
    blocked: ["attention", "operator_excluded"],
    isolated: ["attention", "operator_excluded"],
    paused: ["attention", "operator_excluded"],
    not_admitted: ["attention", "not_in_assignment"],
    catalog_unknown: ["attention", "not_in_assignment"],
  };
  // A recorded capability, so "not in the list" is not explained by its absence.
  const capabilities = capabilitiesOf(REGISTRATIONS, new Map([["codex-impl", RECORDED]]));
  for (const [state, [group, status]] of Object.entries(cases)) {
    const overview = build({ capabilities, live: liveOf([seat("codex-impl", state)]) });
    assert.deepEqual([rowOf(overview, "codex-impl").group, rowOf(overview, "codex-impl").status], [group, status], state);
  }
});

test("an active worker left out for having no recorded capability says so", () => {
  for (const state of ["not_admitted", "catalog_unknown"]) {
    const overview = build({ live: liveOf([seat("codex-impl", state, null)]) });
    assert.deepEqual([rowOf(overview, "codex-impl").group, rowOf(overview, "codex-impl").status], ["attention", "capability_missing"], state);
  }
  // Unread capabilities are not taken as missing ones.
  const unread = build({ capabilities: null, live: liveOf([seat("codex-impl", "not_admitted", null)]) });
  assert.equal(rowOf(unread, "codex-impl").status, "not_in_assignment");
  // A connected worker is described by its connection, recorded or not.
  assert.equal(rowOf(build(), "codex-impl").status, "assignable_ready");
});

test("an open stop latch is named when the worker is not in the assignment list", () => {
  const registry = registryOf(REGISTRATIONS, { latches: new Map([["codex-impl", "opened"]]) });
  const overview = build({ registry, live: liveOf([seat("codex-impl", "not_admitted", null)]) });
  assert.equal(rowOf(overview, "codex-impl").status, "latch_open");
});

test("an unread live reading never claims a connection", () => {
  for (const live of [null, { kind: "unread" }, { kind: "no_catalog" }]) {
    const overview = build({ live });
    assert.equal(overview.liveReadable, false);
    assert.equal(rowOf(overview, "codex-impl").status, "live_unread");
    assert.equal(rowOf(overview, "codex-impl").group, "attention");
    // Workers that are not turned on do not depend on it.
    assert.equal(rowOf(overview, "cursor-impl").status, "waiting_activation");
    assert.equal(rowOf(overview, "copilot-impl").status, "paused");
  }
});

test("the heartbeat age is counted from the read, and absent when the bridge never signalled", () => {
  const overview = build({ live: liveOf([seat("codex-impl", "ready", 12), seat("codex-contract", "not_running", null)]) });
  assert.equal(rowOf(overview, "codex-impl").heartbeatAgeSeconds, 12);
  assert.equal(rowOf(overview, "codex-contract").heartbeatAgeSeconds, null);
  // A clock ahead of the read does not make a negative age.
  const ahead = build({ live: liveOf([{ ...seat("codex-impl", "ready"), heartbeatAt: new Date(NOW + 5000).toISOString() }]) });
  assert.equal(rowOf(ahead, "codex-impl").heartbeatAgeSeconds, 0);
});

test("the next thing to offer follows the desired state", () => {
  const overview = build();
  assert.deepEqual(rowOf(overview, "cursor-impl").actions, ["activate"]);
  assert.deepEqual(rowOf(overview, "codex-impl").actions, ["pause"]);
  assert.deepEqual(rowOf(overview, "claude-chore").actions, ["pause"]);
  assert.deepEqual(rowOf(overview, "copilot-impl").actions, ["resume"]);
  assert.deepEqual(rowOf(overview, "copilot-chore").actions, []);
  assert.deepEqual(AMUX_WORKER_ACTION_TARGET, { activate: "active", pause: "paused", resume: "active" });
});

test("the capability read supplies the model, the tags and the execution mode", () => {
  const current = new Map([
    ["claude-chore", { revision: 2, changedAt: "2026-10-14T00:00:00.000Z", capability: { model: "claude-opus-5-5", routingTags: ["chore"], toolCapabilities: [], v22: { model: "claude-opus-5-5", roles: ["investigate"], tools: ["repo_read"] } } }],
    ["codex-impl", { revision: 1, changedAt: "2026-10-14T00:00:00.000Z", capability: { model: null, routingTags: ["implementation", "tests"], toolCapabilities: [], v22: null } }],
  ]);
  const overview = build({ capabilities: capabilitiesOf(REGISTRATIONS, current) });
  const chore = rowOf(overview, "claude-chore");
  assert.equal(chore.mode, "v22");
  assert.equal(chore.model, "claude-opus-5-5");
  assert.equal(chore.providerLabel, "Anthropic");
  const impl = rowOf(overview, "codex-impl");
  assert.equal(impl.mode, "session");
  assert.deepEqual(impl.routingTags, ["implementation", "tests"]);
  assert.equal(impl.providerLabel, "OpenAI");
  assert.equal(rowOf(overview, "cursor-impl").model, null);
  assert.equal(rowOf(overview, "cursor-impl").capability.workerName, "cursor-impl");
});

test("an unread capability view still lists every worker, without an editor row", () => {
  const overview = build({ capabilities: null });
  assert.equal(overview.capabilitiesReadable, false);
  assert.ok(overview.rows.every((row) => row.capability === null && row.model === null));
  assert.equal(overview.rows.length, REGISTRATIONS.length);
});

test("the summary counts each group, names providers, and keeps retired out of the total", () => {
  const { summary } = build();
  assert.equal(summary.total, 5);
  assert.deepEqual(summary.assignable, { count: 2, byProvider: [{ providerClass: "codex", count: 2 }] });
  assert.deepEqual(summary.attention, { count: 1, sample: { workerName: "claude-chore", status: "connection_lost" } });
  assert.deepEqual(summary.waiting, { count: 1, byProvider: [{ providerClass: "cursor", count: 1 }] });
  assert.equal(summary.paused, 1);
  assert.equal(summary.retired, 1);
});

test("the filters count and select the same rows; all leaves out the kept ones; the name search is a substring", () => {
  const { rows } = build();
  assert.equal(amuxWorkerFilterCount(rows, "all"), 5);
  assert.equal(amuxWorkerFilterCount(rows, "retired"), 1);
  assert.equal(filterAmuxWorkerRows(rows, "all", "").length, 5);
  assert.deepEqual(filterAmuxWorkerRows(rows, "retired", "").map((row) => row.workerName), ["copilot-chore"]);
  assert.deepEqual(filterAmuxWorkerRows(rows, "all", " CODEX ").map((row) => row.workerName), ["codex-contract", "codex-impl"]);
  assert.deepEqual(filterAmuxWorkerRows(rows, "waiting", "codex"), []);
  assert.deepEqual(groupAmuxWorkerRows(filterAmuxWorkerRows(rows, "all", "")).map((entry) => entry.group),
    ["attention", "assignable", "waiting", "paused"]);
});

test("the Ubuntu command is the one systemd instance of the worker's bridge", () => {
  assert.equal(amuxWorkerBridgeUnit("claude-contract"), "tomverse-amux-bridge@claude-contract");
  assert.equal(
    amuxWorkerEnableCommand("claude-contract"),
    "sudo systemctl enable --now tomverse-amux-bridge@claude-contract.service",
  );
});
