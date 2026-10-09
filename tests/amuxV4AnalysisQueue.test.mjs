import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AMUX_V4_ANALYSIS_AGENT_ID,
  AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  AMUX_V4_ANALYSIS_QUEUE_CODE_LATCH,
  AMUX_V4_ANALYSIS_QUEUE_READ_ENV,
  amuxV4AnalysisQueueReadEnabled,
  isAmuxV4AnalysisAgentAuthorized,
} from "../lib/amux/ideaAnalysisQueueCore.ts";
import {
  encodeAmuxV4AnalysisQueueCursor,
  parseAmuxV4AnalysisQueueCursor,
} from "../lib/amux/ideaAnalysisQueueCursorCore.ts";
import { buildAmuxV4AnalysisCandidateWhere } from "../lib/amux/ideaAnalysisQueueWhereCore.ts";
import { AMUX_V4_ANALYSIS_CLI_HARD_DEADLINE_MS,
  AMUX_V4_ANALYSIS_DAILY_CLAIM_LIMIT,
  amuxV4AnalysisUtcDayKey } from "../lib/amux/ideaAnalysisInvocationLimitsCore.ts";

const secret = "v4_intake_only_012345678901234567890123456789";

test("AMUX v4 approved CLI admission values use UTC days", () => {
  assert.equal(AMUX_V4_ANALYSIS_CLI_HARD_DEADLINE_MS, 600_000);
  assert.equal(AMUX_V4_ANALYSIS_DAILY_CLAIM_LIMIT, 12);
  assert.equal(amuxV4AnalysisUtcDayKey(new Date("2026-10-04T23:59:59.999Z")),
    "2026-10-04");
  assert.equal(amuxV4AnalysisUtcDayKey(new Date("2026-10-05T00:00:00.000Z")),
    "2026-10-05");
  assert.equal(amuxV4AnalysisUtcDayKey(new Date(Number.NaN)), null);
});

test("only the guarded claim route calls the production claim service", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const matches = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:ts|tsx|mjs)$/.test(entry.name)) {
        const source = await readFile(path, "utf8");
        if (/\bcommitAmuxIdeaOnlyAnalysisClaim\s*\(/.test(source)) {
          matches.push(relative(root, path).replaceAll("\\", "/"));
        }
      }
    }
  }
  await visit(join(root, "app"));
  await visit(join(root, "lib"));
  assert.deepEqual(matches.sort(), [
    "app/api/internal/amux/v4/analysis-claim/route.ts",
    "lib/amux/ideaAnalysisClaimService.ts",
  ]);
  const route = await readFile(join(root,
    "app/api/internal/amux/v4/analysis-claim/route.ts"), "utf8");
  const service = await readFile(join(root,
    "lib/amux/ideaAnalysisClaimService.ts"), "utf8");
  assert.match(route, /commitAmuxIdeaOnlyAnalysisClaim\(tx,/);
  assert.match(service, /await takeAuditChainLock\(tx\);[\s\S]*?await enforceAmuxV4DailyClaimLimit\(tx\);[\s\S]*?writeSystemAuditLog\(/);
  assert.match(service, /to_char\(clock_timestamp\(\) AT TIME ZONE 'UTC', 'YYYY-MM-DD'\)/);
  assert.match(route, /const CLAIM_CODE_LATCH = true/);
});
const request = (token, agentId = AMUX_V4_ANALYSIS_AGENT_ID) => new Request(
  "https://tomverse.example/api/internal/amux/v4/analysis-queue", {
    method: "POST", headers: { authorization: `Bearer ${token}`,
      "x-amux-agent-id": agentId },
  });

test("AMUX v4 analysis queue uses a dedicated identity and exact environment switch", () => {
  assert.equal(AMUX_V4_ANALYSIS_QUEUE_CODE_LATCH, true);
  assert.equal(amuxV4AnalysisQueueReadEnabled("enabled"), true);
  assert.equal(amuxV4AnalysisQueueReadEnabled("disabled"), false);
  assert.equal(amuxV4AnalysisQueueReadEnabled(undefined), false);
  assert.equal(isAmuxV4AnalysisAgentAuthorized(request(secret), secret), true);
  assert.equal(isAmuxV4AnalysisAgentAuthorized(request(secret), secret, secret), false);
  assert.equal(isAmuxV4AnalysisAgentAuthorized(request(secret, "amux-orchestrator"), secret), false);
  assert.equal(isAmuxV4AnalysisAgentAuthorized(request("wrong_".repeat(7)), secret), false);
  assert.equal(isAmuxV4AnalysisAgentAuthorized(request(secret), undefined), false);
  assert.equal(isAmuxV4AnalysisAgentAuthorized(request(secret), "short"), false);
});

