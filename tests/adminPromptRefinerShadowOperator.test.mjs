import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const panel = readFileSync(
  join(root, "components", "admin", "AdminPromptRefinerShadowPanel.tsx"),
  "utf8"
);
const page = readFileSync(
  join(
    root,
    "app",
    "(site)",
    "(application)",
    "admin",
    "prompt-refiner-shadow",
    "page.tsx"
  ),
  "utf8"
);

test("the operator page is owner-only", () => {
  assert.match(page, /getServerSession\(authOptions\)/);
  assert.match(page, /getAdminRole\(session\) !== "owner"/);
  assert.match(page, /notFound\(\)/);
});

test("the mounted effect reads only and every mutation is a named click action", () => {
  const effect = panel.match(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/)?.[1];
  assert.ok(effect, "the initial effect remains inspectable");
  assert.match(effect, /readStage\(\)/);
  assert.doesNotMatch(effect, /method:\s*"POST"/);
  assert.doesNotMatch(panel, /setInterval|setTimeout/);
  assert.match(panel, /onClick=\{\(\) => void approveStage\(\)\}/);
  assert.match(panel, /onClick=\{\(\) => void approveRun\(\)\}/);
  assert.match(panel, /onClick=\{\(\) => void execute\(\)\}/);
});

test("the execution boundary locks before POST and unlocks only on paused", () => {
  assert.match(
    panel,
    /setExecutionPostLocked\(true\);[\s\S]*?fetch\(PROMPT_REFINER_SHADOW_EXECUTION_PATH/
  );
  assert.match(
    panel,
    /if \(refreshed && parsed\?\.status === "paused"\) \{\s*setExecutionPostLocked\(false\)/
  );
  assert.match(panel, /setError\(m\.statusRefreshFailed\)/);
  assert.doesNotMatch(panel, /retry\s*\(|redispatch\s*\(/i);
});

test("the page exposes recent-auth recovery but no prompt or model output", () => {
  assert.match(panel, /adminRecentAuthenticationHref\(/);
  assert.doesNotMatch(panel, /refinedPrompt|promptText|modelOutput|outputText/);
  assert.match(panel, /promptRefinerStageApprovalBody\(stage\)/);
  assert.match(panel, /promptRefinerRunApprovalBody\(run\)/);
  assert.match(panel, /promptRefinerExecutionBody\(execution\)/);
});

test("refresh re-reads the visible step instead of advancing the workflow", () => {
  const refresh = panel.match(/const refresh = async \(\) => \{([\s\S]*?)\n  \};/)?.[1];
  assert.ok(refresh, "refresh remains inspectable");
  assert.match(refresh, /if \(execution && run\) await readExecution\(run\)/);
  assert.match(refresh, /else if \(run && stage\) await readRun\(stage\)/);
  assert.match(refresh, /else await readStage\(\)/);
  assert.doesNotMatch(refresh, /else if \(stage\) await readRun\(stage\)/);
});

test("an existing run can load execution status after the approval flag is off", () => {
  assert.match(
    panel,
    /run\.status === "ready_for_explicit_cost_approval" &&\s*!run\.approvalEnabled/
  );
  assert.match(
    panel,
    /!run\.approvalEnabled &&\s*run\.status === "ready_for_explicit_cost_approval"/
  );
  assert.match(panel, /setError\(`\$\{failure\} \$\{m\.postFailureStop\}`\)/);
});
