/**
 * AMUX Decision Maker S0: the two-way account isolation measurement
 * (docs/policy/amux-decision-maker.md §5, §12; docs/ops/amux/decision-maker-s0.md).
 *
 * The script runs on the Ubuntu runner as root. Here it runs under bash with
 * the commands that act as another account -- runuser, setpriv -- and the
 * account database -- getent, id, stat -- replaced by exported shell
 * functions, so the same test passes on the CI runner and on a Windows
 * checkout with Git Bash. A fake host is a list of the attempts it allows;
 * everything else is refused. What is under test is the judgment: `isolated`
 * only when every control succeeded and every isolation check was refused,
 * and nothing secret in the output.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBashCommand } from "./support/gitBash.mjs";

const DIR = new URL("../scripts/amux-decision-maker-s0/", import.meta.url);
const script = readFileSync(new URL("measure-isolation", DIR), "utf8").replace(/\r\n/g, "\n");
const example = readFileSync(new URL("isolation.conf.example", DIR), "utf8").replace(/\r\n/g, "\n");

const bash = resolveBashCommand();
const noBash = bash
  ? false
  : "no usable bash: git's installation has no bin/bash.exe or usr/bin/bash.exe, and PATH offers only the WSL launcher";

const USERS = {
  tommy: 1000,
  "tomverse-bridge": 1001,
  "amux-dm-broker": 2000,
  "amux-dm-openai": 2001,
  "amux-dm-anthropic": 2002,
};

const GROUPS = {
  tommy: ["tommy"],
  "tomverse-bridge": ["tomverse-bridge"],
  // The broker sets each request directory's group, so it is in both.
  "amux-dm-broker": ["amux-dm-broker", "amux-dm-openai", "amux-dm-anthropic"],
  "amux-dm-openai": ["amux-dm-openai"],
  "amux-dm-anthropic": ["amux-dm-anthropic"],
};

const REQUESTS = "@ROOT@/requests";
const requestDir = (vendor) => `${REQUESTS}/amux-dm-s0-RUN-${vendor}`;

const CONFIG = {
  WORKER_USER: "tommy",
  BRIDGE_USER: "tomverse-bridge",
  BROKER_USER: "amux-dm-broker",
  OPENAI_USER: "amux-dm-openai",
  ANTHROPIC_USER: "amux-dm-anthropic",
  REQUEST_ROOT: REQUESTS,
  WORKER_PATHS: "/home/tommy /home/tommy/Tomverse /home/tommy/.amux",
  BRIDGE_ENV_FILE: "/etc/tomverse-bridge/bridge.env",
  OPENAI_CLI: "/home/amux-dm-openai/.local/bin/codex",
  ANTHROPIC_CLI: "/home/amux-dm-anthropic/.local/bin/claude",
  OPENAI_HOSTS: "api.openai.com:443 chatgpt.com:443",
  ANTHROPIC_HOSTS: "api.anthropic.com:443",
  GITHUB_HOSTS: "api.github.com:443 raw.githubusercontent.com:443",
  OUTSIDE_HOSTS: "example.com:443",
};

/** Every control succeeding, and nothing else: an isolated host. */
const CONTROLS = [
  `amux-dm-broker mkreq ${requestDir("openai")}`,
  `amux-dm-broker mkreq ${requestDir("anthropic")}`,
  `amux-dm-openai read ${requestDir("openai")}/card`,
  `amux-dm-anthropic read ${requestDir("anthropic")}/card`,
  "amux-dm-openai exec /home/amux-dm-openai/.local/bin/codex",
  "amux-dm-anthropic exec /home/amux-dm-anthropic/.local/bin/claude",
  "amux-dm-openai connect api.openai.com:443",
  "amux-dm-openai connect chatgpt.com:443",
  "amux-dm-anthropic connect api.anthropic.com:443",
  "amux-dm-broker connect api.github.com:443",
  "amux-dm-broker connect raw.githubusercontent.com:443",
  "tommy read @ROOT@/homes/tommy",
  `amux-dm-broker rmreq ${requestDir("openai")}`,
  `amux-dm-broker rmreq ${requestDir("anthropic")}`,
];

