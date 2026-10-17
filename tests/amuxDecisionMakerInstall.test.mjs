// The AMUX Decision Maker's runner installation, stage S2-3b
// (docs/policy/amux-decision-maker.md policy version 2, §5 and §5a): the six
// systemd units, the root installer and the release build. The units must run
// each part as its own S0 account with the hard limits §5 asks for; the
// installer's fixed values must be the launcher's; and installing must never
// enable or start anything, run a CLI beyond `--version`, or send anything.
// The installer's functions run under bash; nothing here is installed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DM_BROKER_SOCKET_PATH,
  DM_LAUNCHER_SOCKET_PATHS,
  DM_LAUNCHER_UNIT_RUNTIME_MAX_MS,
} from "../lib/amux/decisionMakerBrokerCore.ts";
import {
  DM_CLAUDE_EXECUTABLE_PATH,
  DM_CODEX_EXECUTABLE_PATH,
  DM_LAUNCHER_SPECS,
  DM_OUTPUT_SCHEMA_PATH,
  DM_OUTPUT_SCHEMA_SHA256,
  DM_REQUEST_ROOT,
  DM_SYSTEM_PATH_OWNERS,
} from "../lib/amux/decisionMakerLauncherCore.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const read = (relative) => readFileSync(join(repositoryRoot, relative), "utf8");
const directives = (text, name) => [...text.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].map((match) => match[1]);
const directive = (text, name) => {
  const values = directives(text, name);
  assert.ok(values.length <= 1, `${name} appears once`);
  return values[0];
};
const bashPath =
  process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe") : "/bin/bash";

const INSTALLER = "scripts/install-amux-decision-maker.sh";
const installer = read(INSTALLER);
const installerConstant = (name) => {
  const match = installer.match(new RegExp(`^readonly ${name}=("?)([^"\\n]*)\\1$`, "m"));
  assert.ok(match, `${name} is a readonly constant of the installer`);
  return match[2];
};

const VENDOR_ACCOUNTS = { "decision-maker-openai": "amux-dm-openai", "decision-maker-anthropic": "amux-dm-anthropic" };
const SHORT = { "decision-maker-openai": "openai", "decision-maker-anthropic": "anthropic" };

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

test("§5: only the bridge's group reaches the broker's socket, which systemd makes", () => {
  const socket = read("scripts/systemd/amux-dm-broker.socket");
  assert.equal(directive(socket, "ListenStream"), DM_BROKER_SOCKET_PATH);
  assert.equal(directive(socket, "SocketUser"), "amux-dm-broker");
  assert.equal(directive(socket, "SocketGroup"), "tomverse-bridge");
  assert.equal(directive(socket, "SocketMode"), "0660");
  assert.equal(directive(socket, "Accept"), "no");
  assert.equal(directive(socket, "Service"), "amux-dm-broker.service");
});

test("§5: the broker runs as its own account, writes only the request root, and has local sockets only", () => {
  const service = read("scripts/systemd/amux-dm-broker.service");
  assert.equal(directive(service, "User"), "amux-dm-broker");
  assert.equal(directive(service, "Group"), "amux-dm-broker");
  assert.equal(directive(service, "ExecStart"), "/usr/bin/node /opt/tomverse-amux-dm/broker.mjs");
  assert.deepEqual(directives(service, "ReadWritePaths"), [DM_REQUEST_ROOT]);
  assert.equal(directive(service, "RestrictAddressFamilies"), "AF_UNIX");
  assert.equal(directive(service, "ProtectSystem"), "strict");
  assert.equal(directive(service, "NoNewPrivileges"), "true");
  assert.equal(directive(service, "CapabilityBoundingSet"), "");
  assert.equal(directive(service, "Restart"), "no");
  assert.equal(directive(service, "KillMode"), "control-group");
  assert.doesNotMatch(service, /^\[Install\]$/m, "the socket starts it; it is never enabled on its own");
  assert.doesNotMatch(service, /^(?:Environment|EnvironmentFile)=/m, "the broker holds no credential");
});

