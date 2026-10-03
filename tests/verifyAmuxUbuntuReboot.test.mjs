import assert from "node:assert/strict";
import test from "node:test";
import { verifyReboot } from "../scripts/verify-amux-ubuntu-reboot.mjs";

const expectedSha256 = "a".repeat(64);
const worktreeRoot = "/home/tommy/worktrees/Tomverse";
const devinRoot = "/home/tommy/.amux-worktrees/TomverseAMUX";
const names = [
  "claude-chore", "claude-contract", "claude-impl", "claude-review",
  "codex-chore", "codex-contract", "codex-impl", "devin-worker",
];
const options = {
  beforeBootTime: "2026-10-01T09:02:48Z",
  beforeBootId: "old-boot",
  expectedSha256,
  dashboardHost: "tomverseagent.example.ts.net",
  worktreeRoot,
  devinRoot,
};

function healthySnapshot() {
  return {
    bootId: "new-boot",
    bootEpoch: Date.parse("2026-10-03T13:22:13Z") / 1000,
    units: {
      server: { active: "active", enabled: "enabled" },
      workers: { active: "active", enabled: "enabled" },
      tailscale: { active: "active", enabled: "enabled" },
      bridge: { active: "inactive", enabled: "disabled" },
    },
    linger: "Linger=yes",
    binarySha256: expectedSha256,
    health: { http: 200, status: "ok" },
    dashboardHttp: 200,
    serve: "https://tomverseagent.example.ts.net (tailnet only)\n|-- / proxy https+insecure://127.0.0.1:8824",
    panes: names.map((name) => {
      const path = name === "devin-worker"
        ? devinRoot + "/" + name
        : worktreeRoot + "/" + name;
      return {
        session: "amux-" + name,
        process: name.startsWith("claude") ? "claude"
          : name.startsWith("codex") ? "codex" : "python3",
        path,
        gitRoot: path,
        dead: "0",
      };
    }),
  };
}

test("accepts a rebooted Ubuntu host with all eight native worktrees", () => {
  assert.deepEqual(verifyReboot(healthySnapshot(), options), []);
});

test("rejects an unchanged boot and missing worker", () => {
  const snapshot = healthySnapshot();
  snapshot.bootId = options.beforeBootId;
  snapshot.bootEpoch = Date.parse(options.beforeBootTime) / 1000;
  snapshot.panes.pop();
  const failures = verifyReboot(snapshot, options);
  assert.ok(failures.includes("boot time did not advance"));
  assert.ok(failures.includes("boot ID did not change"));
  assert.ok(failures.includes("missing worker: devin-worker"));
});

test("rejects bridge activation, binary drift, and a non-Ubuntu worktree", () => {
  const snapshot = healthySnapshot();
  snapshot.units.bridge.active = "active";
  snapshot.binarySha256 = "b".repeat(64);
  snapshot.panes[0].path = "/mnt/c/Users/Vyper/Tomverse";
  const failures = verifyReboot(snapshot, options);
  assert.ok(failures.includes("product bridge is active"));
  assert.ok(failures.includes("AMUX binary SHA differs"));
  assert.ok(failures.includes("claude-chore is not in its Ubuntu worktree"));
});

test("rejects unavailable services and dashboard after reboot", () => {
  const snapshot = healthySnapshot();
  snapshot.units.workers.active = "failed";
  snapshot.health.http = 503;
  snapshot.dashboardHttp = 503;
  snapshot.panes[4].process = "bash";
  const failures = verifyReboot(snapshot, options);
  assert.ok(failures.includes("workers is not active"));
  assert.ok(failures.includes("local AMUX health failed"));
  assert.ok(failures.includes("tailnet Dashboard is unavailable"));
  assert.ok(failures.includes("codex-chore process is not running"));
});