const PRELUDE = String.raw`
FAKE_ROOT=$PWD
sed "s#@ROOT@#$FAKE_ROOT#g" config.tmpl > config
sed "s#@ROOT@#$FAKE_ROOT#g" allow.tmpl > allow
: > attempts
: > sleepers
while read -r user uid; do
  [ -n "$user" ] && printf '%s:x:%s:%s::%s/homes/%s:/bin/bash\n' "$user" "$uid" "$uid" "$FAKE_ROOT" "$user"
done < users > passwd
id() {
  case "$1" in
    -u) printf '%s\n' "$FAKE_EUID" ;;
    -gn) awk -v u="$2" '$1 == u { print $2; exit }' "$FAKE_ROOT/groups" ;;
    -nG) awk -v u="$2" '$1 == u { for (i = 2; i <= NF; i++) printf "%s ", $i; print "" }' "$FAKE_ROOT/groups" ;;
    *) return 2 ;;
  esac
}
getent() {
  [ "$1" = passwd ] || return 2
  awk -F: -v u="$2" '$1 == u { print; found = 1 } END { exit !found }' "$FAKE_ROOT/passwd"
}
runuser() {
  local user=$2 kind target
  shift 3
  while [ "$#" -gt 0 ] && [ "$1" != -c ]; do shift; done
  kind=%{3#amux-dm-s0-}
  target=$4
  local actual=$target
  case $kind in
    environ | fd | cwd | cmdline | ptrace)
      target="pid-of-$(awk -v p="$target" '$1 == p { print $2 }' "$FAKE_ROOT/sleepers")" ;;
  esac
  target=$(printf '%s' "$target" | sed -E 's/amux-dm-s0-[0-9]+-[0-9]+-/amux-dm-s0-RUN-/')
  printf '%s %s %s\n' "$user" "$kind" "$target" >> "$FAKE_ROOT/attempts"
  grep -qxF -- "$user $kind $target" "$FAKE_ROOT/allow" || return 1
  case $kind in
    mkreq) mkdir -p -- "$actual" && printf 'probe\n' > "$actual/card" ;;
    rmreq) rm -rf -- "$actual" ;;
  esac
}
timeout() {
  while [ "$#" -gt 0 ] && [ "%{1#-}" != "$1" ]; do shift; done
  shift
  "$@"
}
setpriv() {
  printf '%s %s\n' "$BASHPID" "%{1#--reuid=}" >> "$FAKE_ROOT/sleepers"
  exec sleep 30
}
stat() { awk -v p="%{3#/proc/}" '$1 == p { print $2 }' "$FAKE_ROOT/sleepers"; }
python3() { return 0; }
sudo() {
  # Only root's question about another account: sudo -n -l -U <user>.
  [ "$1 $2 $3" = "-n -l -U" ] || { printf 'unexpected sudo %s\n' "$*" >> "$FAKE_ROOT/attempts"; return 1; }
  if grep -qxF -- "$4" "$FAKE_ROOT/sudoers"; then
    printf 'User %s may run the following commands on host:\n    (ALL : ALL) ALL\n' "$4"
  else
    printf 'User %s is not allowed to run sudo on host.\n' "$4"
  fi
}
export FAKE_ROOT
export -f id getent runuser timeout setpriv stat python3 sudo
bash ./measure-isolation ./config
status=$?
# A sleeper still alive after the run would be a process left on the host.
while read -r pid _; do
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && printf '%s\n' "$pid" >> alive
done < sleepers
exit $status
`.replaceAll("%{", "${");

const configText = (config) =>
  Object.entries(config)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n";

/**
 * One run on a fake host. `allow` is every attempt it lets through; `homes`
 * are files to create under an account's home before the run.
 */
