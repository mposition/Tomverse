import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = relative => readFile(new URL(`../${relative}`, import.meta.url), "utf8");
const directive = (text, name) => text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const bashPath = process.platform === "win32"
  ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
  : "/bin/bash";

test("read-only API unit is isolated, bounded and never auto-stops an ordinary sidecar", async () => {
  const [unit, environment, profile] = await Promise.all([
    source("scripts/systemd/amux-v22-read-only-api-sidecar@.service"),
    source("scripts/systemd/amux-v22-read-only-api-sidecar.env.example"),
    source("scripts/systemd/amux-v22-read-only-api-credential-profile.example.json"),
  ]);
  assert.equal(directive(unit, "User"), "tomverse-amux-v22-api");
  assert.equal(directive(unit, "Group"), "amux-v22-ipc");
  assert.equal(directive(unit, "Restart"), "no");
  assert.equal(directive(unit, "RuntimeMaxSec"), "30min");
  assert.equal(directive(unit, "NoNewPrivileges"), "true");
  assert.equal(directive(unit, "ProtectSystem"), "strict");
  assert.equal(directive(unit, "ProtectProc"), "invisible");
  assert.equal(directive(unit, "ProcSubset"), "pid");
  assert.equal(directive(unit, "CapabilityBoundingSet"), "");
  assert.match(unit,
    /^ExecStart=\/usr\/bin\/node \/opt\/tomverse-amux-v22\/read-only-api-sidecar\.mjs$/m);
  assert.match(unit,
    /^EnvironmentFile=\/etc\/tomverse-amux-v22\/read-only-api@%i\.env$/m);
  assert.doesNotMatch(unit, /^(?:Conflicts|BindsTo|PartOf)=/m,
    "starting the API unit must not implicitly stop or replace an ordinary worker sidecar");
  assert.doesNotMatch(unit, /^\[Install\]$/m);
  for (const name of ["EXECUTOR_ENABLED", "OPERATIONAL_GATES", "CREDENTIAL_DEDICATED"])
    assert.match(environment,
      new RegExp(`^TOMVERSE_AMUX_V22_READ_ONLY_API_${name}=false$`, "m"));
  assert.match(environment,
    /^TOMVERSE_AMUX_V22_READ_ONLY_API_ALLOWED_PREFIXES_JSON='\[[^\r\n]+\]'$/m);
  assert.match(environment,
    /^TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTION_FRAME_JSON='\{[^\r\n]+\}'$/m);
  const metadata = JSON.parse(profile);
  assert.equal(metadata.provider, "anthropic");
  assert.equal(metadata.allowedProviderHost, "api.anthropic.com");
  assert.equal(metadata.keyOwner, "tomverse-amux-v22-api");
  assert.equal(metadata.keyMode, "0600");
  assert.equal(metadata.shared, false);
  assert.equal(Object.hasOwn(metadata, "fingerprint"), false);
});

test("prepare-only installer verifies inert fixed artifacts and issues no service action", async () => {
  const [installer, packageJson] = await Promise.all([
    source("scripts/install-amux-v22-read-only-api-sidecar.sh"),
    source("package.json"),
  ]);
  assert.match(installer, /\$\{1:-\} != "--prepare-only"/);
  assert.match(installer, /\$EUID -ne 0/);
  assert.match(installer, /useradd --system --gid "\$ipc_group" --home-dir \/nonexistent/);
  assert.match(installer, /groupadd --system "\$ipc_group"/);
  assert.doesNotMatch(installer, /tomverse-bridge|bridge_user|usermod/,
    "preparation must not mutate or depend on the existing bridge account");
  assert.match(installer, /api_home != \/nonexistent/);
  assert.match(installer, /api_shell != \/usr\/sbin\/nologin/);
  assert.match(installer, /fixed IPC group is required/);
  assert.match(installer, /expected_unit_digest=[a-f0-9]{64}/);
  assert.match(installer, /artifact_digest[\s\S]*source_digest_after[\s\S]*staged_digest/);
  assert.match(installer, /systemd-analyze verify/);
  assert.match(installer,
    /systemctl list-unit-files --no-legend --plain/);
  assert.doesNotMatch(installer,
    /systemctl show [^\n]*amux-v22-read-only-api-sidecar@\.service/,
    "a bare systemd template is not a valid show target");
  assert.match(installer, /\/usr\/bin\/systemctl daemon-reload/);
  assert.doesNotMatch(installer,
    /\/usr\/bin\/systemctl\s+(?:enable|disable|start|restart|stop|try-restart|reload)\b/);
  assert.doesNotMatch(installer, /\.key["']|profile\.json["']/,
    "preparation must not synthesize a live key or profile");
  assert.match(installer, /API sidecar instance exists; preparation requires no loaded instances/);
  assert.match(installer, /API sidecar job is queued/);
  const scripts = JSON.parse(packageJson).scripts;
  assert.equal(scripts["build:amux-v22-read-only-api-sidecar"],
    "esbuild scripts/amux-v22-read-only-api-sidecar.mjs --bundle --platform=node --format=esm --outfile=.next/amux-v22-read-only-api-sidecar.mjs");
});

test("prepare preflight accepts only an absent or static template listing", () => {
  const run = (args) => spawnSync(bashPath, ["-c", `
source scripts/install-amux-v22-read-only-api-sidecar.sh
api_template_listing_allows_prepare "$1" "$2"
`, "preflight", ...args], { cwd: repositoryRoot, encoding: "utf8" });
  const unit = "amux-v22-read-only-api-sidecar@.service";
  assert.equal(run(["1", ""]).status, 0,
    "systemd 259 reports an absent exact template with empty output and exit 1");
  assert.equal(run(["0", `${unit}  static -`]).status, 0);
  for (const rejected of [
    ["0", ""], ["1", `${unit} static -`], ["4", ""],
    ["0", `${unit} enabled enabled`], ["0", `${unit} indirect enabled`],
    ["0", `${unit} static disabled`], ["0", `other@.service static -`],
    ["0", `${unit} static - extra`], ["0", `${unit} static -\nother@.service static -`],
  ]) assert.notEqual(run(rejected).status, 0,
    `unexpected template listing must fail closed: ${JSON.stringify(rejected)}`);
});

test("API account accepts only the fixed IPC group as its primary and complete group set", () => {
  const run = args => spawnSync(bashPath, ["-c", `
source scripts/install-amux-v22-read-only-api-sidecar.sh
api_account_groups_are_exact "$1" "$2" "$3"
`, "account-boundary", ...args], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(run(["981", "981", "981"]).status, 0);
  assert.notEqual(run(["982", "981", "982 981"]).status, 0,
    "a different primary group must fail closed");
  assert.notEqual(run(["981", "981", "981 27"]).status, 0,
    "an extra supplementary group must fail closed");
  assert.notEqual(run(["981", "981", "981 981"]).status, 0,
    "a duplicate group list must fail closed");
  for (const invalid of [
    ["ipc", "981", "981"], ["981", "ipc", "981"], ["981", "981", "981 ipc"],
    ["0", "0", "0"], ["981", "981", "0981"],
  ]) assert.notEqual(run(invalid).status, 0, "non-canonical group state must fail closed");
});
