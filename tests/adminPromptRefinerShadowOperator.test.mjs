import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminPromptRefinerShadowMessages } from "../lib/adminMessages/promptRefinerShadow.ts";

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
  const effect = panel.match(/useEffect\(\(\) => \{\s*let active = true;([\s\S]*?)\n  \}, \[m\.requestFailed, readStage\]\);/)?.[1];
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
    /setExecutionPostLocked\(true\);[\s\S]*?adminFetch\(PROMPT_REFINER_SHADOW_EXECUTION_PATH,[\s\S]*?timeoutMs: EXECUTION_POST_TIMEOUT_MS/
  );
  // The execute route runs up to its 300 s maxDuration; the client must outlast
  // it or every normal run would read as an unknown outcome.
  assert.match(panel, /const EXECUTION_POST_TIMEOUT_MS = 330_000;/);
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

test("the stage TTL and execution expiry keep distinct labels", () => {
  assert.match(
    panel,
    /label=\{m\.approvalWindow\}[\s\S]*?stage\.approvalTtlMinutes/
  );
  assert.match(
    panel,
    /label=\{m\.expires\}[\s\S]*?execution\.approvalExpiresAt/
  );
  assert.notEqual(
    adminPromptRefinerShadowMessages.en.approvalWindow,
    adminPromptRefinerShadowMessages.en.expires
  );
  assert.notEqual(
    adminPromptRefinerShadowMessages.ko.approvalWindow,
    adminPromptRefinerShadowMessages.ko.expires
  );
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

test("historical diagnostics mount independently of approval preview and never mutate", () => {
  assert.match(panel, /const readHistorical = useCallback\(async \(\) => \{/);
  assert.match(panel, /adminFetch\(\s*PROMPT_REFINER_SHADOW_HISTORICAL_EVIDENCE_PATH,[\s\S]*?cache: "no-store"/);
  assert.match(panel, /parsePromptRefinerShadowHistoricalDiagnostics\(body\)/);
  assert.match(panel, /useEffect\(\(\) => \{[\s\S]*?queueMicrotask\(\(\) => \{\s*if \(active\) void readHistorical\(\);/);
  assert.match(panel, /<Step title=\{m\.historicalTitle\} description=\{m\.historicalBody\}>/);
  assert.match(panel, /const historicalRead = readHistorical\(\);/);
  const historicalRead = panel.match(/const readHistorical = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[\]\);/)?.[1];
  assert.ok(historicalRead);
  assert.doesNotMatch(historicalRead, /method:\s*"POST"|readStage\(|readRun\(|readExecution\(/);
});

test("locale changes update historical errors without repeating the mount GET", () => {
  const historicalRead = panel.match(/const readHistorical = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[\]\);/)?.[1];
  assert.ok(historicalRead, "the historical reader has stable identity");
  assert.match(historicalRead, /setHistoricalFailure\(\{\s*kind: "api",\s*status: response\.status,/);
  assert.match(historicalRead, /setHistoricalFailure\(\{ kind: "invalid_response" \}\)/);
  assert.match(historicalRead, /setHistoricalFailure\(\{ kind: "request_failed" \}\)/);
  assert.doesNotMatch(historicalRead, /\bm\./);
  assert.match(panel, /const historicalFailureDisplay = historicalFailure\?\.kind === "api"\s*\? describeAdminApiFailure\(\{[\s\S]*?fallback: m\.requestFailed,\s*locale,/);
  assert.match(panel, /historicalFailure\.kind === "invalid_response"\s*\? m\.responseInvalid\s*: m\.requestFailed/);
  assert.match(panel, /\{historicalFailureDisplay \? \([\s\S]*?historicalFailureDisplay\.message[\s\S]*?historicalFailureDisplay\.requiresReauthentication/);
  assert.doesNotMatch(panel, /historicalLocaleMessages|historicalReauthenticationRequired|setHistoricalError/);
  assert.match(panel, /queueMicrotask\(\(\) => \{\s*if \(active\) void readHistorical\(\);\s*\}\);[\s\S]*?\}, \[readHistorical\]\);/);
});

test("historical refresh keeps the previous diagnostics table visible while loading", () => {
  const historicalSection = panel.match(/<Step title=\{m\.historicalTitle\} description=\{m\.historicalBody\}>([\s\S]*?)<\/Step>/)?.[1];
  assert.ok(historicalSection);
  assert.match(historicalSection, /\{historicalLoading \? \(\s*<p role="status"[\s\S]*?<\/p>\s*\) : null\}\s*\{historicalFailureDisplay \? \(/);
  assert.match(historicalSection, /: historical \? \(\s*<div data-testid="prompt-refiner-historical-evidence">/);
  assert.match(historicalSection, /: historicalLoading \? null : \(/);
});

test("an older historical GET cannot replace a later refresh result or loading state", () => {
  const historicalRead = panel.match(/const readHistorical = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[\]\);/)?.[1];
  assert.ok(historicalRead);
  assert.match(panel, /const historicalRequestGeneration = useRef\(0\)/);
  assert.match(historicalRead, /const requestGeneration = \+\+historicalRequestGeneration\.current/);
  assert.match(historicalRead, /const body = await responseJson\(response\);\s*if \(requestGeneration !== historicalRequestGeneration\.current\) return;/);
  assert.match(historicalRead, /if \(requestGeneration === historicalRequestGeneration\.current\) \{\s*setHistoricalFailure\(\{ kind: "request_failed" \}\);\s*\}/);
  assert.match(historicalRead, /if \(requestGeneration === historicalRequestGeneration\.current\) \{\s*setHistoricalLoading\(false\);\s*\}/);
  assert.match(panel, /return \(\) => \{\s*active = false;\s*historicalRequestGeneration\.current \+= 1;\s*\};/);
});

test("a known execution terminal GET refreshes historical evidence without retrying POST", () => {
  const execution = panel.match(/const execute = async \(\) => \{([\s\S]*?)\n  \};\n\n  const refresh/)?.[1];
  assert.ok(execution);
  assert.match(execution, /const refreshed = await readExecution\(run!\);/);
  assert.match(execution, /if \(refreshed\?\.status === "completed" \|\|\s*refreshed\?\.status === "stopped_unknown"\) \{\s*await readHistorical\(\);\s*\}/);
  assert.match(execution, /if \(refreshed && parsed\?\.status === "paused"\) \{\s*setExecutionPostLocked\(false\);\s*\}/);
  assert.equal((execution.match(/method:\s*"POST"/g) ?? []).length, 1);
});