test("AMUX v4 queue route refuses unauthenticated and env-off requests before DB", async () => {
  const imported = await import("../app/api/internal/amux/v4/analysis-queue/route.ts");
  const POST = imported.POST ?? imported.default.POST;
  const originalSecret = process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
  const originalRead = process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV];
  const originalSyncSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  try {
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = secret;
    delete process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV];
    delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    const denied = await POST(new Request("https://tomverse.example/api/internal/amux/v4/analysis-queue",
      { method: "POST" }));
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("cache-control") ?? "", /no-store/);
    assert.equal((await POST(request(secret, "amux-orchestrator"))).status, 401);
    process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
    assert.equal((await POST(request(secret))).status, 401);
    delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    const dark = await POST(request(secret));
    assert.equal(dark.status, 409);
    assert.deepEqual(await dark.json(), { available: false, reason: "analysis_queue_disabled" });
    process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV] = "enabled";
    assert.equal((await POST(request(secret))).status, 415,
      "enabled queue reaches request validation without touching the DB");
  } finally {
    if (originalSecret === undefined) delete process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
    else process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = originalSecret;
    if (originalRead === undefined) delete process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV];
    else process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV] = originalRead;
    if (originalSyncSecret === undefined) delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    else process.env.TOMVERSE_AMUX_SYNC_SECRET = originalSyncSecret;
  }
});

test("AMUX v4 claim route requires both dedicated read and write environments", async () => {
  const imported = await import("../app/api/internal/amux/v4/analysis-claim/route.ts");
  const POST = imported.POST ?? imported.default.POST;
  const GET = imported.GET ?? imported.default.GET;
  const previousSecret = process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
  const previousWrite = process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_WRITE;
  const previousRead = process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_READ;
  const previousSync = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  try {
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = secret;
    process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_WRITE = "enabled";
    delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_READ;
    delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    const endpoint = "https://tomverse.example/api/internal/amux/v4/analysis-claim";
    const body = JSON.stringify({ requestId: "request_1", previewId: "preview_1" });
    const headers = { authorization: `Bearer ${secret}`,
      "x-amux-agent-id": AMUX_V4_ANALYSIS_AGENT_ID,
      "content-type": "application/json" };
    assert.equal((await POST(new Request(endpoint,
      { method: "POST", body }))).status, 401);
    const disabled = await POST(new Request(endpoint,
      { method: "POST", headers, body }));
    assert.equal(disabled.status, 409);
    assert.match(disabled.headers.get("cache-control") ?? "", /no-store/);
    assert.deepEqual(await disabled.json(),
      { available: false, reason: "analysis_claim_disabled" });
    const readEndpoint = `${endpoint}?requestId=request_1&previewId=preview_1`;
    assert.equal((await GET(new Request(readEndpoint))).status, 401);
    const readDisabled = await GET(new Request(readEndpoint, { headers }));
    assert.equal(readDisabled.status, 409);
    assert.deepEqual(await readDisabled.json(),
      { available: false, reason: "analysis_claim_read_disabled" });
    process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_READ = "enabled";
    delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_WRITE;
    const writeEnvOff = await POST(new Request(endpoint,
      { method: "POST", headers, body }));
    assert.equal(writeEnvOff.status, 409);
    assert.deepEqual(await writeEnvOff.json(),
      { available: false, reason: "analysis_claim_disabled" });
    const malformed = await GET(new Request(`${readEndpoint}&requestId=again`,
      { headers }));
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers.get("cache-control") ?? "", /no-store/);
  } finally {
    if (previousSecret === undefined) delete process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
    else process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = previousSecret;
    if (previousWrite === undefined) delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_WRITE;
    else process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_WRITE = previousWrite;
    if (previousRead === undefined) delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_READ;
    else process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_READ = previousRead;
    if (previousSync === undefined) delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    else process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSync;
  }
});

test("AMUX v4 result route requires independent read and write environments", async () => {
  const imported = await import("../app/api/internal/amux/v4/analysis-result/route.ts");
  const POST = imported.POST ?? imported.default.POST;
  const GET = imported.GET ?? imported.default.GET;
  const oldSecret = process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
  const oldWrite = process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_WRITE;
  const oldRead = process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_READ;
  const oldSync = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  try {
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = secret;
    process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_WRITE = "enabled";
    delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_READ;
    delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    const endpoint = "https://tomverse.example/api/internal/amux/v4/analysis-result";
    const headers = { authorization: `Bearer ${secret}`,
      "x-amux-agent-id": AMUX_V4_ANALYSIS_AGENT_ID,
      "content-type": "application/json" };
    assert.equal((await POST(new Request(endpoint, { method: "POST" }))).status, 401);
    const blockedWrite = await POST(new Request(endpoint,
      { method: "POST", headers, body: "{}" }));
    assert.equal(blockedWrite.status, 409);
    assert.deepEqual(await blockedWrite.json(),
      { available: false, reason: "analysis_result_disabled" });
    const blockedRead = await GET(new Request(`${endpoint}?requestId=r1&previewId=p1`,
      { headers }));
    assert.equal(blockedRead.status, 409);
    assert.deepEqual(await blockedRead.json(),
      { available: false, reason: "analysis_result_read_disabled" });
    assert.match(blockedRead.headers.get("cache-control") ?? "", /no-store/);
    process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_READ = "enabled";
    delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_WRITE;
    const writeEnvOff = await POST(new Request(endpoint,
      { method: "POST", headers, body: "{}" }));
    assert.equal(writeEnvOff.status, 409);
    assert.deepEqual(await writeEnvOff.json(),
      { available: false, reason: "analysis_result_disabled" });
    const malformedRead = await GET(new Request(
      `${endpoint}?requestId=r1&previewId=p1&previewId=p2`, { headers }));
    assert.equal(malformedRead.status, 400,
      "read guard is independent of the still-closed write latch");
  } finally {
    if (oldSecret === undefined) delete process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
    else process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = oldSecret;
    if (oldWrite === undefined) delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_WRITE;
    else process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_WRITE = oldWrite;
    if (oldRead === undefined) delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_READ;
    else process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_READ = oldRead;
    if (oldSync === undefined) delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    else process.env.TOMVERSE_AMUX_SYNC_SECRET = oldSync;
  }
});

