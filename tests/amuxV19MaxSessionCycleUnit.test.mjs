import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the v19 cycle unit refreshes mirrors before any claim and installs switched off", () => {
  const service = read("scripts/systemd/amux-v19-max-session-cycle.service");
  const timer = read("scripts/systemd/amux-v19-max-session-cycle.timer");
  const env = read("scripts/systemd/amux-v19-max-session-cycle.env.example");
  const refresh = read("scripts/amux-v19-refresh-tracked-mirrors.sh");
  // ExecStartPre failure prevents ExecStart, so a stale mirror never claims.
  assert.ok(service.indexOf("ExecStartPre=") < service.indexOf("ExecStart=/usr/bin/node"));
  assert.match(service, /refresh-tracked-mirrors\.sh/);
  assert.match(service, /max-session-cycle\.mjs/);
  assert.match(service, /^Type=oneshot$/m);
  assert.match(timer, /^Unit=amux-v19-max-session-cycle\.service$/m);
  assert.match(env, /^TOMVERSE_AMUX_V19_MAX_SESSION_CYCLE=disabled$/m);
  assert.match(env, /^TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI=disabled$/m);
  assert.match(env, /^# TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET=$/m,
    "no secret value is ever committed");
  assert.doesNotMatch(env, /DATABASE_URL=|API_KEY=/);
  // The local-only diagnostic detail switch ships commented out (off).
  assert.match(env, /^# TOMVERSE_AMUX_V19_DIAGNOSTIC_DETAIL=enabled$/m);
  assert.doesNotMatch(env, /^TOMVERSE_AMUX_V19_DIAGNOSTIC_DETAIL=/m);
  assert.match(refresh, /^set -euo pipefail$/m);
  assert.match(refresh, /fetch --quiet --prune --no-tags origin/);
  // The app pins develop where it exists, so the mirror fetches it then; a
  // remote without develop (ls-remote exit 2) is not a failure.
  assert.match(refresh, /ls-remote --exit-code --heads origin refs\/heads\/develop/);
  assert.match(refresh, /"\+refs\/heads\/develop:refs\/remotes\/origin\/develop"/);
  assert.match(refresh, /test "\$status" -eq 2 \|\| exit "\$status"/);
  assert.doesNotMatch(refresh, /\b(?:checkout|reset|clean|pull)\b/,
    "the refresh never touches a working tree");
});
