import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  AMUX_V4_ANALYSIS_QUEUE_READ_ENV } from "../lib/amux/ideaAnalysisQueueCore.ts";
import { AMUX_SESSION_INTAKE_ENV } from "../lib/amux/ideaSessionSubmissionCore.ts";
import { encodeAmuxSessionAnalysisQueueCursor,
  parseAmuxSessionAnalysisQueueCursor } from
  "../lib/amux/ideaSessionAnalysisQueueCursorCore.ts";
import { buildAmuxSessionAnalysisQueueWhere } from
  "../lib/amux/ideaSessionAnalysisQueueWhereCore.ts";

const secret = "v19_session_agent_012345678901234567890123456";
const endpoint = "https://tomverse.example/api/internal/amux/v19/analysis-queue";
const request = (body = null, token = secret) => new Request(endpoint, {
  method: "POST", headers: { authorization: `Bearer ${token}`,
    "x-amux-agent-id": "amux-intake",
    ...(body === null ? {} : { "content-type": "application/json" }) },
  ...(body === null ? {} : { body: JSON.stringify(body) }),
});

test("v19 session queue filters expired, cancelled, purged and owner ideas", () => {
  const now = new Date("2026-10-17T01:00:00.000Z");
  const cursor = { createdAt: new Date("2026-10-16T23:00:00.123Z"),
    reservationId: "00000000-0000-4000-8000-000000000001" };
  assert.deepEqual(buildAmuxSessionAnalysisQueueWhere(now, cursor), {
    status: "queued",
    AND: [{ OR: [
      { budgetClaims: { none: {} }, idea: { state: "submitted" } },
      { budgetClaims: { some: { status: "succeeded" },
        every: { status: "succeeded" } }, idea: { state: "analyzing" } },
    ] }],
    idea: { submissionOrigin: "session", state: { in: ["submitted", "analyzing"] },
      cancelledAt: null, analysisCompletedAt: null, analysisDeadlineAt: { gt: now },
      rawCiphertext: { not: null }, rawPurgedAt: null,
      sourceProvenanceCiphertext: { not: null } },
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.reservationId } },
    ],
  });
  assert.equal(buildAmuxSessionAnalysisQueueWhere(now, null).OR, undefined);
});

test("v19 session queue cursor has a strict, stable position", () => {
  const cursor = { createdAt: new Date("2026-10-16T23:00:00.123Z"),
    reservationId: "00000000-0000-4000-8000-000000000001" };
  assert.deepEqual(parseAmuxSessionAnalysisQueueCursor(
    encodeAmuxSessionAnalysisQueueCursor(cursor)), cursor);
  for (const value of ["", "!", "e30", "a".repeat(513),
    Buffer.from(JSON.stringify(["2026-10-16T23:00:00.123Z", "bad/id"]))
      .toString("base64url")]) {
    assert.equal(parseAmuxSessionAnalysisQueueCursor(value), null);
  }
});

test("v19 session queue refuses unauthorized or disabled requests before DB", async () => {
  const imported = await import("../app/api/internal/amux/v19/analysis-queue/route.ts");
  const POST = imported.POST ?? imported.default.POST;
  const keys = [AMUX_V4_ANALYSIS_AGENT_SECRET_ENV, AMUX_V4_ANALYSIS_QUEUE_READ_ENV,
    AMUX_SESSION_INTAKE_ENV, "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_QUEUE_READ",
    "TOMVERSE_AMUX_SYNC_SECRET"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = secret;
    delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    for (const key of keys.slice(1, 4)) delete process.env[key];
    assert.equal((await POST(request({}, "wrong_".repeat(8)))).status, 401);
    const dark = await POST(request({}));
    assert.equal(dark.status, 409);
    assert.match(dark.headers.get("cache-control") ?? "", /no-store/);
    for (const key of keys.slice(1, 4)) process.env[key] = "enabled";
    assert.equal((await POST(request())).status, 415);
    assert.equal((await POST(request({ after: "!" }))).status, 400);
    assert.equal((await POST(request({ unexpected: true }))).status, 400);
    process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
    assert.equal((await POST(request({}))).status, 401);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("v19 session queue response is limited to content-free metadata", async () => {
  const service = await readFile(new URL(
    "../lib/amux/ideaSessionAnalysisQueueService.ts", import.meta.url), "utf8");
  assert.match(service, /take: PAGE_SIZE \+ 1/);
  assert.match(service, /buildAmuxSessionAnalysisQueueWhere/);
  assert.doesNotMatch(service, /rawCiphertext: true|sourceProvenanceCiphertext: true|openAmuxContent/);
  assert.doesNotMatch(service, /\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/);
});
