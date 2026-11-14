/**
 * The AMUX Decision Maker relay auto-restart: which halted relay runs one run
 * restarts, which it leaves halted, and that its polkit rule grants restart of
 * the relay unit and nothing else.
 *
 * docs/ops/amux/bridge-monitoring.md §6 is the runbook. The script runs on the
 * Ubuntu host under systemd; here it runs under bash with `systemctl`,
 * `journalctl` and `curl` replaced by exported shell functions, as the bridge
 * auto-restart's test does. The halt lines are the relay's own, read from
 * apps/tomverse-orchestrator/src/dm_relay/io.rs below.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { resolveBashCommand } from "./support/gitBash.mjs";

const DIR = new URL("../scripts/amux-dm-relay-autorestart/", import.meta.url);
const read = (name) => readFileSync(new URL(name, DIR), "utf8");
const script = read("tomverse-dm-relay-autorestart");
const service = read("tomverse-dm-relay-autorestart.service");
const timer = read("tomverse-dm-relay-autorestart.timer");
const rules = read("50-tomverse-dm-relay-autorestart.rules");
const install = read("install.sh");
const relayIo = readFileSync(
  new URL("../apps/tomverse-orchestrator/src/dm_relay/io.rs", import.meta.url),
  "utf8"
);
const relayUnit = readFileSync(
  new URL("../scripts/systemd/tomverse-amux-dm-relay.service", import.meta.url),
  "utf8"
);

const bash = resolveBashCommand();
const noBash = bash
  ? false
  : "no usable bash: git's installation has no bin/bash.exe or usr/bin/bash.exe, and PATH offers only the WSL launcher";

const RELAY = "tomverse-amux-dm-relay.service";
const INVOCATION = "0123456789abcdef0123456789abcdef";

// The relay's halt lines, in the two wordings io.rs prints.
const deliveryHalt = (cause) =>
  `amux dm relay halt: ${cause}; nothing more is delivered or relayed until the bridge restarts. Read the request in Admin first.`;
const questionHalt = (cause) =>
  `amux dm relay halt: ${cause}; no new question is relayed until the bridge restarts. Read the request in Admin first.`;
const BEFORE = [
  "amux dm relay started",
  "amux dm relay: card AMUX-12 revision 3: dm_result_recorded",
  "amux dm relay: direct answers: 1 reported, 1 closed, 0 passed: direct_answers_reported",
  "amux dm relay: delivery for card AMUX-9 revision 2: delivery_unknown_paused",
];
const V22 = "amux dm relay: v22 questions: resolved false, filed 1, closed 0";

/**
 * `systemctl show` answers the relay's ActiveState, SubState and InvocationID
 * from FAKE_STATE / FAKE_SUB / FAKE_ID, ActiveEnterTimestampMonotonic from
 * FAKE_ENTERED and LoadState from FAKE_LOAD; after FAKE_FLIP_AFTER reads the run
 * changes, as if a person restarted it. `restart` is logged and answered with
 * FAKE_RESTART_STATUS. `journalctl` answers the invocation's lines from
 * relay.log and this unit's own last hour from self.log; FAKE_JOURNAL_FAIL
 * names which one fails.
 */