for (const instance of Object.keys(VENDOR_ACCOUNTS)) {
  const account = VENDOR_ACCOUNTS[instance];
  const name = `amux-dm-launcher-${SHORT[instance]}`;

  test(`§5: only the broker reaches ${instance}'s launcher, one connection at a time`, () => {
    const socket = read(`scripts/systemd/${name}.socket`);
    assert.equal(directive(socket, "ListenStream"), DM_LAUNCHER_SOCKET_PATHS[instance]);
    assert.equal(directive(socket, "SocketUser"), "amux-dm-broker");
    assert.equal(directive(socket, "SocketGroup"), "amux-dm-broker");
    assert.equal(directive(socket, "SocketMode"), "0600");
    assert.equal(directive(socket, "Accept"), "yes");
    assert.equal(directive(socket, "MaxConnections"), "1");
  });

  test(`§5 hard timeout: ${instance}'s launcher runs as ${account}, and its control group cannot outlive the limit`, () => {
    const service = read(`scripts/systemd/${name}@.service`);
    assert.equal(directive(service, "User"), account);
    assert.equal(directive(service, "Group"), account);
    assert.equal(directive(service, "ExecStart"), `/usr/bin/node /opt/tomverse-amux-dm/launcher.mjs ${instance}`);
    assert.equal(directive(service, "StandardInput"), "socket");
    assert.equal(directive(service, "StandardOutput"), "journal", "only the protocol, never a stray write, reaches the broker");
    assert.equal(directive(service, "KillMode"), "control-group");
    assert.equal(directive(service, "RuntimeMaxSec"), `${DM_LAUNCHER_UNIT_RUNTIME_MAX_MS / 60_000}min`);
    assert.equal(directive(service, "TimeoutStopSec"), "10s");
    assert.equal(directive(service, "Restart"), "no");
    assert.deepEqual(directives(service, "ReadWritePaths"), [DM_LAUNCHER_SPECS[instance].home]);
    assert.equal(directive(service, "ProtectSystem"), "strict");
    assert.equal(directive(service, "NoNewPrivileges"), "true");
    assert.doesNotMatch(service, /^\[Install\]$/m);
    assert.doesNotMatch(service, /^(?:Environment|EnvironmentFile)=/m, "§5a's environment is the launcher's, not the unit's");
  });
}

test("the units' accounts are S0's, as the launcher's path checks expect", () => {
  assert.equal(Number(installerConstant("DM_BROKER_UID")), DM_SYSTEM_PATH_OWNERS.broker);
  assert.equal(Number(installerConstant("DM_OPENAI_UID")), DM_SYSTEM_PATH_OWNERS.vendor["decision-maker-openai"]);
  assert.equal(Number(installerConstant("DM_ANTHROPIC_UID")), DM_SYSTEM_PATH_OWNERS.vendor["decision-maker-anthropic"]);
  assert.equal(installerConstant("DM_OPENAI_USER"), VENDOR_ACCOUNTS["decision-maker-openai"]);
  assert.equal(installerConstant("DM_ANTHROPIC_USER"), VENDOR_ACCOUNTS["decision-maker-anthropic"]);
  for (const instance of Object.keys(VENDOR_ACCOUNTS)) {
    assert.equal(DM_LAUNCHER_SPECS[instance].home, `/home/${VENDOR_ACCOUNTS[instance]}`);
  }
});

// ---------------------------------------------------------------------------
// The installer's fixed values are the launcher's
// ---------------------------------------------------------------------------

test("§5a: the installer copies to the launcher's paths and checks the policy's sha256 and versions", () => {
  assert.equal(installerConstant("DM_CODEX_DEST"), DM_CODEX_EXECUTABLE_PATH);
  assert.equal(installerConstant("DM_CLAUDE_DEST"), DM_CLAUDE_EXECUTABLE_PATH);
  assert.equal(installerConstant("DM_CODEX_SHA256"), DM_LAUNCHER_SPECS["decision-maker-openai"].executableSha256);
  assert.equal(installerConstant("DM_CLAUDE_SHA256"), DM_LAUNCHER_SPECS["decision-maker-anthropic"].executableSha256);
  assert.equal(installerConstant("DM_CODEX_VERSION"), DM_LAUNCHER_SPECS["decision-maker-openai"].cliVersion);
  assert.equal(installerConstant("DM_CLAUDE_VERSION"), DM_LAUNCHER_SPECS["decision-maker-anthropic"].cliVersion);
  assert.equal(installerConstant("DM_SCHEMA_DEST"), DM_OUTPUT_SCHEMA_PATH);
  assert.equal(installerConstant("DM_SCHEMA_SHA256"), DM_OUTPUT_SCHEMA_SHA256);
  // §5a names the measured files; the version is in their paths.
  const policy = read("docs/policy/amux-decision-maker.md");
  assert.ok(policy.includes("~/.codex/packages/standalone/releases/0.162.1-x86_64-unknown-linux-musl/bin/codex"));
  assert.ok(policy.includes("~/.local/share/claude/versions/2.1.296"));
  assert.equal(installerConstant("DM_CODEX_SOURCE"), "/home/amux-dm-openai/.codex/packages/standalone/releases/0.162.1-x86_64-unknown-linux-musl/bin/codex");
  assert.equal(installerConstant("DM_CLAUDE_SOURCE"), "/home/amux-dm-anthropic/.local/share/claude/versions/2.1.296");
});

