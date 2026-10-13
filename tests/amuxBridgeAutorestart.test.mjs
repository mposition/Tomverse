/**
 * The AMUX bridge auto-restart: which halted bridges one run restarts, which
 * it leaves halted, and that its polkit rule grants restart of the bridge
 * units and nothing else.
 *
 * docs/ops/amux/bridge-monitoring.md §5 is the runbook. The script runs on the
 * Ubuntu host under systemd; here it runs under bash with `systemctl`,
 * `journalctl` and `curl` replaced by exported shell functions, so the same
 * test passes on the CI runner and on a Windows checkout with Git Bash. The
 * journal lines are the bridges' real lines from 2026-10-13.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { resolveBashCommand } from "./support/gitBash.mjs";

const DIR = new URL("../scripts/amux-bridge-autorestart/", import.meta.url);
const read = (name) => readFileSync(new URL(name, DIR), "utf8");
const script = read("tomverse-bridge-autorestart");
const service = read("tomverse-bridge-autorestart.service");
const timer = read("tomverse-bridge-autorestart.timer");
const rules = read("50-tomverse-bridge-autorestart.rules");
const install = read("install.sh");

const bash = resolveBashCommand();
const noBash = bash
  ? false
  : "no usable bash: git's installation has no bin/bash.exe or usr/bin/bash.exe, and PATH offers only the WSL launcher";

const MAIN = "tomverse-bridge.service";
const IMPL = "tomverse-amux-v22-bridge@claude-impl.service";
const REVIEW = "tomverse-amux-v22-bridge@claude-review.service";
const SIDECAR = "tomverse-amux-v22-sidecar@claude-impl.service";

const invocation = (n) => n.toString(16).padStart(32, "0");

/**
 * A halted run's journal, as the bridge prints it: the 2026-10-13 lines, with
 * the per-cause line every noted cause now leaves (note_halt in
 * apps/tomverse-orchestrator/src/wsl_bridge.rs).
 */
const noted = (cause) => `amux wsl bridge halt noted: cause=${cause}`;
const halt = (cause) =>
  `amux wsl bridge halted: no new assignments; cause=${cause}; restart only after checking Tomverse and the local AMUX`;
const tick = (committed, cls = "http_500") =>
  `amux wsl bridge warn: tick failed (${cls}) after ${committed} result(s) already committed this tick; recording them before halting`;
const HALT = {
  leaseLost: [
    "amux wsl bridge warn: owned queue answered 503 amux_database_busy; no new assignment this tick, not halted",
    noted("worker_runtime_lease_lost"),
    halt("worker_runtime_lease_lost"),
  ],
  tickNothingCommitted: [
    "amux v22 quota source unavailable for claude-impl",
    tick(0),
    noted("tick_failed_http_500"),
    halt("tick_failed_http_500"),
  ],
  tickCommitted: [tick(2), noted("tick_failed_http_500"), halt("tick_failed_http_500")],
  dispatchUnknown: [noted("dispatch_outcome_unknown"), halt("dispatch_outcome_unknown")],
  settleUnknown: [noted("settle_outcome_unknown"), halt("settle_outcome_unknown")],
  noCause: [
    "amux wsl bridge halted: no new assignments; restart only after checking Tomverse and the local AMUX",
  ],
  // A tick line that committed nothing, but the halt that followed was for
  // something else: the cause decides, not the presence of the tick line.
  tickThenDispatch: [tick(0), noted("dispatch_outcome_unknown"), halt("dispatch_outcome_unknown")],
  // Review r-20261013-231119-e051d6: the bridge keeps its first cause, and a
  // settlement that turns unknown after the halt adds lines of its own.
  leaseLostThenSettleUnknown: [
    noted("worker_runtime_lease_lost"),
    "amux wsl bridge halt: settle outcome unknown for attempt 7f9c2d10-1111-4222-8333-944455556666; read back before restart",
    noted("settle_outcome_unknown"),
    halt("worker_runtime_lease_lost"),
  ],
  // Review r-20261013-231443-7cfb6c: a read-only API attempt left open after
  // the halt prints nothing but its noted cause.
  leaseLostThenReadOnlyApiUnknown: [
    noted("worker_runtime_lease_lost"),
    noted("read_only_api_outcome_unknown"),
    halt("worker_runtime_lease_lost"),
  ],
  quotaRefusedBeforeLeaseLost: [
    "amux v22 quota observation refused for claude-impl",
    noted("worker_runtime_lease_lost"),
    halt("worker_runtime_lease_lost"),
  ],
  twoHalts: [noted("worker_runtime_lease_lost"), halt("worker_runtime_lease_lost"), halt("worker_runtime_lease_lost")],
  // A binary built before noted causes: its halt cannot say what else it noted.
  oldBinaryLeaseLost: [halt("worker_runtime_lease_lost")],
  // The halt line must name the first noted cause.
  haltDisagreesWithFirst: [
    tick(0),
    noted("tick_failed_http_500"),
    noted("worker_runtime_lease_lost"),
    halt("worker_runtime_lease_lost"),
  ],
  // Two approved causes, the second a tick that committed results.
  leaseLostThenCommittedTick: [
    noted("worker_runtime_lease_lost"),
    noted("tick_failed_http_500"),
    halt("worker_runtime_lease_lost"),
  ],
  // Every harmless line the bridges printed on 2026-10-10..13, then a halt.
  harmlessNoise: [
    "amux v22 quota source unavailable for claude-chore",
    "amux v22 quota observation recorded for claude-chore",
    "amux wsl bridge warn: owned queue answered 503 amux_database_busy; no new assignment this tick, not halted",
    "amux wsl bridge warn: worker register answered 503 amux_database_busy; registering again next tick",
    "amux wsl bridge warn: execution heartbeat for attempt 7f9c2d10-1111-4222-8333-944455556666 answered 503 amux_database_busy; kept, not halted",
    tick(0, "timeout"),
    noted("tick_failed_timeout"),
    halt("tick_failed_timeout"),
  ],
};