test("AMUX v4 analysis queue returns candidate IDs, never transfer text", async () => {
  const service = await readFile(new URL("../lib/amux/ideaAnalysisQueueService.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/internal/amux/v4/analysis-queue/route.ts", import.meta.url), "utf8");
  assert.match(service, /take: PAGE_SIZE \+ 1/);
  assert.match(service, /nextCursor:/);
  assert.match(service, /buildAmuxV4AnalysisCandidateWhere/);
  assert.doesNotMatch(service, /payloadCiphertext: true|rawCiphertext: true|openAmuxContent/);
  assert.doesNotMatch(service, /\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/);
  assert.match(route, /isAmuxV4AnalysisAgentAuthorized/);
  assert.match(route, /amuxV4AnalysisQueueReadEnabled/);
  assert.doesNotMatch(route, /codex|claude|spawn\(/);
});

test("analysis result key preflight bounds the previous raw page and maps DB failure", async () => {
  const route = await readFile(new URL(
    "../app/api/internal/amux/v4/analysis-result/route.ts", import.meta.url), "utf8");
  assert.match(route, /derivationGroupId: null/);
  assert.match(route, /select: \{ id: true \}, take: 41/);
  assert.match(route, /previousUnits\.length > 40/);
  assert.match(route, /catch \{\s*return amuxJsonNoStore\(\{ error: "key_preflight_unavailable" \}, 503\);/);
});

test("AMUX v4 analysis writes require their independent read-back switches", async () => {
  for (const [name, readEnv] of [
    ["analysis-claim", "CLAIM_RECEIPT_READ_ENV"],
    ["analysis-result", "RESULT_RECEIPT_READ_ENV"],
  ]) {
    const route = await readFile(new URL(
      `../app/api/internal/amux/v4/${name}/route.ts`, import.meta.url), "utf8");
    const post = route.slice(route.indexOf("export async function POST"),
      route.indexOf("export async function GET"));
    const get = route.slice(route.indexOf("export async function GET"));
    assert.match(post, new RegExp(`process\\.env\\[${readEnv}\\] !== "enabled"`));
    assert.doesNotMatch(get, /process\.env\[(?:CLAIM_WRITE_ENV|RESULT_WRITE_ENV)\]/);
  }
});

test("AMUX v4 queue candidate filter requires confirmation and current analysis", () => {
  const now = new Date("2026-10-03T00:00:00.000Z");
  const cursor = { confirmedAt: new Date("2026-10-02T00:00:00.000Z"),
    previewId: "preview_123" };
  const where = buildAmuxV4AnalysisCandidateWhere(now, cursor);
  assert.equal(where.state, "confirmed");
  assert.deepEqual(where.confirmedByUserId, { not: null });
  assert.deepEqual(where.confirmationAuditLogId, { not: null });
  assert.deepEqual(where.confirmExpiresAt, { gt: now });
  assert.deepEqual(where.idea, { state: { in: ["submitted", "analyzing"] }, analysisDeadlineAt: { gt: now },
    currentSourcePlan: { is: { state: "active" } } });
  assert.deepEqual(where.sourcePlanRevision, { is: { state: "active" } });
  assert.deepEqual(where.planBoundCurrentForChunk, { is: { state: "awaiting_preview" } });
  assert.deepEqual(where.OR, [
    { confirmedAt: { gt: cursor.confirmedAt } },
    { confirmedAt: cursor.confirmedAt, id: { gt: cursor.previewId } },
  ]);
  assert.equal(buildAmuxV4AnalysisCandidateWhere(now, null).OR, undefined);
});

test("AMUX v4 analysis queue cursor round-trips a stable page position", () => {
  const position = { confirmedAt: new Date("2026-10-03T00:00:00.123Z"), previewId: "preview_123" };
  assert.deepEqual(parseAmuxV4AnalysisQueueCursor(
    encodeAmuxV4AnalysisQueueCursor(position)), position);
  for (const invalid of ["", "!", "abc", "e30", "a".repeat(513),
    Buffer.from(JSON.stringify(["2026-10-03T00:00:00.123Z", "bad/id"])).toString("base64url")]) {
    assert.equal(parseAmuxV4AnalysisQueueCursor(invalid), null);
  }
});