const STUBS = [
  "systemctl() {",
  '  if [ "$1" = show ]; then',
  '    prop=$3',
  '    n=$(cat show.count 2>/dev/null || echo 0); n=$((n + 1)); echo $n > show.count',
  '    if [ "$FAKE_FLIP_AFTER" -gt 0 ] && [ $n -gt "$FAKE_FLIP_AFTER" ]; then case "$prop" in ActiveState) echo active ;; SubState) echo running ;; ActiveEnterTimestampMonotonic) echo 999 ;; InvocationID) echo ffffffffffffffffffffffffffffffff ;; LoadState) echo loaded ;; esac; return 0; fi',
  '    case "$prop" in ActiveState) echo "$FAKE_STATE" ;; SubState) echo "$FAKE_SUB" ;; ActiveEnterTimestampMonotonic) echo "$FAKE_ENTERED" ;; InvocationID) echo "$FAKE_ID" ;; LoadState) echo "$FAKE_LOAD" ;; esac',
  "    return 0",
  "  fi",
  '  if [ "$1" = restart ]; then printf "%s\\n" "$*" >> restart.log; return "$FAKE_RESTART_STATUS"; fi',
  "  return 1",
  "}",
  "journalctl() {",
  '  printf "%s\\n" "$*" >> journal-args.log',
  '  for arg in "$@"; do case "$arg" in',
  '    _SYSTEMD_INVOCATION_ID=*) [ "$FAKE_JOURNAL_FAIL" = relay ] && return 1; [ "${arg#*=}" = "$FAKE_ID" ] && cat relay.log; return 0 ;;',
  '    -u) [ "$FAKE_JOURNAL_FAIL" = self ] && return 1; cat self.log; return 0 ;;',
  "  esac; done",
  "  return 1",
  "}",
  'curl() { printf "%s\\n" "$*" >> curl.log; case "$*" in *127.0.0.1*) return "$FAKE_AMUX_STATUS" ;; *) return "$FAKE_APP_STATUS" ;; esac; }',
  "export -f systemctl journalctl curl",
].join("\n");

const run = ({
  lines,
  state = "active",
  sub = "running",
  id = INVOCATION,
  selfLines = [],
  amuxUp = true,
  appUp = true,
  restartStatus = 0,
  flipAfter = 0,
  entered = "52310449",
  load = "loaded",
  journalFail = "",
}) => {
  const dir = mkdtempSync(join(tmpdir(), "dm-relay-autorestart-"));
  try {
    writeFileSync(join(dir, "autorestart"), script.replace(/\r\n/g, "\n"));
    writeFileSync(join(dir, "relay.log"), lines.length ? `${lines.join("\n")}\n` : "");
    writeFileSync(join(dir, "self.log"), selfLines.length ? `${selfLines.join("\n")}\n` : "");
    const result = spawnSync(bash, ["-c", `${STUBS}\nbash ./autorestart`], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_STATE: state,
        FAKE_SUB: sub,
        FAKE_ID: id,
        FAKE_AMUX_STATUS: amuxUp ? "0" : "22",
        FAKE_APP_STATUS: appUp ? "0" : "22",
        FAKE_RESTART_STATUS: String(restartStatus),
        FAKE_FLIP_AFTER: String(flipAfter),
        FAKE_ENTERED: entered,
        FAKE_LOAD: load,
        FAKE_JOURNAL_FAIL: journalFail,
      },
    });
    const logged = (name) =>
      existsSync(join(dir, name))
        ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)
        : [];
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      restarts: logged("restart.log"),
      curls: logged("curl.log"),
      journalArgs: logged("journal-args.log"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a running relay that never halted: no health check, no restart, no output", { skip: noBash }, () => {
  const result = run({ lines: [...BEFORE, V22] });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.restarts, []);
  assert.deepEqual(result.curls, []);
  assert.equal(result.output, "");
});

for (const cause of ["unsettled_read_unreadable", "delivery_read_unreadable"]) {
  test(`a relay halted with ${cause} is restarted`, { skip: noBash }, () => {
    const result = run({ lines: [...BEFORE, deliveryHalt(cause), V22] });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.restarts, [`restart --no-block ${RELAY}`]);
    assert.match(result.output, new RegExp(`halted with cause=${cause}; restarted$`, "m"));
  });
}

// Every other cause is a write whose answer was lost, refused or unreadable:
// a person reads the request in Admin first.
const HELD = [
  "assignment_discard_record_refused",
  "assignment_discard_outcome_unknown",
  "assignment_answer_unreadable",
  "assignment_outcome_unknown",
  "transmit_intent_answer_unreadable",
  "transmit_intent_outcome_unknown",
  "cleanup_unknown_report_unconfirmed",
  "transmit_outcome_record_refused",
  "transmit_outcome_unknown",
  "result_unknown_record_refused",
  "result_unknown_outcome_unknown",
  "delivery_decision_outcome_unknown",
  "delivery_unknown_pause_unconfirmed",
  "delivery_not_sent_record_refused",
  "delivery_not_sent_outcome_unknown",
  "delivery_card_record_failed",
  "delivery_recovered_card_record_unconfirmed",
];

