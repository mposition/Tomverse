import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AMUX_V4_ANALYSIS_AGENT_ID,
  AMUX_V4_ANALYSIS_AGENT_SECRET_ENV } from "../lib/amux/ideaAnalysisQueueCore.ts";
import { shouldAmuxIdeaAnalysisWorkerStop } from
  "../lib/amux/ideaAnalysisWorkerStopRead.ts";

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

test("worker stop decision rejects every lost authority and expired deadline", () => {
  const now = new Date("2026-10-16T15:00:00.000Z");
  const active = {
    namespace: "amux-v4-analysis", holdStatus: "in_flight",
    dispatchedAt: now, previewId: "preview_1", previewState: "in_flight",
    ideaState: "analyzing", cancelledAt: null,
    analysisDeadlineAt: new Date(now.getTime() + 1),
    chunkState: "in_flight", currentPreviewId: "preview_1",
    leaseGeneration: 1, now,
  };
  assert.equal(shouldAmuxIdeaAnalysisWorkerStop(active), false);
  for (const change of [
    { holdStatus: "held" }, { dispatchedAt: null },
    { previewState: "owner_stopped" }, { ideaState: "ready" },
    { cancelledAt: now }, { analysisDeadlineAt: now },
    { chunkState: "outcome_unknown" },
    { currentPreviewId: "preview_2" }, { leaseGeneration: 2 },
  ]) {
    assert.equal(shouldAmuxIdeaAnalysisWorkerStop({ ...active, ...change }), true,
      `must stop after ${Object.keys(change)[0]} changes`);
  }
});

test("worker stop route denies unauthenticated, disabled and malformed polling before DB", async () => {
  const imported = await import("../app/api/internal/amux/v19/analysis-stop/route.ts");
  const GET = imported.GET ?? imported.default.GET;
  const secret = "v19_stop_poll_012345678901234567890123456789";
  const key = "TOMVERSE_AMUX_V19_ANALYSIS_STOP_POLL_READ";
  const oldSecret = process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
  const oldRead = process.env[key];
  const oldSync = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const endpoint = "https://tomverse.example/api/internal/amux/v19/analysis-stop";
  const headers = { authorization: `Bearer ${secret}`,
    "x-amux-agent-id": AMUX_V4_ANALYSIS_AGENT_ID };
  try {
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = secret;
    delete process.env[key];
    delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    const denied = await GET(new Request(`${endpoint}?holdId=hold_1`));
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("cache-control") ?? "", /no-store/);
    assert.equal((await GET(new Request(`${endpoint}?holdId=hold_1`, {
      headers: { ...headers, authorization: "Bearer wrong" },
    }))).status, 401);
    process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
    assert.equal((await GET(new Request(`${endpoint}?holdId=hold_1`,
      { headers }))).status, 401);
    delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    const dark = await GET(new Request(`${endpoint}?holdId=hold_1`, { headers }));
    assert.equal(dark.status, 409);
    assert.deepEqual(await dark.json(), { error: "analysis_stop_poll_disabled" });
    process.env[key] = "enabled";
    for (const query of ["", "?holdId=", "?holdId=bad%2Fid",
      "?holdId=hold_1&holdId=hold_2", "?holdId=hold_1&extra=1"]) {
      const response = await GET(new Request(`${endpoint}${query}`, { headers }));
      assert.equal(response.status, 400, query);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    }
  } finally {
    if (oldSecret === undefined) delete process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
    else process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = oldSecret;
    if (oldRead === undefined) delete process.env[key];
    else process.env[key] = oldRead;
    if (oldSync === undefined) delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    else process.env.TOMVERSE_AMUX_SYNC_SECRET = oldSync;
  }
});