test("installing never enables, starts or stops a unit, sends nothing, and runs a CLI only for --version", () => {
  const code = installer.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(code, /systemctl\s+(?:enable|disable|start|restart|stop|try-restart|reload(?!-)|kill|mask|unmask|reenable)\b/);
  assert.doesNotMatch(code, /\b(?:curl|wget|ssh|scp|nc|npm|npx|git)\b/);
  // The two root-owned executables appear only as copy targets and in the --version check.
  const runs = [...code.matchAll(/"\$executable"\s+(\S+)/g)].map((match) => match[1]);
  assert.deepEqual(runs, ["--version"]);
  assert.match(code, /unshare --net -- \/usr\/sbin\/runuser -u nobody -- \/usr\/bin\/env -i/);
  for (const name of ["DM_CODEX_DEST", "DM_CLAUDE_DEST", "DM_CODEX_SOURCE", "DM_CLAUDE_SOURCE"]) {
    assert.doesNotMatch(code, new RegExp(`(?:^|[;&|]\\s*)"\\$${name}"\\s`, "m"), `${name} is never run directly`);
  }
  // A dry run is the default; nothing that writes runs before the --apply branch.
  const apply = code.indexOf("if ((DM_APPLY == 0)); then");
  assert.ok(apply > 0);
  const beforeApply = code.slice(code.indexOf("dm_main() {"), apply);
  assert.doesNotMatch(beforeApply, /\/usr\/bin\/(?:install|mv|cp|rm|chmod|mktemp)\b|daemon-reload/);
});

// ---------------------------------------------------------------------------
// The installer's functions, under bash
// ---------------------------------------------------------------------------