test("every halt cause the relay prints is either restarted or held here", () => {
  const source = ["flow.rs", "delivery.rs"]
    .map((name) =>
      readFileSync(
        new URL(`../apps/tomverse-orchestrator/src/dm_relay/${name}`, import.meta.url),
        "utf8"
      ).split("#[cfg(test)]")[0]
    )
    .join("\n");
  const causes = new Set(
    [...source.matchAll(/\.(?:halted|missing)\("([a-z0-9_]+)"\)|halt = Some\("([a-z0-9_]+)"\)/g)].map(
      (match) => match[1] ?? match[2]
    )
  );
  assert.deepEqual(
    [...causes].sort(),
    [...HELD, "unsettled_read_unreadable", "delivery_read_unreadable"].sort(),
    "a new halt cause needs a decision in this script and in the runbook"
  );
});

for (const cause of HELD) {
  test(`a relay halted with ${cause} stays halted`, { skip: noBash }, () => {
    const result = run({ lines: [...BEFORE, questionHalt(cause)] });
    assert.deepEqual(result.restarts, []);
    assert.deepEqual(result.curls, []);
    assert.match(result.output, new RegExp(`cause=${cause} is not restarted automatically, left halted`));
  });
}

test("the halt lines above are the ones the relay prints", () => {
  const printed = [...relayIo.split("#[cfg(test)]")[0].matchAll(/"amux dm relay halt: \{cause\}; ([^"]+)"/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(printed.sort(), [
    "no new question is relayed until the bridge restarts. Read the request in Admin first.",
    "nothing more is delivered or relayed until the bridge restarts. Read the request in Admin first.",
    "nothing more is delivered or relayed until the bridge restarts. Read the request in Admin first.",
  ]);
  assert.match(relayIo, /"amux dm relay: v22 questions: resolved \{\}, filed \{\}, closed \{\}"/);
  const v22 = readFileSync(
    new URL("../apps/tomverse-orchestrator/src/dm_relay/v22_question.rs", import.meta.url),
    "utf8"
  );
  assert.match(v22, /pub resolved: bool,/, "resolved prints as true or false");
});

test("a line after the halt that is not the v22 summary holds the restart", { skip: noBash }, () => {
  const result = run({
    lines: [deliveryHalt("delivery_read_unreadable"), "amux dm relay: card AMUX-3 revision 1: dm_result_recorded"],
  });
  assert.deepEqual(result.restarts, []);
  assert.match(result.output, /an unrecognised line after the halt/);
});

test("two halt lines in one run hold the restart", { skip: noBash }, () => {
  const result = run({
    lines: [deliveryHalt("delivery_read_unreadable"), deliveryHalt("delivery_read_unreadable")],
  });
  assert.deepEqual(result.restarts, []);
  assert.match(result.output, /2 halt lines in one run/);
});

test("a second halt within an hour of a restart stays halted", { skip: noBash }, () => {
  const result = run({
    lines: [deliveryHalt("delivery_read_unreadable")],
    selfLines: [
      `tomverse-dm-relay-autorestart: ${RELAY} halted with cause=delivery_read_unreadable; restarted`,
    ],
  });
  assert.deepEqual(result.restarts, []);
  assert.deepEqual(result.curls, []);
  assert.match(result.output, /again within an hour of a restart; left as it is/);
  assert.ok(
    result.journalArgs.some((args) => args.includes("-u tomverse-dm-relay-autorestart.service --since=-60min")),
    result.journalArgs.join("\n")
  );
});

test("a refused restart in the last hour does not count as one", { skip: noBash }, () => {
  const result = run({
    lines: [deliveryHalt("delivery_read_unreadable")],
    selfLines: [
      `tomverse-dm-relay-autorestart: ${RELAY} halted with cause=delivery_read_unreadable; the restart was refused`,
    ],
  });
  assert.deepEqual(result.restarts, [`restart --no-block ${RELAY}`]);
});

