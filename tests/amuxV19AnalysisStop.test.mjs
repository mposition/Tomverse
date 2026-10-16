import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("owner analysis stop remains dark and requires recent authentication", async () => {
  const [route, service] = await Promise.all([
    read("app/api/admin/amux/ideas/analysis-stop/route.ts"),
    read("lib/amux/ideaAnalysisStopService.ts"),
  ]);
  assert.match(route, /TOMVERSE_AMUX_V19_ANALYSIS_STOP_READ/);
  assert.match(route, /TOMVERSE_AMUX_V19_ANALYSIS_STOP_WRITE/);
  assert.match(route, /process\.env\[READ_ENV\] !== "enabled"/);
  assert.match(route, /process\.env\[WRITE_ENV\] !== "enabled"/);
  assert.match(route, /ADMIN_REAUTHENTICATION_REQUIRED/);
  assert.match(route, /ownerConfirmed: z\.literal\(true\)/);
  assert.match(service, /getAdminRole\(session\) !== "owner"/);
  assert.match(service, /assertRecentAdminAuthentication\(input\.session\)/);
  assert.match(service, /takeAuditChainLock\(tx\)/);
  assert.match(service, /writeAdminAuditLog/);
  assert.match(service, /userCreditLedgerTouched: false/);
  assert.doesNotMatch(service, /CreditAccount|CreditLot|Conversation/);
});

test("worker stop polling is authenticated and default-off", async () => {
  const [route, reader] = await Promise.all([
    read("app/api/internal/amux/v19/analysis-stop/route.ts"),
    read("lib/amux/ideaAnalysisWorkerStopRead.ts"),
  ]);
  assert.match(route, /isAmuxV4AnalysisAgentAuthorized\(request/);
  assert.match(route, /TOMVERSE_AMUX_V19_ANALYSIS_STOP_POLL_READ/);
  assert.match(route, /process\.env\[READ_ENV\] !== "enabled"/);
  assert.match(route, /params\.size !== 1/);
  assert.match(reader, /row\.analysisDeadlineAt > row\.now/);
  assert.match(reader, /row\.currentPreviewId === row\.previewId/);
});
