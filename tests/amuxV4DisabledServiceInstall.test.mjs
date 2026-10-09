import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("installation never enables/starts a timer or replaces an existing target", () => {
  const script = read("scripts/install-amux-v4-disabled-services.sh");
  assert.doesNotMatch(script, /systemctl\s+[^\n]*(?:\benable\b|\bstart\b|\brestart\b)/);
  assert.match(script, /systemctl --user is-enabled/);
  assert.match(script, /systemctl --user is-active/);
  assert.match(script, /test ! -e "\$lib\/\$file"/);
  assert.match(script, /test ! -e "\$units\/\$file"/);
  assert.match(script, /if test ! -e "\$config\/\$name.env"/);
  assert.match(script, /case "\$src" in \/home\/tommy\/amux-v4-install/);
  const environmentCheck = script.indexOf('test -f "$src/amux-v4-$name.env.example"');
  assert.ok(environmentCheck > 0);
  assert.ok(environmentCheck < script.indexOf("install -d"));
});

test("the two installed environment examples are disabled and contain no credentials", () => {
  const analysis = read("scripts/systemd/amux-v4-analysis-agent.env.example");
  const retention = read("scripts/systemd/amux-v4-content-retention.env.example");
  assert.match(analysis, /^TOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI=disabled$/m);
  assert.match(retention, /^TOMVERSE_AMUX_V4_LOCAL_RETENTION=disabled$/m);
  for (const source of [analysis, retention]) {
    const live = source.split(/\r?\n/).filter(line => !line.startsWith("#")).join("\n");
    assert.doesNotMatch(live, /DATABASE_URL|(?:API_KEY|SECRET|KEY_B64)=/);
  }
});
