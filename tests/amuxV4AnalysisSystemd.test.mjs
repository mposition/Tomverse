import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const service = readFileSync(new URL("../scripts/systemd/amux-v4-analysis-agent.service",
  import.meta.url), "utf8");
const timer = readFileSync(new URL("../scripts/systemd/amux-v4-analysis-agent.timer",
  import.meta.url), "utf8");

test("local analysis uses a bounded one-shot without a product DB credential", () => {
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^TimeoutStartSec=650s$/m);
  assert.match(service, /^KillMode=control-group$/m);
  assert.match(service, /^ConditionFileNotEmpty=%h\/\.local\/lib\/tomverse-amux-v4\/analysis-agent-once\.mjs$/m);
  assert.match(service, /^EnvironmentFile=%h\/\.config\/tomverse-amux-v4\/analysis-agent\.env$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node %h\/\.local\/lib\/tomverse-amux-v4\/analysis-agent-once\.mjs$/m);
  assert.match(service, /^ReadWritePaths=%h\/\.local\/state\/tomverse-amux-v4-analysis$/m);
  assert.doesNotMatch(service, /^(?:Restart|ExecStartPre|User)=/m);
  assert.doesNotMatch(service, /(?:DATABASE_URL|DIRECT_DATABASE_URL|STRIPE_|GITHUB_TOKEN|ANTHROPIC_API_KEY)/);
});

test("the timer waits for the previous one-shot and never catches up missed calls", () => {
  assert.match(timer, /^OnUnitInactiveSec=60s$/m);
  assert.match(timer, /^Persistent=false$/m);
  assert.match(timer, /^Unit=amux-v4-analysis-agent\.service$/m);
  assert.doesNotMatch(timer, /^OnUnitActiveSec=/m);
});
