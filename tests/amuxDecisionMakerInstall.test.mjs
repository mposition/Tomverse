// The AMUX Decision Maker's runner installation, stage S2-3b
// (docs/policy/amux-decision-maker.md policy version 2, §5 and §5a): the six
// systemd units, the root installer and the release build. The units must run
// each part as its own S0 account with the hard limits §5 asks for; the
// installer's fixed values must be the launcher's; and installing must never
// enable or start anything, run a CLI beyond `--version`, or send anything.
// The installer's functions run under bash; nothing here is installed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("§5: the broker runs as its own account, writes only the request root, and reaches local sockets and, for S2b, the network", () => {
  const service = read("scripts/systemd/amux-dm-broker.service");
  assert.equal(directive(service, "User"), "amux-dm-broker");
  assert.equal(directive(service, "Group"), "amux-dm-broker");
  assert.equal(directive(service, "ExecStart"), "/usr/bin/node /opt/tomverse-amux-dm/broker.mjs");
  assert.deepEqual(directives(service, "ReadWritePaths"), [DM_REQUEST_ROOT]);
  // Stage S2b: the snapshot's public reads; the host egress rules hold it to GitHub.
  assert.equal(directive(service, "RestrictAddressFamilies"), "AF_UNIX AF_INET AF_INET6");
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

test("a CLI's vendor-home source is read only when its destination is not already §5a's file", () => {
  // 2026-10-23: a re-login updated codex in amux-dm-openai's home, and the
  // check on that source refused a broker-only reinstall whose codex copy was
  // already right.
  const needed = (state) => bash('dm_cli_source_needed "$1" "$2" && echo needed || echo skipped', state, SHA).stdout;
  assert.equal(needed(`file 0 0 555 1 ${SHA}`), "skipped\n");
  assert.equal(needed("absent"), "needed\n");
  assert.equal(needed(`file 0 0 555 1 ${OTHER_SHA}`), "needed\n");
  assert.equal(needed(`file 992 992 555 1 ${SHA}`), "needed\n");
  assert.equal(needed(`file 0 0 755 1 ${SHA}`), "needed\n");
  assert.equal(needed(`file 0 0 555 2 ${SHA}`), "needed\n");
  for (const state of ["link", "other", "unreadable"]) assert.equal(needed(state), "needed\n", state);
  assert.match(installer, /dm_cli_fits "\$DM_CODEX_DEST" "\$DM_CODEX_SOURCE" "\$DM_CODEX_SHA256"/);
  assert.match(installer, /dm_cli_fits "\$DM_CLAUDE_DEST" "\$DM_CLAUDE_SOURCE" "\$DM_CLAUDE_SHA256"/);
});

