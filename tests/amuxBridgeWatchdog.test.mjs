/**
 * The AMUX bridge watchdog: which request one run sends for each bridge state,
 * and that the ping URL never reaches its output.
 *
 * docs/ops/amux/bridge-monitoring.md is the runbook. The script runs on the
 * Ubuntu host under systemd; here it runs under bash with `systemctl` and
 * `curl` replaced by exported shell functions, so the same test passes on the
 * CI runner and on a Windows checkout with Git Bash.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBashCommand } from "./support/gitBash.mjs";

const DIR = new URL("../scripts/amux-bridge-watchdog/", import.meta.url);
const read = (name) => readFileSync(new URL(name, DIR), "utf8");
const script = read("tomverse-bridge-watchdog");
const service = read("tomverse-bridge-watchdog.service");
const timer = read("tomverse-bridge-watchdog.timer");
const install = read("install.sh");

const bash = resolveBashCommand();
const noBash = bash
  ? false
  : "no usable bash: git's installation has no bin/bash.exe or usr/bin/bash.exe, and PATH offers only the WSL launcher";

const URL_VALUE = "https://hc-ping.example/0f3c5a8e-1b2d-4c6e-9f00-123456789abc";

/**
 * One watchdog run. Every path handed to bash is relative to the temporary
 * working directory, so no Windows path has to survive the trip.
 */
const MAIN = "tomverse-bridge.service";
const V22 = [
  "tomverse-amux-v22-bridge@claude-impl.service",
  "tomverse-amux-v22-sidecar@claude-impl.service",
  "tomverse-amux-v22-bridge@claude-review.service",
];

/**
 * `systemctl` as the host answers it: `list-units` prints every fake unit but
 * the main one (which, being enabled, the script checks by name anyway), and
 * `is-active` answers from FAKE_STATES, `inactive` for a unit it does not know.
 * FAKE_STATES is space-separated, so a space inside an answer travels as `~`.
 */
const SYSTEMCTL_STUB = [
  "systemctl() {",
  '  if [ "$1" = list-units ]; then',
  '    for pair in $FAKE_STATES; do unit=${pair%%=*}; [ "$unit" = tomverse-bridge.service ] || printf "%s loaded active running fake\\n" "$unit"; done',
  "    return 0",
  "  fi",
  '  if [ "$1" = is-active ]; then',
  '    for pair in $FAKE_STATES; do if [ "${pair%%=*}" = "$2" ]; then answer=${pair#*=}; printf "%s\\n" "${answer//\\~/ }"; [ "$answer" = active ]; return; fi; done',
  '    printf "inactive\\n"; return 3',
  "  fi",
  "  return 1",
  "}",
].join("\n");

const run = ({
  state,
  states = { [MAIN]: state },
  url = URL_VALUE,
  credential = true,
  curlStatus = 0,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-watchdog-"));
  try {
    writeFileSync(join(dir, "watchdog"), script.replace(/\r\n/g, "\n"));
    if (credential) writeFileSync(join(dir, "ping-url"), `${url}\n`);
    const prelude = [
      SYSTEMCTL_STUB,
      // Arguments and the stdin config are kept apart: the URL may only ever
      // be in the second.
      'curl() { printf "%s\\n" "$*" >> args.log; while IFS= read -r line; do printf "%s\\n" "$line" >> config.log; done; return "$FAKE_CURL_STATUS"; }',
      "export -f systemctl curl",
      "bash ./watchdog",
    ].join("\n");
    const result = spawnSync(bash, ["-c", prelude], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        CREDENTIALS_DIRECTORY: credential ? "." : "",
        FAKE_STATES: Object.entries(states)
          .map(([unit, unitState]) => `${unit}=${unitState}`)
          .join(" "),
        FAKE_CURL_STATUS: String(curlStatus),
      },
    });
    const lines = (name) =>
      existsSync(join(dir, name))
        ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)
        : [];
    const requests = lines("config.log").map(
      (line) => line.match(/^url = "(.*)"$/)?.[1] ?? `unparsed: ${line}`
    );
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      requests,
      args: lines("args.log"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("an active bridge sends the success signal", { skip: noBash }, () => {
  const result = run({ state: "active" });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.requests, [URL_VALUE]);
});

for (const state of ["failed", "inactive"]) {
  test(`a ${state} bridge sends the failure signal`, { skip: noBash }, () => {
    const result = run({ state });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.requests, [`${URL_VALUE}/fail`]);
  });
}

// A state on its way somewhere is not evidence either way. Saying nothing
// leaves it to the monitor's grace period, which is also what catches a
// bridge stuck restarting.
for (const state of ["activating", "deactivating", "reloading", ""]) {
  test(`a bridge that is ${state || "unreadable"} sends nothing`, { skip: noBash }, () => {
    const result = run({ state });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.requests, []);
  });
}

// The v22 workers each run their own bridge and sidecar. On 2026-10-12 a
// production deploy halted all five bridges; watching the main unit alone
// would have missed four.
const allActive = Object.fromEntries([MAIN, ...V22].map((unit) => [unit, "active"]));

test("every bridge and sidecar active sends the success signal", { skip: noBash }, () => {
  const result = run({ states: allActive });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.requests, [URL_VALUE]);
  assert.match(result.output, /4 unit\(s\), 0 down, 0 in transition; sent up/);
});

