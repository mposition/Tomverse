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
const run = ({ state, url = URL_VALUE, credential = true, curlStatus = 0 }) => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-watchdog-"));
  try {
    writeFileSync(join(dir, "watchdog"), script.replace(/\r\n/g, "\n"));
    if (credential) writeFileSync(join(dir, "ping-url"), `${url}\n`);
    const prelude = [
      'systemctl() { printf "%s\\n" "$FAKE_STATE"; [ "$FAKE_STATE" = active ]; }',
      'curl() { printf "%s\\n" "${@: -1}" >> curl.log; return "$FAKE_CURL_STATUS"; }',
      "export -f systemctl curl",
      "bash ./watchdog",
    ].join("\n");
    const result = spawnSync(bash, ["-c", prelude], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        CREDENTIALS_DIRECTORY: credential ? "." : "",
        FAKE_STATE: state,
        FAKE_CURL_STATUS: String(curlStatus),
      },
    });
    const log = join(dir, "curl.log");
    const requests = existsSync(log)
      ? readFileSync(log, "utf8").split("\n").filter(Boolean)
      : [];
    return { status: result.status, output: `${result.stdout}${result.stderr}`, requests };
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