test("the CLI check passes on a right destination whatever the source, and otherwise only on a right source", () => {
  // dm_cli_fits itself, not only its predicate (review r-20261023-091230-5f9c44):
  // the destination's state is stubbed, since "same" needs a root-owned file;
  // the source is a real file whose sha256 the installer computes.
  const dir = mkdtempSync(join(tmpdir(), "amux-dm-cli-fits-"));
  try {
    const source = join(dir, "codex").replaceAll("\\", "/");
    writeFileSync(source, "codex stand-in\n");
    const right = createHash("sha256").update("codex stand-in\n").digest("hex");
    const missing = join(dir, "absent").replaceAll("\\", "/");
    const fits = (destState, sourcePath, wanted) =>
      bash(
        'DEST_STATE=$1; dm_file_state() { printf "%s\\n" "$DEST_STATE"; }; dm_cli_fits /dest "$2" "$3" && echo ok || echo refused',
        destState,
        sourcePath,
        wanted,
      ).stdout;
    const same = `file 0 0 555 1 ${right}`;
    // A right destination needs no source: missing or other bytes both pass.
    assert.equal(fits(same, missing, right), "ok\n");
    assert.equal(fits(same, source, OTHER_SHA), "refused\n", "a destination is only right with the wanted sha256");
    assert.equal(fits(`file 0 0 555 1 ${SHA}`, source, SHA), "ok\n", "a right destination ignores a source with other bytes");
    // Anything else reads the source, which must be the wanted file.
    const stale = "c".repeat(64);
    for (const destState of ["absent", `file 0 0 555 1 ${stale}`, `file 992 992 555 1 ${right}`, "link"]) {
      assert.equal(fits(destState, source, right), "ok\n", destState);
      assert.equal(fits(destState, missing, right), "refused\n", `${destState}, no source`);
      assert.equal(fits(destState, source, OTHER_SHA), "refused\n", `${destState}, other source bytes`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("what a later build may remove is exactly what the installer reads, plus the manifest", async () => {
  const { DM_RELEASE_TOP_FILES, DM_RELEASE_UNIT_FILES } = await import("../scripts/amux-decision-maker-release-out.mjs");
  const expected = installer.match(/readonly DM_RELEASE_FILES=\(\n([\s\S]*?)\n\)/)[1].split("\n").map((line) => line.trim().replace(/^"|"$/g, ""));
  assert.deepEqual(
    [...DM_RELEASE_TOP_FILES.filter((name) => name !== "manifest.sha256"), ...DM_RELEASE_UNIT_FILES.map((unit) => `systemd/${unit}`)].sort(),
    [...expected].sort(),
  );
});

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

// ---------------------------------------------------------------------------
// Codex's Code Mode host (§5a "함께 두는 파일")
// ---------------------------------------------------------------------------

const HOST_INSTALLER = "scripts/install-amux-dm-code-mode-host.sh";
const hostInstaller = read(HOST_INSTALLER);
const hostConstant = (name) => {
  const match = hostInstaller.match(new RegExp(`^readonly ${name}=("?)([^"\\n]*)\\1$`, "m"));
  assert.ok(match, `${name} is a readonly constant of the host installer`);
  return match[2];
};
const hostBash = (script, ...args) =>
  spawnSync(bashPath, ["-c", `source ${HOST_INSTALLER}\n${script}`, "test", ...args], { cwd: repositoryRoot, encoding: "utf8" });

test("the host installer installs exactly the launcher's pinned Code Mode host, from the pinned release asset", () => {
  const [host] = DM_LAUNCHER_SPECS["decision-maker-openai"].companions;
  assert.equal(hostConstant("DM_HOST_DEST"), host.path);
  assert.equal(hostConstant("DM_HOST_SHA256"), host.sha256);
  const policy = read("docs/policy/amux-decision-maker.md");
  assert.ok(policy.includes(`\`${hostConstant("DM_HOST_ASSET_SHA256")}\``), "§5a names the release asset's sha256");
  assert.ok(hostConstant("DM_HOST_ASSET_URL").endsWith(`/rust-v0.162.1/${hostConstant("DM_HOST_ASSET_MEMBER")}.tar.gz`));
  assert.ok(hostConstant("DM_HOST_ASSET_URL").startsWith("https://github.com/openai/codex/releases/download/"));
  // The host sits in the directory codex's permissions profile reads, beside codex.
  assert.equal(host.path.slice(0, host.path.lastIndexOf("/")), DM_CODEX_EXECUTABLE_PATH.slice(0, DM_CODEX_EXECUTABLE_PATH.lastIndexOf("/")));
});

test("the host installer is a dry run unless --apply, never runs the host, and refuses unknown arguments", { skip: process.platform === "win32" && !readdirSync(join(bashPath, "..")).includes("bash.exe") && "bash is not installed" }, () => {
  assert.equal(hostBash("true").status, 0, "sourcing runs nothing");
  assert.equal(spawnSync(bashPath, ["-n", HOST_INSTALLER], { cwd: repositoryRoot }).status, 0);
  const usage = hostBash('dm_main "$@"', "--force");
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage:/);
  assert.equal(hostBash('dm_main "$@"', "--rollback").status, 1);
  assert.match(hostBash('dm_main "$@"', "--rollback", "/tmp/elsewhere").stderr, /run as root|must be under/);
  const code = hostInstaller.replace(/^\s*#.*$/gm, "");
  // Nothing that writes runs before the --apply branch, and the host binary is never executed.
  const dryRunEnd = code.indexOf("if [[ $apply -eq 0 ]]; then");
  assert.ok(dryRunEnd > 0);
  const beforeApply = code.slice(code.indexOf("dm_main() {"), dryRunEnd);
  assert.doesNotMatch(beforeApply, /\/usr\/bin\/install -|\bmv -T|\bdm_place\b|> "\$backup/);
  assert.doesNotMatch(code, /"\$work\/\$DM_HOST_ASSET_MEMBER"\s*(?:$|[;&|])|"\$DM_HOST_DEST"\s+--/m);
  // The EXIT trap runs after dm_main returns, when its locals are gone: the path is expanded when it is set.
  assert.match(code, /printf -v quoted '%q' "\$work"\n\s*trap "rm -rf -- \$quoted" EXIT/);
  assert.doesNotMatch(code, /trap '[^']*\$work/);
  // A replaced file's owner, group and mode are kept beside its bytes, and --rollback puts them back.
  assert.match(code, /\/usr\/bin\/stat -c '%u %g %04a' -- "\$DM_HOST_DEST" > "\$backup\/meta"/);
  assert.match(code, /dm_place "\$backup\/codex-code-mode-host" .* "\$owner" "\$group" "\$mode"$/m);
});

// ---------------------------------------------------------------------------
// The DM's offline dependency cache (§0f-4, §5a "의존성")
// ---------------------------------------------------------------------------

const CACHE_SCRIPT = "scripts/amux-dm-dependency-cache.sh";
const cacheScript = read(CACHE_SCRIPT);
const cacheConstant = (name) => {
  const match = cacheScript.match(new RegExp(`^readonly ${name}=("?)([^"\\n]*)\\1$`, "m"));
  assert.ok(match, `${name} is a readonly constant of the cache script`);
  return match[2];
};

test("the cache script fills the paths the launcher's jail reads, as nobody for anything that runs code or reaches the network", async () => {
  const { DM_DEPENDENCY_CACHE_ROOT, DM_NPM_CACHE, DM_PRISMA_ENGINE_CACHE, DM_PINNED_NPM_CLI } = await import("../lib/amux/decisionMakerWorkCopy.ts");
  assert.equal(cacheConstant("DM_CACHE_ROOT"), DM_DEPENDENCY_CACHE_ROOT);
  assert.equal(`${cacheConstant("DM_CACHE_ROOT")}/npm`, DM_NPM_CACHE);
  assert.equal(`${cacheConstant("DM_CACHE_ROOT")}/prisma`, DM_PRISMA_ENGINE_CACHE);
  assert.equal(cacheConstant("DM_CACHE_NPM_CLI"), DM_PINNED_NPM_CLI);
  assert.equal(cacheConstant("DM_CACHE_REPOSITORY"), "https://github.com/mposition/Tomverse.git");
  assert.equal(cacheConstant("DM_CACHE_BRANCH"), "develop");
  const code = cacheScript.replace(/^\s*#.*$/gm, "");
  // git, npm and prisma run only through dm_cache_as_nobody; root only copies, owns and moves.
  for (const line of code.split("\n").filter((entry) => /\/usr\/bin\/(?:git|node)\b/.test(entry))) {
    if (/git -C "\$work\/src" -c safe\.directory='\*' rev-parse HEAD/.test(line)) continue;
    assert.match(line, /dm_cache_as_nobody "\$work"/, line.trim());
  }
  assert.match(code, /\/usr\/sbin\/runuser -u nobody -- \/usr\/bin\/env -i /);
  assert.match(code, /ci --ignore-scripts/);
  assert.doesNotMatch(code, /amux-dm-(?:openai|anthropic)|\/home\/|requests/, "nothing of the vendor accounts or the request root");
  // It installs the timer and never enables or starts anything; the operator does (the message only says how).
  assert.doesNotMatch(code, /^\s*(?:\/usr\/bin\/)?systemctl\s+(?:enable|start|restart)\b/m);
  assert.match(code, /\/usr\/bin\/systemctl daemon-reload/);
  const service = read("scripts/systemd/amux-dm-dependency-cache.service");
  assert.equal(directive(service, "ExecStart"), `${cacheConstant("DM_CACHE_SCRIPT_DEST")} --refresh`);
  assert.equal(directive(service, "Type"), "oneshot");
  assert.doesNotMatch(service, /^\[Install\]$/m);
  const timer = read("scripts/systemd/amux-dm-dependency-cache.timer");
  assert.equal(directive(timer, "OnCalendar"), "*-*-* 17:30:00 UTC");
  assert.equal(directive(timer, "Persistent"), "true");
});

test("the cache script refuses anything but --refresh or --install, and only as root", { skip: process.platform === "win32" && !readdirSync(join(bashPath, "..")).includes("bash.exe") && "bash is not installed" }, () => {
  assert.equal(spawnSync(bashPath, ["-n", CACHE_SCRIPT], { cwd: repositoryRoot }).status, 0);
  for (const args of [[], ["--apply"], ["--refresh", "--install"]]) {
    const result = spawnSync(bashPath, [CACHE_SCRIPT, ...args], { cwd: repositoryRoot, encoding: "utf8" });
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /usage|run as root/);
  }
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    assert.match(spawnSync(bashPath, [CACHE_SCRIPT, "--refresh"], { cwd: repositoryRoot, encoding: "utf8" }).stderr, /run as root/);
  }
});

test("the launcher units leave out ProtectKernelTunables= so the DM jail can mount its own /proc, and keep the rest", () => {
  for (const instance of Object.keys(VENDOR_ACCOUNTS)) {
    const service = read(`scripts/systemd/amux-dm-launcher-${SHORT[instance]}@.service`);
    assert.equal(directive(service, "ProtectKernelTunables"), undefined);
    for (const [name, value] of [["NoNewPrivileges", "true"], ["CapabilityBoundingSet", ""], ["ProtectProc", "invisible"],
      ["ProtectKernelModules", "true"], ["ProtectControlGroups", "true"], ["PrivateTmp", "true"], ["UMask", "0077"]]) {
      assert.equal(directive(service, name), value, `${instance} ${name}`);
    }
    // No unit setting that would stop the jail: user namespaces and netlink (bwrap's --unshare-net brings up loopback).
    assert.equal(directive(service, "RestrictNamespaces"), undefined);
    assert.equal(directive(service, "RestrictAddressFamilies"), undefined);
  }
});

test("a replaced cache is kept while a request may still read it, and pruned only after", { skip: process.platform === "win32" && !readdirSync(join(bashPath, "..")).includes("bash.exe") && "bash is not installed" }, () => {
  // Review r-20261123-105620-63d64b: a request bound the old cache; deleting it under the request broke its install.
  const dir = mkdtempSync(join(tmpdir(), "amux-dm-cache-prune-"));
  try {
    const root = dir.replaceAll("\\", "/");
    const now = 1_800_000_000;
    const keep = Number(cacheConstant("DM_CACHE_KEEP_REPLACED_SECONDS").replace(/^\$\(\((\d+) \* 60 \* 60\)\)$/, (_, hours) => String(hours * 3600)));
    assert.ok(keep >= 2 * 60 * 60, "at least the DM's hard timeout");
    for (const age of [0, keep - 60, keep + 60, 10 * keep]) {
      spawnSync(bashPath, ["-c", `mkdir -p "${root}/npm.gen-${now - age}/x"`]);
    }
    spawnSync(bashPath, ["-c", `mkdir -p "${root}/npm.gen-notanumber"`]);
    // The generation the link points to is never pruned, however old (POSIX: Git Bash copies instead of linking).
    const current = now - 100 * keep;
    const links = process.platform !== "win32";
    if (links) spawnSync(bashPath, ["-c", `mkdir -p "${root}/npm.gen-${current}" && ln -s "npm.gen-${current}" "${root}/npm"`]);
    const result = spawnSync(bashPath, ["-c", `source ${CACHE_SCRIPT}\ndm_cache_prune_replaced "$1" npm "$2"`, "test", root, String(now)], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      readdirSync(dir).sort(),
      [...(links ? ["npm", `npm.gen-${current}`] : []), `npm.gen-${now - keep + 60}`, `npm.gen-${now}`, "npm.gen-notanumber"].sort(),
    );
    // The swap points the link at a new generation in one rename: the cache path never goes missing,
    // and the refresh never deletes the current cache itself.
    assert.match(cacheScript, /\/usr\/bin\/ln -sfn -- "\$generation" "\$DM_CACHE_ROOT\/\.\$name\.link-\$now"\n\s*\/usr\/bin\/mv -T -- "\$DM_CACHE_ROOT\/\.\$name\.link-\$now" "\$DM_CACHE_ROOT\/\$name"/);
    assert.doesNotMatch(cacheScript.replace(/^\s*#.*$/gm, ""), /rm -rf -- "\$DM_CACHE_ROOT\/\$name"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