test("an unreadable journal restarts nothing", { skip: noBash }, () => {
  for (const journalFail of ["relay", "self"]) {
    const result = run({ lines: [deliveryHalt("delivery_read_unreadable")], journalFail });
    assert.deepEqual(result.restarts, [], journalFail);
    assert.match(result.output, /journal is unreadable/, journalFail);
  }
});

test("a relay that is not running is left to systemd and the person", { skip: noBash }, () => {
  for (const [state, sub] of [
    ["failed", "failed"],
    ["inactive", "dead"],
    ["activating", "auto-restart"],
    ["active", "exited"],
  ]) {
    const result = run({ lines: [deliveryHalt("delivery_read_unreadable")], state, sub });
    assert.deepEqual(result.restarts, [], `${state} ${sub}`);
    assert.equal(result.output, "", `${state} ${sub}`);
  }
});

test("a run whose invocation id cannot be read is left alone", { skip: noBash }, () => {
  const result = run({ lines: [deliveryHalt("delivery_read_unreadable")], id: "" });
  assert.deepEqual(result.restarts, []);
  assert.match(result.output, /no invocation id/);
});

test("no restart while the local AMUX server or the app does not answer", { skip: noBash }, () => {
  const amuxDown = run({ lines: [deliveryHalt("delivery_read_unreadable")], amuxUp: false });
  assert.deepEqual(amuxDown.restarts, []);
  assert.match(amuxDown.output, /the local AMUX server does not answer/);
  const appDown = run({ lines: [deliveryHalt("delivery_read_unreadable")], appUp: false });
  assert.deepEqual(appDown.restarts, []);
  assert.match(appDown.output, /the Tomverse app does not answer/);
});

test("a unit that changed while it was being checked is left alone", { skip: noBash }, () => {
  const result = run({ lines: [deliveryHalt("delivery_read_unreadable")], flipAfter: 4 });
  assert.deepEqual(result.restarts, []);
  assert.match(result.output, /changed while it was being checked; left alone/);
});

test("a refused restart is reported", { skip: noBash }, () => {
  const result = run({ lines: [deliveryHalt("delivery_read_unreadable")], restartStatus: 1 });
  assert.match(result.output, /the restart was refused/);
});

test("the health checks are fixed addresses, https only for the app", () => {
  assert.match(script, /^amux_health=https:\/\/127\.0\.0\.1:8824\/health$/m);
  assert.match(script, /^app_health=https:\/\/tomverse\.app\/api\/health$/m);
  assert.match(script, /answers --proto '=https' "\$app_health"/);
  assert.match(relayUnit, /https:\/\/127\.0\.0\.1:8824\/health/, "the same check the relay unit starts with");
});

test("exit 2 stays the relay unit's to hold", () => {
  assert.match(relayUnit, /^Restart=on-failure$/m);
  assert.match(relayUnit, /^RestartPreventExitStatus=2$/m);
  assert.doesNotMatch(script, /ExecMainStatus/, "an exited relay is never judged here");
});

// The polkit rule, evaluated as polkitd would: the account may restart the
// relay unit and do nothing else.
const decide = (user, unit, verb) => {
  let rule;
  vm.runInNewContext(rules, {
    polkit: { addRule: (fn) => (rule = fn), Result: { YES: "yes" } },
  });
  const action = {
    id: "org.freedesktop.systemd1.manage-units",
    lookup: (key) => ({ unit, verb })[key],
  };
  return rule(action, { user }) ?? "not handled";
};

test("polkit lets the account restart the relay unit", () => {
  assert.equal(decide("tomverse-dm-relay-autorestart", RELAY, "restart"), "yes");
});

test("polkit grants nothing else", () => {
  for (const [user, unit, verb] of [
    ["tomverse-dm-relay-autorestart", RELAY, "stop"],
    ["tomverse-dm-relay-autorestart", RELAY, "start"],
    ["tomverse-dm-relay-autorestart", RELAY, "reload-or-restart"],
    ["tomverse-dm-relay-autorestart", "tomverse-amux-bridge@codex-impl.service", "restart"],
    ["tomverse-dm-relay-autorestart", "amux-dm-broker.service", "restart"],
    ["tomverse-dm-relay-autorestart", "ssh.service", "restart"],
    ["tomverse-bridge-autorestart", RELAY, "restart"],
    ["tommy", RELAY, "restart"],
  ]) {
    assert.equal(decide(user, unit, verb), "not handled", `${user} ${verb} ${unit}`);
  }
});