const measure = ({
  config = CONFIG,
  configRaw = null,
  allow = CONTROLS,
  users = USERS,
  groups = GROUPS,
  euid = 0,
  homes = {},
  sudoers = [],
} = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "amux-dm-s0-"));
  try {
    writeFileSync(join(dir, "measure-isolation"), script);
    writeFileSync(join(dir, "config.tmpl"), configRaw ?? configText(config));
    writeFileSync(join(dir, "allow.tmpl"), allow.join("\n") + "\n");
    writeFileSync(
      join(dir, "users"),
      Object.entries(users)
        .map(([user, uid]) => `${user} ${uid}`)
        .join("\n") + "\n",
    );
    writeFileSync(
      join(dir, "groups"),
      Object.entries(groups)
        .map(([user, names]) => `${user} ${names.join(" ")}`)
        .join("\n") + "\n",
    );
    mkdirSync(join(dir, "requests"));
    writeFileSync(join(dir, "sudoers"), sudoers.map((user) => `${user}\n`).join(""));
    for (const [user, files] of Object.entries(homes)) {
      for (const [relative, content] of Object.entries(files)) {
        const path = join(dir, "homes", user, ...relative.split("/"));
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, content);
      }
    }
    const result = spawnSync(bash, ["-c", PRELUDE], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, FAKE_EUID: String(euid) },
    });
    const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
    let report = null;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      report = null;
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      report,
      attempts: read("attempts").split("\n").filter(Boolean),
      alive: read("alive").split("\n").filter(Boolean),
      leftovers: readdirSync(join(dir, "requests")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const failing = (report) => report.checks.filter((check) => !check.pass).map((check) => check.id);

test("an isolated host: every control succeeds, every isolation check is refused", { skip: noBash }, () => {
  const run = measure();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.report.verdict, "isolated");
  assert.equal(run.report.schema, "amux-dm-s0-isolation/1");
  assert.equal(run.report.policyVersion, 1);
  assert.equal(run.report.scriptSha256, createHash("sha256").update(script, "utf8").digest("hex"));
  assert.match(run.report.configSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(failing(run.report), []);
  assert.deepEqual(run.report.summary, {
    checks: run.report.checks.length,
    controlFailures: 0,
    isolationFailures: 0,
    reasons: [],
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(run.report.subjects).map(([role, subject]) => [role, subject.uid])),
    {
      worker: 1000,
      bridge: 1001,
      broker: 2000,
      "decision-maker-openai": 2001,
      "decision-maker-anthropic": 2002,
    },
  );
  // Every control expects success and every isolation check a refusal or an absence.
  for (const check of run.report.checks) {
    assert.equal(check.expect, check.class === "control" ? "allowed" : check.expect === "absent" ? "absent" : "denied", check.id);
  }
  const controls = run.report.checks.filter((check) => check.class === "control");
  assert.equal(controls.length, CONTROLS.length);
  // The policy's two directions are both measured.
  const ids = new Set(run.report.checks.map((check) => check.id));
  for (const id of [
    "openai_cannot_read_worker_home",
    "openai_cannot_run_anthropic_cli",
    "openai_cannot_reach_outside_own_vendor",
    "anthropic_cannot_read_openai_request",
    "broker_cannot_read_bridge_env",
    "broker_cannot_reach_vendors",
    "worker_cannot_read_openai_request",
    "worker_cannot_ptrace_decision-maker-openai",
    "worker_cannot_environ_broker",
    "bridge_cannot_list_requests",
    "no_shared_uid",
    "worker_not_in_openai_group",
  ]) {
    assert.ok(ids.has(id), id);
  }
  // Every attempt was made by one of the five accounts, of a closed kind.
  const kinds = new Set(["read", "write", "exec", "connect", "mkreq", "rmreq", "environ", "fd", "cwd", "cmdline", "ptrace"]);
  for (const line of run.attempts) {
    const [user, kind] = line.split(" ");
    assert.ok(Object.hasOwn(USERS, user), line);
    assert.ok(kinds.has(kind), line);
  }
  // The broker removed its probe directories, and every sleeper was killed.
  assert.deepEqual(run.leftovers, []);
  assert.deepEqual(run.alive, []);
});

test("a worker that can read a vendor's request is not isolated", { skip: noBash }, () => {
  const run = measure({ allow: [...CONTROLS, `tommy read ${requestDir("openai")}/card`] });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.report.verdict, "not_isolated");
  assert.deepEqual(failing(run.report), ["worker_cannot_read_openai_request"]);
});

