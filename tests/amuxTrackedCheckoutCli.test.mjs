import assert from "node:assert/strict";
import test from "node:test";

import { planAmuxTrackedCheckoutClaudeCli } from "../lib/amux/ideaTrackedCheckoutCli.ts";

test("v19 CLI plan exposes only cwd-scoped file tools without a turn or time cap", () => {
  const plan = planAmuxTrackedCheckoutClaudeCli({
    directory: "/tmp/amux-v19-checkout-Ab12c3",
    modelId: "claude-opus-5-5", reasoningEffort: "high",
  });
  assert.equal(plan.binary, "/run/amux-cli/claude");
  assert.equal(plan.cwd, "/tmp/amux-v19-checkout-Ab12c3");
  assert.deepEqual(plan.args.slice(plan.args.indexOf("--tools"),
    plan.args.indexOf("--model")),
  ["--tools", "Read,Grep,Glob", "--allowedTools",
    "Read(//tmp/amux-v19-checkout-Ab12c3/**),Grep,Glob",
    "--disallowedTools", "Read(//run/**),Read(//proc/**),Read(//tmp/.claude/**)"]);
  assert.ok(!plan.args.includes("--allowedTools=Read,Grep,Glob"));
  for (const flag of ["--restricted", "--bare", "--safe-mode", "--strict-mcp-config",
    "--no-session-persistence", "--disable-slash-commands", "--no-chrome"])
    assert.ok(plan.args.includes(flag), flag);
  for (const forbidden of ["Bash", "Edit", "Write", "--max-turns", "--max-budget-usd",
    "--add-dir", "--dangerously-skip-permissions"])
    assert.ok(!plan.args.includes(forbidden), forbidden);
});

test("v19 CLI plan refuses a checkout escape or unapproved selection shape", () => {
  const valid = { directory: "/tmp/amux-v19-checkout-Ab12c3",
    modelId: "claude-opus-5-5", reasoningEffort: "high" };
  for (const directory of ["/tmp/other", "/tmp/amux-v19-checkout-Ab12c3/../escape",
    "C:\\tmp\\amux-v19-checkout-Ab12c3", "/tmp/amux-v19-checkout-Ab12c3/"])
    assert.throws(() => planAmuxTrackedCheckoutClaudeCli({ ...valid, directory }));
  assert.throws(() => planAmuxTrackedCheckoutClaudeCli({ ...valid, modelId: "gpt-6-astra" }));
  assert.throws(() => planAmuxTrackedCheckoutClaudeCli({ ...valid, reasoningEffort: "highest" }));
});
