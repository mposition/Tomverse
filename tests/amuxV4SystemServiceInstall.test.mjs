import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BWRAP_PROBE_ARGS, disabledSystemEnvironment, SYSTEM_PROBE_PROPERTIES,
  SYSTEM_UNIT_SHA256 } from
  "../scripts/install-amux-v4-system-service.mjs";

const script = readFileSync(new URL("../scripts/install-amux-v4-system-service.mjs", import.meta.url), "utf8");
const unit = readFileSync(new URL("../scripts/systemd/amux-v4-analysis-agent-system.service", import.meta.url), "utf8");
const environment = "TOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI=enabled\n" +
  "TOMVERSE_AMUX_V4_ANALYSIS_APP_ORIGIN=https://tomverse.app\n" +
  `TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET=${"x".repeat(64)}\n`;

test("system manager runs both fixed probe and analysis as tommy with existing isolation", () => {
  assert.equal(createHash("sha256").update(unit).digest("hex"), SYSTEM_UNIT_SHA256);
  for (const line of ["User=tommy", "Group=tommy", "NoNewPrivileges=true",
    "PrivateTmp=true", "ProtectSystem=strict", "ProtectHome=read-only",
    "TimeoutStartSec=650s", "KillMode=control-group", "UMask=0077"]) {
    assert.ok(unit.split("\n").includes(line));
  }
  assert.match(unit, /ConditionPathExists=!.*analysis-outcome-unknown\.halt/);
  assert.match(unit, /ExecStartPre=\/usr\/bin\/bwrap .*--clearenv .*\/usr\/bin\/true/);
  assert.doesNotMatch(unit, /%h|Restart=|\[Install\]|OnUnit|User=root/);
  assert.ok(SYSTEM_PROBE_PROPERTIES.includes("User=tommy"));
  assert.ok(SYSTEM_PROBE_PROPERTIES.includes("ProtectSystem=strict"));
  assert.ok(SYSTEM_PROBE_PROPERTIES.includes("ProtectHome=read-only"));
  assert.equal(BWRAP_PROBE_ARGS.at(-1), "/usr/bin/true");
  assert.ok(BWRAP_PROBE_ARGS.includes("--unshare-all"));
});

test("root environment copy forces the live switch off without adding credentials", () => {
  const output = disabledSystemEnvironment(environment);
  assert.match(output, /^TOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI=disabled$/m);
  assert.match(output, /TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET=x{64}/);
  assert.equal(output.split("\n").filter(Boolean).length, 3);
});

for (const [name, input] of [
  ["duplicate gate", environment + "TOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI=enabled\n"],
  ["Node preload", environment + "NODE_OPTIONS=--import=/tmp/untrusted.mjs\n"],
  ["product credential", environment + "DATABASE_URL=postgresql://synthetic\n"],
  ["provider key", environment + "ANTHROPIC_API_KEY=synthetic\n"],
  ["wrong origin", environment.replace("https://tomverse.app", "https://invalid.example")],
  ["escaped environment", environment.replace("x".repeat(64), '"a\\nNODE_OPTIONS=bad"')],
]) test(`installer refuses ${name}`, () => {
  assert.throws(() => disabledSystemEnvironment(input));
});

test("installation is bounded, root-owned, fail-closed and does not start a model or retry", () => {
  assert.match(script, /process\.getuid\(\) !== 0/);
  assert.match(script, /bundle_mismatch/);
  assert.match(script, /flag: "wx"/);
  assert.match(script, /modelCalled: false/);
  assert.match(script, /--probe-only/);
  assert.doesNotMatch(script, /"(?:start|enable|restart|reset-failed)"|unlink|rmSync|sysctl|apparmor_parser/);
  assert.ok(script.indexOf('"/usr/bin/systemd-run"') < script.indexOf('writeFileSync(targets[0]'));
  assert.doesNotMatch(script, /console\.(?:log|error)\(error/);
});
