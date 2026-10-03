import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workers = new Map([
  ["claude-chore", "claude"],
  ["claude-contract", "claude"],
  ["claude-impl", "claude"],
  ["claude-review", "claude"],
  ["codex-chore", "codex"],
  ["codex-contract", "codex"],
  ["codex-impl", "codex"],
  ["devin-worker", "python3"],
]);

export function verifyReboot(snapshot, options) {
  const failures = [];
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const beforeEpoch = Date.parse(options.beforeBootTime) / 1000;
  check(Number.isFinite(beforeEpoch), "invalid prior boot time");
  check(Number.isInteger(snapshot.bootEpoch) && snapshot.bootEpoch > beforeEpoch,
    "boot time did not advance");
  if (options.beforeBootId) {
    check(snapshot.bootId !== options.beforeBootId, "boot ID did not change");
  }
  for (const key of ["server", "workers", "tailscale"]) {
    check(snapshot.units?.[key]?.active === "active", key + " is not active");
    check(snapshot.units?.[key]?.enabled === "enabled", key + " is not enabled");
  }
  check(snapshot.units?.bridge?.active === "inactive", "product bridge is active");
  check(["disabled", "masked", "not-found", ""].includes(snapshot.units?.bridge?.enabled),
    "product bridge is enabled");
  check(snapshot.linger === "Linger=yes", "worker user linger is disabled");
  check(snapshot.binarySha256 === options.expectedSha256, "AMUX binary SHA differs");
  check(snapshot.health?.http === 200 && snapshot.health?.status === "ok",
    "local AMUX health failed");
  check(snapshot.dashboardHttp === 200, "tailnet Dashboard is unavailable");
  check(snapshot.serve?.includes(options.dashboardHost + " (tailnet only)") &&
    snapshot.serve?.includes("proxy https+insecure://127.0.0.1:8824"),
    "Tailscale Serve route differs");

  const panes = snapshot.panes ?? [];
  check(panes.length === workers.size, "worker pane count differs");
  const seen = new Set();
  for (const pane of panes) {
    const name = pane.session?.replace(/^amux-/, "");
    const expectedProcess = workers.get(name);
    check(Boolean(expectedProcess) && !seen.has(name), "unexpected or duplicate worker: " + name);
    seen.add(name);
    if (!expectedProcess) continue;
    const expectedPath = name === "devin-worker"
      ? options.devinRoot + "/devin-worker"
      : options.worktreeRoot + "/" + name;
    check(pane.process === expectedProcess && pane.dead === "0",
      name + " process is not running");
    check(pane.path === expectedPath && pane.gitRoot === expectedPath,
      name + " is not in its Ubuntu worktree");
  }
  for (const name of workers.keys()) {
    check(seen.has(name), "missing worker: " + name);
  }
  return failures;
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("expected --name value arguments");
    }
    options[key.slice(2)] = value;
  }
  for (const key of ["host", "identity", "dashboard", "before-boot-time", "expected-sha256"]) {
    if (!options[key]) throw new Error("missing --" + key);
  }
  if (!/^[A-Za-z0-9][\w.-]*@[A-Za-z0-9][\w.-]*$/.test(options.host)) {
    throw new Error("invalid SSH host");
  }
  const dashboard = new URL(options.dashboard);
  if (dashboard.protocol !== "https:") throw new Error("Dashboard must use HTTPS");
  if (!/^[a-f0-9]{64}$/.test(options["expected-sha256"])) {
    throw new Error("invalid expected SHA256");
  }
  return { ...options, dashboard };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const probe = readFileSync(new URL("./verify-amux-ubuntu-reboot-probe.py", import.meta.url));
  const remote = spawnSync("ssh", [
    "-i", options.identity,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=10",
    options.host,
    "python3 -",
  ], { input: probe, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  if (remote.status !== 0) {
    throw new Error("Ubuntu read-only probe failed: " + (remote.stderr || remote.error?.message || remote.status));
  }
  const snapshot = JSON.parse(remote.stdout);
  try {
    const response = await fetch(options.dashboard, { signal: AbortSignal.timeout(10000) });
    snapshot.dashboardHttp = response.status;
    await response.body?.cancel();
  } catch {
    snapshot.dashboardHttp = 0;
  }
  const failures = verifyReboot(snapshot, {
    beforeBootTime: options["before-boot-time"],
    beforeBootId: options["before-boot-id"],
    expectedSha256: options["expected-sha256"],
    dashboardHost: options.dashboard.host,
    worktreeRoot: options["worktree-root"] ?? "/home/tommy/worktrees/Tomverse",
    devinRoot: options["devin-root"] ?? "/home/tommy/.amux-worktrees/TomverseAMUX",
  });
  process.stdout.write(JSON.stringify({
    ok: failures.length === 0,
    bootId: snapshot.bootId,
    bootEpoch: snapshot.bootEpoch,
    binarySha256: snapshot.binarySha256,
    dashboardHttp: snapshot.dashboardHttp,
    workers: snapshot.panes?.length ?? 0,
    failures,
  }, null, 2) + "\n");
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
}
