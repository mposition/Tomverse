/**
 * The AMUX Decision Maker relay's own unit
 * (scripts/systemd/tomverse-amux-dm-relay.service), stage S2 of
 * docs/policy/amux-decision-maker.md.
 *
 * Every bridge unit reads the same /etc/tomverse-bridge/bridge.env, and the
 * relay releases every local Decision Maker marker at the start of each tick,
 * so the relay runs as one process of its own (`--dm-relay`), never beside a
 * worker loop. Its switch and token are in a file only this unit reads. It
 * keeps the bridge account and hardening, and has no [Install].
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const unit = readFileSync(
  new URL("../scripts/systemd/tomverse-amux-dm-relay.service", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const template = readFileSync(
  new URL("../scripts/systemd/tomverse-amux-bridge@.service", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const directivesOf = (text) =>
  text
    .split("\n")
    .filter((line) => /^[A-Za-z]+=/.test(line))
    .map((line) => line.replace(/=.*$/, ""));
const valuesOf = (text, name) =>
  text
    .split("\n")
    .filter((line) => line.startsWith(`${name}=`))
    .map((line) => line.slice(name.length + 1));
const values = (name) => valuesOf(unit, name);

test("the unit starts the root-owned bridge binary in its relay mode, alone", () => {
  assert.deepEqual(values("ExecStart"), ["/usr/local/libexec/tomverse-wsl-bridge --dm-relay"]);
  assert.deepEqual(values("Type"), ["simple"]);
  // One unit, not a template: one relay.
  assert.doesNotMatch(unit, /%i/);
});

test("the relay's switch and token come from a file only this unit reads", () => {
  assert.deepEqual(values("EnvironmentFile"), [
    "/etc/tomverse-bridge/bridge.env",
    "/etc/tomverse-bridge/dm-relay.env",
  ]);
  // No worker bridge reads the relay's file.
  assert.doesNotMatch(template, /dm-relay\.env/);
  assert.deepEqual(values("Environment"), []);
});

test("the unit keeps the bridge account, without the v22 sidecar group", () => {
  assert.deepEqual(values("User"), ["tomverse-bridge"]);
  assert.deepEqual(values("Group"), ["tomverse-bridge"]);
  // The relay opens no v22 sidecar socket; the broker's socket is group tomverse-bridge.
  assert.deepEqual(values("SupplementaryGroups"), []);
});

test("a configuration error waits for a person; a start failure is retried", () => {
  assert.deepEqual(values("Restart"), ["on-failure"]);
  assert.deepEqual(values("RestartSec"), ["60"]);
  // DM_RELAY_MISCONFIGURED_EXIT in apps/tomverse-orchestrator/src/dm_relay.rs.
  assert.deepEqual(values("RestartPreventExitStatus"), ["2"]);
  const relay = readFileSync(
    new URL("../apps/tomverse-orchestrator/src/dm_relay.rs", import.meta.url),
    "utf8"
  );
  assert.match(relay, /pub const DM_RELAY_MISCONFIGURED_EXIT: i32 = 2;/);
});

test("the unit has no [Install]: nothing starts at boot", () => {
  assert.doesNotMatch(unit, /^\[Install\]/m);
  assert.doesNotMatch(unit, /^WantedBy=/m);
  assert.doesNotMatch(unit, /^Alias=/m);
});

test("the unit waits for the local AMUX and keeps the bridge template's hardening", () => {
  for (const name of [
    "ExecStartPre", "Wants", "After", "TimeoutStopSec", "KillMode", "NoNewPrivileges",
    "CapabilityBoundingSet", "AmbientCapabilities", "ProtectHome", "ProtectSystem",
    "PrivateTmp", "PrivateDevices", "ProtectKernelTunables", "ProtectKernelModules",
    "ProtectControlGroups", "RestrictSUIDSGID", "LockPersonality", "RestrictAddressFamilies",
    "TemporaryFileSystem", "UMask",
  ]) {
    assert.deepEqual(values(name), valuesOf(template, name), name);
  }
  for (const name of ["ReadWritePaths", "BindPaths", "BindReadOnlyPaths", "ReadOnlyPaths",
    "DynamicUser"]) {
    assert.deepEqual(values(name), [], name);
  }
});

test("every directive in the unit is one this test names", () => {
  const directives = directivesOf(unit);
  const known = new Set([
    "Description", "Documentation", "Wants", "After", "Type", "User", "Group",
    "EnvironmentFile", "ExecStartPre", "ExecStart", "Restart", "RestartSec",
    "RestartPreventExitStatus", "TimeoutStopSec", "KillMode", "NoNewPrivileges",
    "CapabilityBoundingSet", "AmbientCapabilities", "ProtectHome", "ProtectSystem",
    "PrivateTmp", "PrivateDevices", "ProtectKernelTunables", "ProtectKernelModules",
    "ProtectControlGroups", "RestrictSUIDSGID", "LockPersonality",
    "RestrictAddressFamilies", "TemporaryFileSystem", "UMask",
  ]);
  assert.deepEqual(directives.filter((name) => !known.has(name)), []);
  // EnvironmentFile is the one directive given twice.
  const repeated = directives.filter((name, i) => directives.indexOf(name) !== i);
  assert.deepEqual(repeated, ["EnvironmentFile"]);
});
