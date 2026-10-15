import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { liveSwitchOf, SYSTEM_TIMER_SHA256 } from "../scripts/enable-amux-v4-analysis-timer.mjs";

const timer = readFileSync(new URL("../scripts/systemd/amux-v4-analysis-agent-system.timer", import.meta.url), "utf8");
const script = readFileSync(new URL("../scripts/enable-amux-v4-analysis-timer.mjs", import.meta.url), "utf8");

test("the system timer drives only the system service, waits for each run and never catches up", () => {
  assert.equal(createHash("sha256").update(timer).digest("hex"), SYSTEM_TIMER_SHA256);
  assert.match(timer, /^Unit=amux-v4-analysis-agent-system\.service$/m);
  assert.match(timer, /^OnUnitInactiveSec=60s$/m);
  assert.match(timer, /^Persistent=false$/m);
  assert.doesNotMatch(timer, /^OnUnitActiveSec=|^OnCalendar=/m);
});

test("enabling is root-only, pinned, explicit, and never touches the halt, the service or credentials", () => {
  assert.match(script, /process\.getuid\(\) !== 0/);
  assert.match(script, /"--probe-only", "--enable"/);
  assert.match(script, /service_mismatch/);
  assert.match(script, /flag: "wx"/);
  assert.match(script, /"enable", "--now", SYSTEM_TIMER/);
  assert.doesNotMatch(script, /unlink|rmSync|"start"|"restart"|"reset-failed"|writeFileSync\(ENVIRONMENT_FILE|writeFileSync\(ANALYSIS_HALT_MARKER/);
  assert.doesNotMatch(script, /console\.(?:log|error)\(error/);
});

test("the live switch is reported as a word, never the environment line", () => {
  assert.equal(liveSwitchOf("TOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI=enabled\nSECRET=x\n"), "enabled");
  assert.equal(liveSwitchOf("TOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI=disabled\n"), "disabled");
  assert.equal(liveSwitchOf("TOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI=on\n"), "invalid");
  assert.equal(liveSwitchOf(""), "invalid");
  assert.equal(liveSwitchOf("TOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI=enabled\nTOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI=enabled\n"), "invalid");
});