const bash = (script, ...args) =>
  spawnSync(bashPath, ["-c", `source ${INSTALLER}\n${script}`, "test", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

test("the installer is a dry run unless --apply is given, and needs the manifest's sha256", () => {
  const parsed = (...args) => bash('dm_parse_args "$@"; printf "%s %s" "$DM_APPLY" "$DM_MANIFEST_SHA256"', ...args);
  assert.equal(parsed("--manifest-sha256", SHA).stdout, `0 ${SHA}`);
  assert.equal(parsed("--manifest-sha256", SHA, "--apply").stdout, `1 ${SHA}`);
  assert.equal(parsed("--apply", "--manifest-sha256", SHA).stdout, `1 ${SHA}`);
  for (const args of [[], ["--apply"], ["--manifest-sha256"], ["--manifest-sha256", "A".repeat(64)], ["--manifest-sha256", SHA, "--apply", "--apply"], ["--manifest-sha256", SHA, "--manifest-sha256", SHA], ["--manifest-sha256", SHA, "--force"]]) {
    const result = parsed(...args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /usage/);
  }
});

test("a file is installed when absent, left only when already right, and kept in the backup before it is replaced", () => {
  // The full judgement is tests/amuxDecisionMakerInstallShell.test.mjs (review (1)).
  const action = (state, wanted) => bash('dm_file_action "$1" "$2" 0444', state, wanted);
  assert.equal(action("absent", SHA).stdout, "install\n");
  assert.equal(action(`file 0 0 444 1 ${SHA}`, SHA).stdout, "same\n");
  assert.equal(action(`file 0 0 444 1 ${OTHER_SHA}`, SHA).stdout, "replace\n");
  assert.equal(action(`file 993 993 644 1 ${SHA}`, SHA).stdout, "repair\n");
  for (const [state, wanted] of [["unreadable", SHA], ["link", SHA], ["other", SHA], [`file 0 0 444 1 ${SHA}`, ""]]) {
    assert.notEqual(action(state, wanted).status, 0, `${state} -> ${wanted}`);
  }
  assert.match(installer, /replace\|repair\)\n[\s\S]*?\/usr\/bin\/install -d [^\n]*\$backup[\s\S]*?\/usr\/bin\/cp -a -- "\$\{DM_PLAN_DEST\[\$index\]\}" "\$backup/);
});

test("the manifest names exactly the release's files, each once, in sha256sum's format", () => {
  const fits = (line) => bash('dm_manifest_line_fits "$1"', line).status === 0;
  for (const name of ["broker.mjs", "launcher.mjs", "dm-output-schema-v1.json", "install-amux-decision-maker.sh", "systemd/amux-dm-launcher-openai@.service"]) {
    assert.equal(fits(`${SHA}  ${name}`), true, name);
  }
  for (const line of [`${SHA} broker.mjs`, `${SHA}  ../broker.mjs`, `${SHA}  other.mjs`, `${"A".repeat(64)}  broker.mjs`, `${SHA}  broker.mjs `, `${SHA}  systemd/other.service`, ""]) {
    assert.equal(fits(line), false, JSON.stringify(line));
  }
});

test("a unit file is replaced only while the unit is not running", () => {
  const allows = (state) => bash('dm_unit_state_allows_install "$1"', state).status === 0;
  for (const state of ["inactive", "failed", "unknown"]) assert.equal(allows(state), true, state);
  for (const state of ["active", "activating", "deactivating", "reloading", "refreshing", ""]) assert.equal(allows(state), false, state);
  assert.equal(bash('dm_same_words "a b c" "c a b"').status, 0);
  assert.notEqual(bash('dm_same_words "a b" "a b c"').status, 0);
});

// ---------------------------------------------------------------------------
// The release
// ---------------------------------------------------------------------------

test("the release holds exactly what the installer expects, with the launcher's schema bytes", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  assert.equal(scripts["build:amux-decision-maker"], "node --import tsx scripts/build-amux-decision-maker.mjs");
  const out = mkdtempSync(join(tmpdir(), "amux-dm-release-"));
  try {
    const build = spawnSync(process.execPath, ["--import", "tsx", "scripts/build-amux-decision-maker.mjs", "--out", out], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stderr);
    const manifest = readFileSync(join(out, "manifest.sha256"), "utf8");
    const listed = manifest.trimEnd().split("\n").map((line) => line.slice(66));
    const expected = installer.match(/readonly DM_RELEASE_FILES=\(\n([\s\S]*?)\n\)/)[1].split("\n").map((line) => line.trim().replace(/^"|"$/g, ""));
    assert.deepEqual(listed, expected);
    const units = installer.match(/readonly DM_UNITS=\(\n([\s\S]*?)\n\)/)[1].split("\n").map((line) => line.trim().replace(/^"|"$/g, ""));
    assert.deepEqual(units.map((unit) => `systemd/${unit}`), expected.filter((name) => name.startsWith("systemd/")));
    assert.deepEqual(readdirSync(join(out, "systemd")).sort(), [...units].sort());
    assert.ok(manifest.includes(`${DM_OUTPUT_SCHEMA_SHA256}  dm-output-schema-v1.json\n`));
    assert.equal(readFileSync(join(out, "install-amux-decision-maker.sh"), "utf8"), installer);
    // Each bundle refuses to run anywhere but its unit, before it reads or listens to anything.
    for (const [bundle, args, code] of [
      ["broker.mjs", [], "account_not_broker"],
      ["launcher.mjs", ["decision-maker-openai"], "account_not_instance"],
      ["launcher.mjs", ["decision-maker-gemini"], "arguments_not_fixed"],
    ]) {
      const run = spawnSync(process.execPath, [join(out, bundle), ...args], { encoding: "utf8", input: "" });
      assert.equal(run.status, 2, `${bundle} ${args.join(" ")}`);
      assert.match(run.stderr, new RegExp(code));
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