test("a vendor account that reaches GitHub, or the other vendor, is not isolated", { skip: noBash }, () => {
  for (const extra of ["amux-dm-openai connect api.github.com:443", "amux-dm-anthropic connect chatgpt.com:443"]) {
    const run = measure({ allow: [...CONTROLS, extra] });
    assert.equal(run.status, 1, extra);
    const vendor = extra.includes("openai connect") ? "openai" : "anthropic";
    assert.deepEqual(failing(run.report), [`${vendor}_cannot_reach_outside_own_vendor`], extra);
  }
});

test("a worker that can ptrace a DM process is not isolated", { skip: noBash }, () => {
  const run = measure({ allow: [...CONTROLS, `tommy ptrace pid-of-${USERS["amux-dm-anthropic"]}`] });
  assert.equal(run.status, 1);
  assert.deepEqual(failing(run.report), ["worker_cannot_ptrace_decision-maker-anthropic"]);
});

test("a credential in a DM account's home is a leak, named and never quoted", { skip: noBash }, () => {
  const run = measure({
    homes: {
      "amux-dm-openai": { ".netrc": "machine example.com login dm password S0-SECRET-VALUE\n" },
      "amux-dm-anthropic": { ".ssh/id_ed25519": "-----BEGIN OPENSSH PRIVATE KEY----- S0-SECRET-KEY\n", ".ssh/known_hosts": "github.com ssh-ed25519 AAAA\n" },
      "amux-dm-broker": { ".gitconfig": "[credential]\n\thelper = store\n" },
    },
  });
  assert.equal(run.status, 1);
  const leaks = run.report.checks.filter((check) => !check.pass);
  assert.deepEqual(
    leaks.map((check) => [check.subject, check.target, check.observed]),
    [
      ["broker", "git credential.helper", "present"],
      ["decision-maker-openai", "~/.netrc", "present"],
      ["decision-maker-anthropic", "~/.ssh/*", "present"],
    ],
  );
  assert.doesNotMatch(run.stdout, /S0-SECRET|BEGIN OPENSSH|helper = store/);
});

test("the other vendor's login in a DM account's home is a leak", { skip: noBash }, () => {
  const run = measure({ homes: { "amux-dm-openai": { ".claude.json": "{}" }, "amux-dm-anthropic": { ".codex/auth.json": "{}" } } });
  assert.equal(run.status, 1);
  assert.deepEqual(
    run.report.checks.filter((check) => !check.pass).map((check) => [check.subject, check.target]),
    [
      ["decision-maker-openai", "~/.claude.json"],
      ["decision-maker-anthropic", "~/.codex"],
    ],
  );
});

test("sudo rights for the worker, the broker or a DM account are a leak, asked by root and never tried", { skip: noBash }, () => {
  const run = measure({ sudoers: ["amux-dm-broker", "tommy"] });
  assert.equal(run.status, 1);
  assert.deepEqual(failing(run.report), ["worker_has_no_sudo", "broker_has_no_sudo"]);
  // No account ran sudo itself; root asked about each.
  assert.ok(run.attempts.every((line) => !line.startsWith("unexpected sudo")), run.attempts.join("\n"));
});

test("a shared UID or a shared vendor group is not isolated", { skip: noBash }, () => {
  {
    const run = measure({ users: { ...USERS, "tomverse-bridge": USERS.tommy } });
    assert.equal(run.status, 1);
    assert.ok(failing(run.report).includes("no_shared_uid"));
  }
  {
    const run = measure({ groups: { ...GROUPS, tommy: ["tommy", "amux-dm-openai"] } });
    assert.equal(run.status, 1);
    assert.deepEqual(failing(run.report), ["worker_not_in_openai_group"]);
  }
});