/**
 * `systemctl` as the host answers it. FAKE_UNITS holds `unit|state|status|id`
 * entries separated by spaces; `list-units` prints every v22 one, `show`
 * answers the three properties the script reads, and `restart` is logged and
 * answered with FAKE_RESTART_STATUS.
 */
const SYSTEMCTL_STUB = [
  "systemctl() {",
  '  if [ "$1" = list-units ]; then',
  '    for entry in $FAKE_UNITS; do unit=${entry%%|*}; [ "$unit" = tomverse-bridge.service ] || printf "%s loaded failed failed fake\\n" "$unit"; done',
  "    return 0",
  "  fi",
  '  if [ "$1" = show ]; then',
  '    prop=$3; unit=$5',
  // FAKE_FLIP_UNIT turns active, as if a person restarted it, after
  // FAKE_FLIP_AFTER reads of its properties.
  '    if [ "$unit" = "$FAKE_FLIP_UNIT" ]; then n=$(cat flip.count 2>/dev/null || echo 0); n=$((n + 1)); echo $n > flip.count; if [ $n -gt "$FAKE_FLIP_AFTER" ]; then case "$prop" in ActiveState) echo active ;; ExecMainStatus) echo 0 ;; InvocationID) echo ffffffffffffffffffffffffffffffff ;; esac; return 0; fi; fi',
  '    for entry in $FAKE_UNITS; do',
  '      IFS="|" read -r u state status id <<<"$entry"',
  '      [ "$u" = "$unit" ] || continue',
  '      case "$prop" in ActiveState) echo "$state" ;; ExecMainStatus) echo "$status" ;; InvocationID) echo "$id" ;; esac',
  "      return 0",
  "    done",
  '    case "$prop" in ActiveState) echo inactive ;; ExecMainStatus) echo 0 ;; InvocationID) echo ;; esac',
  "    return 0",
  "  fi",
  '  if [ "$1" = restart ]; then printf "%s\\n" "$*" >> restart.log; return "$FAKE_RESTART_STATUS"; fi',
  "  return 1",
  "}",
].join("\n");