test("the service runs as its own account with journal read access and no credential", () => {
  assert.match(service, /^User=tomverse-dm-relay-autorestart$/m);
  assert.match(service, /^Group=tomverse-dm-relay-autorestart$/m);
  assert.match(service, /^SupplementaryGroups=systemd-journal$/m);
  assert.match(service, /^ExecStart=\/usr\/local\/libexec\/tomverse-dm-relay-autorestart$/m);
  assert.doesNotMatch(service, /^(LoadCredential|EnvironmentFile|DynamicUser)=/m);
  assert.match(timer, /^OnCalendar=\*:0\/2$/m);
});

test("the installer proves the rule's reach before it enables the timer", () => {
  const granted = [...install.matchAll(/^granted (\S+) (\S+)$/gm)].map((m) => `${m[2]} ${m[1]}`);
  const refused = [...install.matchAll(/^refused (\S+) (\S+)$/gm)].map((m) => `${m[2]} ${m[1]}`);
  assert.deepEqual(granted, [`restart ${RELAY}`]);
  assert.ok(refused.includes(`stop ${RELAY}`) && refused.includes(`start ${RELAY}`));
  assert.ok(refused.includes("restart tomverse-amux-bridge@codex-impl.service"));
  assert.ok(install.indexOf("refused ssh.service restart") < install.indexOf("enable --now"));
  assert.match(install, /stat -c %U "\$src"\)" != tommy/);
});

test("the installer is valid bash", { skip: noBash }, () => {
  for (const [name, text] of [["install.sh", install], ["script", script]]) {
    const result = spawnSync(bash, ["-n"], { input: text.replace(/\r\n/g, "\n"), encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

// 2026-11-09: a reboot left the then-static relay unit inactive (dead) with no
// halt or exit line. A relay that has not been active once since this boot is
// started; one a person stopped has been active and is left alone.
test("a relay never started since boot is started", { skip: noBash }, () => {
  const result = run({ lines: [], state: "inactive", sub: "dead", entered: "0", id: "" });
  assert.deepEqual(result.restarts, [`restart --no-block ${RELAY}`]);
  assert.match(result.output, /was not started since boot with cause=not_started_since_boot; restarted$/m);
  assert.equal(result.curls.length, 2, "both health checks first");
});

test("a relay a person stopped this boot is left alone", { skip: noBash }, () => {
  const result = run({ lines: ["amux dm relay started"], state: "inactive", sub: "dead", entered: "52310449" });
  assert.deepEqual(result.restarts, []);
  assert.equal(result.output, "");
});

test("a relay unit that is not installed is never started", { skip: noBash }, () => {
  const result = run({ lines: [], state: "inactive", sub: "dead", entered: "0", id: "", load: "not-found" });
  assert.deepEqual(result.restarts, []);
  assert.deepEqual(result.curls, []);
});

test("a relay not started since boot keeps the hourly bound and the health checks", { skip: noBash }, () => {
  const bounded = run({
    lines: [], state: "inactive", sub: "dead", entered: "0", id: "",
    selfLines: [`tomverse-dm-relay-autorestart: ${RELAY} was not started since boot with cause=not_started_since_boot; restarted`],
  });
  assert.deepEqual(bounded.restarts, []);
  assert.match(bounded.output, /again within an hour of a restart/);
  const down = run({ lines: [], state: "inactive", sub: "dead", entered: "0", id: "", amuxUp: false });
  assert.deepEqual(down.restarts, []);
  assert.match(down.output, /the local AMUX server does not answer/);
});

test("a relay started by a person while it was being checked is left alone", { skip: noBash }, () => {
  const result = run({ lines: [], state: "inactive", sub: "dead", entered: "0", id: "", flipAfter: 4 });
  assert.deepEqual(result.restarts, []);
  assert.match(result.output, /changed while it was being checked; left alone/);
});
