import assert from "node:assert/strict";
import { after, test } from "node:test";

import { GET, POST } from
  "../app/api/internal/amux/v19/session-analysis-result/route.ts";
import { POST as POST_USAGE_ONLY } from
  "../app/api/internal/amux/v19/analysis-budget/max-result/route.ts";

const names = ["TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_WRITE",
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_READ",
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_RETENTION"];
names.push("TOMVERSE_AMUX_V19_READ_MANIFEST_RETENTION",
  "TOMVERSE_AMUX_V19_SESSION_BUDGET_MAX_RESULT_WRITE",
  "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ",
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ");
const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
after(() => {
  for (const name of names) {
    if (prior[name] === undefined) delete process.env[name];
    else process.env[name] = prior[name];
  }
});

const secret = "syntheticMaxResultSecret_0123456789abcdefgh";
const endpoint = "https://test.invalid/api/internal/amux/v19/session-analysis-result";
const headers = { authorization: `Bearer ${secret}`,
  "x-amux-agent-id": "amux-intake-max",
  "content-type": "application/json" };

test("Max result route stays closed until all write, read, and retention switches are enabled", async () => {
  process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
  delete process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_WRITE;
  delete process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_READ;
  delete process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_RETENTION;
  assert.equal((await POST(new Request(endpoint, { method: "POST",
    headers, body: "{}" }))).status, 409);
  assert.equal((await GET(new Request(endpoint,
    { headers }))).status, 409);
  process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_WRITE = "enabled";
  process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_READ = "enabled";
  assert.equal((await POST(new Request(endpoint, { method: "POST",
    headers, body: "{}" }))).status, 409,
  "a disabled retention worker blocks result writes");
  assert.equal((await POST(new Request(endpoint, { method: "POST",
    headers: { ...headers, authorization: "Bearer wrong" },
    body: "{}" }))).status, 401);
});

test("usage-only settlement refuses a Max success when result persistence is enabled", async () => {
  process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
  process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_WRITE = "enabled";
  process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_READ = "enabled";
  process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_RETENTION = "enabled";
  process.env.TOMVERSE_AMUX_V19_READ_MANIFEST_RETENTION = "enabled";
  process.env.TOMVERSE_AMUX_V19_SESSION_BUDGET_MAX_RESULT_WRITE = "enabled";
  process.env.TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ = "enabled";
  process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ = "enabled";
  const response = await POST_USAGE_ONLY(new Request(
    "https://test.invalid/api/internal/amux/v19/analysis-budget/max-result",
    { method: "POST", headers, body: JSON.stringify({
      claimId: "d57eac94-9808-4688-a9f8-940aa3c22188",
      requestId: "fd31e8e8-3e71-4af6-b0a2-c834170b9a92",
      reservationId: "0b82536e-8cf9-4afa-a5b5-f022c73c9ec0",
      ideaId: "aeb93a68-a941-40ed-9782-9abbb3f2139f",
      invocationOrdinal: 0, outcome: "verified_success",
      inputTokens: 1, outputTokens: 1,
    }) }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "session_result_required" });
});

test("a result without an exact CLI channel attestation is refused before database access", async () => {
  process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
  process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_WRITE = "enabled";
  process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_READ = "enabled";
  process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_RETENTION = "enabled";
  process.env.TOMVERSE_AMUX_V19_READ_MANIFEST_RETENTION = "enabled";
  const body = { claimId: "d57eac94-9808-4688-a9f8-940aa3c22188",
    requestId: "fd31e8e8-3e71-4af6-b0a2-c834170b9a92",
    reservationId: "0b82536e-8cf9-4afa-a5b5-f022c73c9ec0",
    ideaId: "aeb93a68-a941-40ed-9782-9abbb3f2139f",
    invocationOrdinal: 0, referenceOrdinal: 0,
    evidenceId: "59818d23-7798-4cfd-9d49-9a3f69653673",
    manifestId: "13638989-a338-461d-9777-7b3fd3c595ab",
    rawModelOutput: "{}", inputTokens: 1, outputTokens: 1 };
  const attestation = { provider: "cursor", modelAttestation: "requested",
    cliSha256: "e".repeat(64) };
  for (const cliAttestation of [undefined,
    { ...attestation, provider: "gemini" },
    { ...attestation, modelAttestation: "assumed" },
    { ...attestation, cliSha256: "E".repeat(64) },
    { ...attestation, servedModelId: "auto" }]) {
    const response = await POST(new Request(endpoint, { method: "POST", headers,
      body: JSON.stringify(cliAttestation ? { ...body, cliAttestation } : body) }));
    assert.equal(response.status, 400);
  }
});

test("result receipt refuses noncanonical invocation ordinals before database access", async () => {
  process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
  process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_READ = "enabled";
  for (const ordinal of ["", " 0", "1e2", "01", "-1"]) {
    const query = new URLSearchParams({
      claimId: "d57eac94-9808-4688-a9f8-940aa3c22188",
      requestId: "fd31e8e8-3e71-4af6-b0a2-c834170b9a92",
      reservationId: "0b82536e-8cf9-4afa-a5b5-f022c73c9ec0",
      ideaId: "aeb93a68-a941-40ed-9782-9abbb3f2139f",
      invocationOrdinal: ordinal,
    });
    assert.equal((await GET(new Request(`${endpoint}?${query}`,
      { headers }))).status, 400);
  }
});