const run = ({
  units,
  journals = {},
  amuxUp = true,
  appUp = true,
  restartStatus = 0,
  flip = null,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-autorestart-"));
  try {
    writeFileSync(join(dir, "autorestart"), script.replace(/\r\n/g, "\n"));
    for (const [id, lines] of Object.entries(journals)) {
      writeFileSync(join(dir, `journal-${id}.log`), `${lines.join("\n")}\n`);
    }
    const prelude = [
      SYSTEMCTL_STUB,
      'journalctl() { for arg in "$@"; do case "$arg" in _SYSTEMD_INVOCATION_ID=*) f="journal-${arg#*=}.log"; [ -f "$f" ] && cat "$f"; return 0 ;; esac; done; return 1; }',
      'curl() { printf "%s\\n" "$*" >> curl.log; case "$*" in *127.0.0.1*) return "$FAKE_AMUX_STATUS" ;; *) return "$FAKE_APP_STATUS" ;; esac; }',
      "export -f systemctl journalctl curl",
      "bash ./autorestart",
    ].join("\n");
    const result = spawnSync(bash, ["-c", prelude], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_UNITS: units.map((unit) => unit.join("|")).join(" "),
        FAKE_AMUX_STATUS: amuxUp ? "0" : "22",
        FAKE_APP_STATUS: appUp ? "0" : "22",
        FAKE_RESTART_STATUS: String(restartStatus),
        FAKE_FLIP_UNIT: flip?.unit ?? "",
        FAKE_FLIP_AFTER: String(flip?.after ?? 0),
      },
    });
    const lines = (name) =>
      existsSync(join(dir, name))
        ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)
        : [];
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      restarts: lines("restart.log").map((line) => line.split(" ").at(-1)),
      curls: lines("curl.log"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const halted = (unit, n) => [unit, "failed", "3", invocation(n)];
const active = (unit) => [unit, "active", "0", invocation(99)];

test("nothing halted: no health check, no restart, no output", { skip: noBash }, () => {
  const result = run({ units: [active(MAIN), active(IMPL)] });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.restarts, []);
  assert.deepEqual(result.curls, []);
  assert.equal(result.output, "");
});

test("a bridge halted with worker_runtime_lease_lost is restarted", { skip: noBash }, () => {
  const result = run({ units: [halted(MAIN, 1)], journals: { [invocation(1)]: HALT.leaseLost } });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.restarts, [MAIN]);
  assert.match(result.output, /tomverse-bridge\.service halted with cause=worker_runtime_lease_lost; restarted/);
});

test("a tick that failed after committing nothing is restarted", { skip: noBash }, () => {
  const result = run({
    units: [active(MAIN), halted(IMPL, 2)],
    journals: { [invocation(2)]: HALT.tickNothingCommitted },
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.restarts, [IMPL]);
  assert.match(result.output, /cause=tick_failed_http_500; restarted/);
});

test("a restart is asked for without waiting on the unit", { skip: noBash }, () => {
  const dir = run({ units: [halted(MAIN, 1)], journals: { [invocation(1)]: HALT.leaseLost } });
  assert.deepEqual(dir.restarts, [MAIN]);
  assert.match(script, /systemctl restart --no-block "\$unit"/);
});

test("every harmless line the bridges print still allows a restart", { skip: noBash }, () => {
  const result = run({ units: [halted(IMPL, 2)], journals: { [invocation(2)]: HALT.harmlessNoise } });
  assert.deepEqual(result.restarts, [IMPL], result.output);
});

for (const [name, lines, reason] of [
  ["a tick that had committed results", HALT.tickCommitted, /unrecognised line in the halted run: amux wsl bridge warn: tick failed \(http_500\) after 2 result/],
  ["dispatch_outcome_unknown", HALT.dispatchUnknown, /cause=dispatch_outcome_unknown was noted and is not restarted automatically/],
  ["settle_outcome_unknown", HALT.settleUnknown, /cause=settle_outcome_unknown was noted and is not restarted automatically/],
  ["an unknown read-only API outcome noted after an approved halt", HALT.leaseLostThenReadOnlyApiUnknown, /cause=read_only_api_outcome_unknown was noted and is not restarted automatically/],
  ["a halt from a binary that predates noted causes", HALT.oldBinaryLeaseLost, /no noted causes/],
  ["a halt line that does not name the first noted cause", HALT.haltDisagreesWithFirst, /names worker_runtime_lease_lost but the first noted cause is tick_failed_http_500/],
  ["a later tick_failed cause without a tick that committed nothing", HALT.leaseLostThenCommittedTick, /without a tick that committed nothing/],
  ["a halt line without a cause", HALT.noCause, /unrecognised line in the halted run: amux wsl bridge halted: no new assignments; restart only/],
  ["a nothing-committed tick followed by a different halt", HALT.tickThenDispatch, /cause=dispatch_outcome_unknown/],
  ["a settlement that turned unknown after an approved halt", HALT.leaseLostThenSettleUnknown, /unrecognised line in the halted run: amux wsl bridge halt: settle outcome unknown/],
  ["a line this script does not know", HALT.quotaRefusedBeforeLeaseLost, /unrecognised line in the halted run: amux v22 quota observation refused/],
  ["two halt lines in one run", HALT.twoHalts, /2 halt lines in the halted run/],
  ["an empty journal", [], /0 halt lines in the halted run/],
]) {
  test(`${name} stays halted`, { skip: noBash }, () => {
    const result = run({ units: [halted(REVIEW, 3)], journals: { [invocation(3)]: lines } });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.restarts, []);
    assert.match(result.output, reason);
    assert.match(result.output, /left halted/);
  });
}