for (const unit of V22) {
  test(`a failed ${unit} sends the failure signal`, { skip: noBash }, () => {
    const result = run({ states: { ...allActive, [unit]: "failed" } });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.requests, [`${URL_VALUE}/fail`]);
    // Which unit stopped stays in the host's journal.
    assert.match(result.output, new RegExp(`${unit.replace(/[.@]/g, "\\$&")} is failed`));
  });
}

test("a failure outranks a unit still in transition", { skip: noBash }, () => {
  const result = run({
    states: { ...allActive, [V22[0]]: "activating", [V22[1]]: "failed" },
  });
  assert.deepEqual(result.requests, [`${URL_VALUE}/fail`]);
});

test("a v22 unit in transition with nothing down sends nothing", { skip: noBash }, () => {
  const result = run({ states: { ...allActive, [V22[2]]: "activating" } });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.requests, []);
});

test("a main unit that is not loaded at all is down", { skip: noBash }, () => {
  const { [MAIN]: _main, ...withoutMain } = allActive;
  const result = run({ states: withoutMain });
  assert.deepEqual(result.requests, [`${URL_VALUE}/fail`]);
});

test("a listed unit outside the bridge names is ignored", { skip: noBash }, () => {
  const result = run({
    states: { ...allActive, "tomverse-amux-v22-bridge@x;y.service": "failed" },
  });
  assert.deepEqual(result.requests, [URL_VALUE]);
});

test("no credential sends nothing and fails the run", { skip: noBash }, () => {
  const result = run({ state: "active", credential: false });
  assert.equal(result.status, 2, result.output);
  assert.deepEqual(result.requests, []);
});

for (const url of [
  "http://hc-ping.example/abc",
  "https://hc-ping.example/abc?state=x",
  "https://user:pass@hc-ping.example/abc",
  "https://hc-ping.example",
  "file:///etc/passwd",
]) {
  test(`a URL that is not plain https is refused: ${url}`, { skip: noBash }, () => {
    const result = run({ state: "active", url });
    assert.equal(result.status, 2, result.output);
    assert.deepEqual(result.requests, []);
  });
}

test("an undelivered signal fails the run", { skip: noBash }, () => {
  const result = run({ state: "failed", curlStatus: 22 });
  assert.equal(result.status, 1, result.output);
});

test("the ping URL never reaches the output", { skip: noBash }, () => {
  for (const options of [
    { state: "active" },
    { state: "failed" },
    { state: "activating" },
    { state: "active", curlStatus: 7 },
  ]) {
    const result = run(options);
    assert.ok(!result.output.includes("hc-ping.example"), result.output);
    assert.ok(!result.output.includes("0f3c5a8e"), result.output);
    // Nor curl's arguments, which any local user can read from /proc.
    for (const args of result.args) {
      assert.ok(!args.includes("hc-ping.example"), args);
      assert.match(args, /^--config - /);
    }
  }
});

test("the unit runs the installed script with the URL as a credential", () => {
  assert.match(service, /^ExecStart=\/usr\/local\/libexec\/tomverse-bridge-watchdog$/m);
  assert.match(service, /^DynamicUser=yes$/m);
  assert.match(
    service,
    /^LoadCredential=ping-url:\/etc\/tomverse-bridge-watchdog\/ping-url$/m
  );
  assert.match(install, /\/usr\/local\/libexec\/tomverse-bridge-watchdog\b/);
  // A host without /usr/local/libexec must not fail the install half-way.
  assert.match(install, /^install -d -o root -g root -m 0755 \/usr\/local\/libexec$/m);
  assert.match(install, /url_file="\$config\/ping-url"/);
  assert.match(install, /^config=\/etc\/tomverse-bridge-watchdog$/m);
  // Never an environment variable: a unit's environment is readable by any
  // local user through systemctl show.
  assert.doesNotMatch(service, /^Environment(File)?=/m);
});

test("the timer runs every five minutes", () => {
  assert.match(timer, /^OnCalendar=\*:0\/5$/m);
});

test("the install script and the watchdog accept the same URLs", () => {
  const pattern = (text) => text.match(/^\s*url_pattern='([^']+)'$/m)?.[1];
  assert.ok(pattern(script));
  assert.equal(pattern(install), pattern(script));
});

test("the install script reads the URL without echoing it", () => {
  assert.match(install, /read -rs url/);
  // The one line that writes the value writes it into the credential file.
  const writes = install
    .split("\n")
    .filter((line) => /\b(echo|printf)\b.*"\$url"/.test(line));
  assert.deepEqual(writes, [`  printf '%s\\n' "$url" >"$url_file.new"`]);
});

// The first installed version read every unit as "unreadable" and said
// nothing more, and the install reported success because a run that sends
// nothing exits 0.
test("an unreadable unit names systemctl's error, and sends nothing", { skip: noBash }, () => {
  const result = run({ states: { ...allActive, [MAIN]: "Failed~to~connect~to~bus:~Permission~denied" } });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.requests, []);
  assert.match(
    result.output,
    /tomverse-bridge\.service is unreadable \(systemctl: Failed to connect to bus: Permission denied\)/
  );
});

test("the install fails unless its own run sent a signal", () => {
  assert.match(install, /_SYSTEMD_INVOCATION_ID=\$invocation/);
  assert.match(install, /grep -qE '; sent \(up\|down\)\$'/);
  // The timer is enabled only after the check, and switched off on failure.
  const check = install.indexOf("grep -qE");
  assert.ok(check > 0 && install.lastIndexOf("systemctl enable --now") > check);
  assert.match(install, /systemctl disable --now tomverse-bridge-watchdog\.timer/);
});
