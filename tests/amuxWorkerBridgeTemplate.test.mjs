/**
 * The per-worker bridge template of orchestration policy version 55,
 * section 2: scripts/systemd/tomverse-amux-bridge@.service.
 *
 * One template serves both kinds of worker, so nothing in it may differ by
 * worker or by kind, and the old v22 unit's sidecar coupling cannot be in it.
 * It keeps the account, environment file, restart rules and hardening of the
 * two units it replaces (tomverse-bridge.service and
 * tomverse-amux-v22-bridge@.service on the host), and it has no [Install]
 * (version 31, section 4).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const unit = readFileSync(
  new URL("../scripts/systemd/tomverse-amux-bridge@.service", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const directives = unit
  .split("\n")
  .filter((line) => /^[A-Za-z]+=/.test(line))
  .map((line) => line.replace(/=.*$/, ""));
const values = (name) =>
  unit
    .split("\n")
    .filter((line) => line.startsWith(`${name}=`))
    .map((line) => line.slice(name.length + 1));

test("the template starts the root-owned bridge with --worker and its instance name", () => {
  assert.deepEqual(values("ExecStart"), ["/usr/local/libexec/tomverse-wsl-bridge --worker %i"]);
  assert.deepEqual(values("Type"), ["simple"]);
});

test("the template keeps the bridge account and its environment file", () => {
  assert.deepEqual(values("User"), ["tomverse-bridge"]);
  assert.deepEqual(values("Group"), ["tomverse-bridge"]);
  assert.deepEqual(values("EnvironmentFile"), ["/etc/tomverse-bridge/bridge.env"]);
  // The v22 sidecar sockets are this group's.
  assert.deepEqual(values("SupplementaryGroups"), ["amux-v22-ipc"]);
});

test("a halt waits for a person; a start failure is retried", () => {
  assert.deepEqual(values("Restart"), ["on-failure"]);
  assert.deepEqual(values("RestartSec"), ["60"]);
  assert.deepEqual(values("RestartPreventExitStatus"), ["3"]);
});

test("the template has no [Install]: nothing starts at boot", () => {
  assert.doesNotMatch(unit, /^\[Install\]/m);
  assert.doesNotMatch(unit, /^WantedBy=/m);
  assert.doesNotMatch(unit, /^Alias=/m);
});

test("nothing in the template differs by worker or by kind", () => {
  // No worker name: adding a worker never edits this file.
  assert.doesNotMatch(unit.replace(/^#.*$/gm, ""), /\b(claude|codex|cursor|copilot)-[a-z0-9]+/);
  // No environment the --worker bridge does not read, and no per-worker one.
  assert.deepEqual(values("Environment"), []);
  assert.doesNotMatch(unit, /TOMVERSE_AMUX_WSL_SESSIONS|TOMVERSE_AMUX_V22_SIDECAR_SOCKET/);
  // No sidecar coupling: a session worker has no sidecar, and the bridge
  // itself registers nothing while a v22 worker's socket is missing.
  for (const name of ["Requires", "BindsTo", "PartOf", "Requisite", "Wants", "After"]) {
    for (const value of values(name)) {
      assert.doesNotMatch(value, /sidecar/, `${name}=${value}`);
    }
  }
  for (const value of values("ExecStartPre")) {
    assert.doesNotMatch(value, /task\.sock|test -S/, value);
  }
  // The %i only reaches the bridge's own argument.
  const instanceUses = unit
    .split("\n")
    .filter((line) => !line.startsWith("#") && line.includes("%i"));
  assert.deepEqual(instanceUses, [
    "Description=Tomverse AMUX worker bridge (%i)",
    "ExecStart=/usr/local/libexec/tomverse-wsl-bridge --worker %i",
  ]);
});

test("the template waits for the local AMUX the way both old units do", () => {
  assert.deepEqual(values("ExecStartPre"), [
    "/usr/bin/curl --silent --show-error --fail --insecure --max-time 5 --output /dev/null https://127.0.0.1:8824/health",
  ]);
  assert.deepEqual(values("Wants"), ["network-online.target"]);
  assert.deepEqual(values("After"), ["network-online.target"]);
});

test("the template keeps the hardening of both units it replaces", () => {
  const expected = {
    NoNewPrivileges: "yes",
    CapabilityBoundingSet: "",
    AmbientCapabilities: "",
    ProtectHome: "yes",
    ProtectSystem: "strict",
    PrivateTmp: "yes",
    PrivateDevices: "yes",
    ProtectKernelTunables: "yes",
    ProtectKernelModules: "yes",
    ProtectControlGroups: "yes",
    RestrictSUIDSGID: "yes",
    LockPersonality: "yes",
    RestrictAddressFamilies: "AF_UNIX AF_INET AF_INET6",
    UMask: "0077",
    TimeoutStopSec: "10",
    KillMode: "control-group",
    // The old v22 unit hid each worker's state directory by name; with no
    // names here, /var/lib as a whole is an empty read-only tmpfs.
    TemporaryFileSystem: "/var/lib:ro",
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.deepEqual(values(name), [value], name);
  }
  // Nothing is opened back up.
  for (const name of ["ReadWritePaths", "BindPaths", "BindReadOnlyPaths", "ReadOnlyPaths",
    "DynamicUser", "AmbientCapabilities"]) {
    assert.ok(values(name).every((value) => value === ""), name);
  }
});

test("every directive in the template is one this test names", () => {
  const known = new Set([
    "Description", "Documentation", "Wants", "After", "Type", "User", "Group",
    "SupplementaryGroups", "EnvironmentFile", "ExecStartPre", "ExecStart", "Restart",
    "RestartSec", "RestartPreventExitStatus", "TimeoutStopSec", "KillMode",
    "NoNewPrivileges", "CapabilityBoundingSet", "AmbientCapabilities", "ProtectHome",
    "ProtectSystem", "PrivateTmp", "PrivateDevices", "ProtectKernelTunables",
    "ProtectKernelModules", "ProtectControlGroups", "RestrictSUIDSGID", "LockPersonality",
    "RestrictAddressFamilies", "TemporaryFileSystem", "UMask",
  ]);
  assert.deepEqual(directives.filter((name) => !known.has(name)), []);
  assert.equal(new Set(directives).size, directives.length, "no directive is repeated");
});