test("a run whose invocation id cannot be read stays halted", { skip: noBash }, () => {
  const result = run({ units: [[MAIN, "failed", "3", ""]] });
  assert.deepEqual(result.restarts, []);
  assert.match(result.output, /no invocation id\), left halted/);
});

test("a unit that failed for any reason but a halt is left to systemd", { skip: noBash }, () => {
  // Exit 1 (for example a refused registration) is restarted by the unit's
  // own Restart=on-failure; a unit stopped by hand is inactive, not failed.
  const result = run({
    units: [[MAIN, "failed", "1", invocation(4)], [IMPL, "inactive", "0", invocation(5)]],
    journals: { [invocation(4)]: HALT.leaseLost, [invocation(5)]: HALT.leaseLost },
  });
  assert.deepEqual(result.restarts, []);
  assert.deepEqual(result.curls, []);
});

test("no restart while the local AMUX server does not answer", { skip: noBash }, () => {
  const result = run({
    units: [halted(MAIN, 1)],
    journals: { [invocation(1)]: HALT.leaseLost },
    amuxUp: false,
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.restarts, []);
  assert.match(result.output, /local AMUX server does not answer, no restart this run/);
});

test("no restart while the Tomverse app does not answer", { skip: noBash }, () => {
  const result = run({
    units: [halted(MAIN, 1)],
    journals: { [invocation(1)]: HALT.leaseLost },
    appUp: false,
  });
  assert.deepEqual(result.restarts, []);
  assert.match(result.output, /Tomverse app does not answer, no restart this run/);
});

test("each halted bridge is judged on its own", { skip: noBash }, () => {
  const result = run({
    units: [halted(MAIN, 1), halted(IMPL, 2), halted(REVIEW, 3), active(SIDECAR)],
    journals: {
      [invocation(1)]: HALT.leaseLost,
      [invocation(2)]: HALT.dispatchUnknown,
      [invocation(3)]: HALT.tickNothingCommitted,
    },
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.restarts, [MAIN, REVIEW]);
  assert.match(result.output, /claude-impl\.service halted; cause=dispatch_outcome_unknown/);
});

// Review r-20261013-231119-e051d6: a person restarted the unit while this run
// was checking it. The halted run it judged is gone; restarting now would
// interrupt the new one.
test("a unit that changed while it was being checked is left alone", { skip: noBash }, () => {
  // Three reads judge it halted (ActiveState, ExecMainStatus, InvocationID);
  // the fourth, right before the restart, sees it running again.
  const result = run({
    units: [halted(MAIN, 1)],
    journals: { [invocation(1)]: HALT.leaseLost },
    flip: { unit: MAIN, after: 3 },
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.restarts, []);
  assert.match(result.output, /tomverse-bridge\.service changed while it was being checked; left alone/);
});

test("a refused restart is reported and the run goes on", { skip: noBash }, () => {
  const result = run({
    units: [halted(MAIN, 1), halted(IMPL, 2)],
    journals: { [invocation(1)]: HALT.leaseLost, [invocation(2)]: HALT.leaseLost },
    restartStatus: 1,
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.restarts, [MAIN, IMPL]);
  assert.equal(result.output.match(/the restart was refused/g)?.length, 2);
});

test("the health checks are fixed addresses, https only for the app", () => {
  assert.match(script, /^amux_health=https:\/\/127\.0\.0\.1:8824\/health$/m);
  assert.match(script, /^app_health=https:\/\/tomverse\.app\/api\/health$/m);
  assert.match(script, /answers --proto '=https' "\$app_health"/);
  assert.doesNotMatch(script, /\$\{TOMVERSE_/, "no environment override of the addresses");
});

test("the approved causes are the only ones restarted", () => {
  // The decision is one function; its restart branches are exactly the two
  // causes the operator approved on 2026-10-14.
  const decide = script.slice(script.indexOf("decide() {"), script.indexOf("answers() {"));
  const approvedFn = script.slice(script.indexOf("approved() {"), script.indexOf("decide() {"));
  assert.match(approvedFn, /\[\[ "\$1" == worker_runtime_lease_lost \|\| "\$1" == tick_failed_\* \]\]/);
  assert.equal(decide.match(/echo restart/g)?.length, 1);
  assert.match(script, /after 0 result\\\(s\\\) already committed this tick; recording them before halting\$'/);
});

test("the restart re-reads the unit right before it", () => {
  const loop = script.slice(script.indexOf('for unit in "${halted[@]}"; do'));
  const reread = loop.indexOf('"$(halted_run "$unit")" != "failed 3 $invocation"');
  const restart = loop.indexOf('systemctl restart --no-block "$unit"');
  assert.ok(reread > 0 && reread < restart);
});

// The polkit rule, run as polkitd would run it.
const polkitDecision = (user, unit, verb, actionId = "org.freedesktop.systemd1.manage-units") => {
  let rule;
  const polkit = { Result: { YES: "yes" }, addRule: (fn) => { rule = fn; } };
  vm.runInNewContext(rules, { polkit });
  const details = { unit, verb };
  return rule({ id: actionId, lookup: (key) => details[key] }, { user }) ?? "no answer";
};

test("polkit lets the account restart the bridge units", () => {
  for (const unit of [MAIN, IMPL, REVIEW, "tomverse-amux-v22-bridge@codex-x.1.service"]) {
    assert.equal(polkitDecision("tomverse-bridge-autorestart", unit, "restart"), "yes", unit);
  }
});

test("polkit grants nothing else", () => {
  const user = "tomverse-bridge-autorestart";
  for (const verb of ["start", "stop", "reload", "reload-or-restart", "try-restart"]) {
    assert.equal(polkitDecision(user, MAIN, verb), "no answer", verb);
  }
  for (const unit of [SIDECAR, "ssh.service", "tomverse-bridge-watchdog.service",
    "tomverse-amux-v22-bridge@x.service.d", "xtomverse-bridge.service",
    "tomverse-amux-v22-bridge@a/b.service", undefined]) {
    assert.equal(polkitDecision(user, unit, "restart"), "no answer", String(unit));
  }
  assert.equal(polkitDecision("tommy", MAIN, "restart"), "no answer");
  assert.equal(polkitDecision("tomverse-bridge-watchdog", MAIN, "restart"), "no answer");
  assert.equal(
    polkitDecision(user, MAIN, "restart", "org.freedesktop.systemd1.manage-unit-files"),
    "no answer"
  );
});

test("the service runs as its own account with journal read access and no credential", () => {
  assert.match(service, /^User=tomverse-bridge-autorestart$/m);
  assert.match(service, /^Group=tomverse-bridge-autorestart$/m);
  assert.match(service, /^SupplementaryGroups=systemd-journal$/m);
  assert.match(service, /^NoNewPrivileges=yes$/m);
  assert.match(service, /^CapabilityBoundingSet=$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.doesNotMatch(service, /^(DynamicUser|LoadCredential)=/m);
  assert.match(timer, /^OnCalendar=\*:0\/2$/m);
});

test("the installer proves the rule's reach before it enables the timer", () => {
  const enable = install.indexOf("systemctl enable --now tomverse-bridge-autorestart.timer");
  for (const check of [
    "allowed tomverse-bridge.service restart ||",
    "allowed tomverse-amux-v22-bridge@claude-impl.service restart ||",
    "if allowed tomverse-bridge.service stop; then",
    "if allowed ssh.service restart; then",
    "if allowed tomverse-amux-v22-sidecar@claude-impl.service restart; then",
  ]) {
    const at = install.indexOf(check);
    assert.ok(at > 0 && at < enable, check);
  }
  assert.match(install, /test "\$\(stat -c %U "\$src"\)" != tommy/);
  // Review r-20261013-231119-e051d6: an explicit failure exits through fail(),
  // which the ERR trap never sees. The timer goes off before the first change
  // and fail() turns it off from then on.
  const changing = install.indexOf("\nchanging=yes\ntimer_off\n");
  assert.ok(changing > 0 && changing < install.indexOf("useradd"), "timer off before any change");
  assert.match(install, /fail\(\) \{\n {2}\[\[ "\$changing" == yes \]\] && timer_off/);
  assert.match(install, /\/etc\/polkit-1\/rules\.d\/50-tomverse-bridge-autorestart\.rules/);
});

test("the installer is valid bash", { skip: noBash }, () => {
  for (const [name, text] of [["install.sh", install], ["autorestart", script]]) {
    const dir = mkdtempSync(join(tmpdir(), "bridge-autorestart-syntax-"));
    try {
      writeFileSync(join(dir, name), text.replace(/\r\n/g, "\n"));
      const result = spawnSync(bash, ["-n", name], { cwd: dir, encoding: "utf8" });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