test("a failed control makes the run incomplete, never isolated, whatever was refused", { skip: noBash }, () => {
  // No route to the vendor: every connection refused looks like isolation
  // and proves nothing.
  for (const missing of ["amux-dm-openai connect api.openai.com:443", "amux-dm-anthropic exec /home/amux-dm-anthropic/.local/bin/claude", "tommy read @ROOT@/homes/tommy"]) {
    const run = measure({ allow: CONTROLS.filter((entry) => entry !== missing) });
    assert.equal(run.status, 2, missing);
    assert.equal(run.report.verdict, "incomplete", missing);
    assert.deepEqual(run.report.summary.reasons, ["control_failed"], missing);
    assert.equal(run.report.summary.isolationFailures, 0, missing);
  }
});

test("a broker that cannot remove its request leaves nothing behind: root removes it", { skip: noBash }, () => {
  const run = measure({ allow: CONTROLS.filter((entry) => !entry.includes(" rmreq ")) });
  assert.equal(run.status, 2);
  assert.deepEqual(
    run.report.checks.filter((check) => !check.pass).map((check) => check.id),
    ["broker_removes_openai_request", "broker_removes_anthropic_request"],
  );
  assert.deepEqual(run.leftovers, []);
  assert.deepEqual(run.alive, []);
});

test("a missing account ends the run before any probe", { skip: noBash }, () => {
  const users = { ...USERS };
  delete users["amux-dm-broker"];
  const run = measure({ users });
  assert.equal(run.status, 2);
  assert.equal(run.report.verdict, "incomplete");
  assert.deepEqual(run.report.summary.reasons, ["missing_user:broker"]);
  assert.deepEqual(run.report.checks, []);
  assert.equal(run.report.subjects.broker.uid, null);
  assert.deepEqual(run.attempts, []);
});

test("not root: nothing is attempted", { skip: noBash }, () => {
  const run = measure({ euid: 1000 });
  assert.equal(run.status, 77);
  assert.equal(run.stdout, "");
  assert.deepEqual(run.attempts, []);
});

test("a config that is not exactly the closed key list of safe values is refused before anything runs", { skip: noBash }, () => {
  const cases = [
    configText(CONFIG) + "EXTRA=1\n",
    configText(CONFIG) + "WORKER_USER=tommy\n",
    configText({ ...CONFIG, BRIDGE_ENV_FILE: "" }),
    configText({ ...CONFIG, REQUEST_ROOT: "/var/lib/../tmp" }),
    configText({ ...CONFIG, REQUEST_ROOT: "relative/requests" }),
    configText({ ...CONFIG, OPENAI_CLI: "/usr/bin/codex; rm -rf /" }),
    configText({ ...CONFIG, OPENAI_HOSTS: "api.openai.com" }),
    configText({ ...CONFIG, WORKER_USER: "Tommy$(id)" }),
    configText(CONFIG) + "not a pair\n",
  ];
  for (const configRaw of cases) {
    const run = measure({ configRaw });
    assert.equal(run.status, 64, configRaw);
    assert.equal(run.stdout, "", configRaw);
    assert.deepEqual(run.attempts, [], configRaw);
  }
});

test("the shipped example config is accepted as written", { skip: noBash }, () => {
  // Every key the script knows, in the example, with values it accepts: the
  // run gets past the config and stops only where the fake host differs.
  const run = measure({ configRaw: example });
  assert.notEqual(run.status, 64, run.stderr);
});

test("the script never sources its config and only asks a vendor CLI for its version", () => {
  assert.doesNotMatch(script, /^\s*(source|\.)\s+["$]/m);
  assert.doesNotMatch(script, /eval\s/);
  assert.match(script, /exec\) snippet='"\$1" --version' ;;/);
  // No other way to run a CLI: the configured CLI paths reach only that probe.
  assert.equal(script.match(/CLI_OF\[/g)?.length, 4);
  assert.match(script, /^set -u -o pipefail$/m);
});
