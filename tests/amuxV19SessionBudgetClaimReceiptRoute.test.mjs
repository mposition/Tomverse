import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const secret = "v19_session_budget_012345678901234567890123456";
const envKeys = ["TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET",
  "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ",
  "TOMVERSE_AMUX_SYNC_SECRET"];
const request = (query, token = secret) => new Request(
  `https://tomverse.example/api/internal/amux/v19/analysis-budget/claim${query}`,
  { headers: { authorization: `Bearer ${token}`,
    "x-amux-agent-id": "amux-intake" } });

test("v19 claim readback denies unauthorised, disabled and malformed requests before DB", async () => {
  const imported = await import(
    "../app/api/internal/amux/v19/analysis-budget/claim/route.ts");
  const GET = imported.GET ?? imported.default.GET;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env[envKeys[0]] = secret;
    delete process.env[envKeys[1]];
    delete process.env[envKeys[2]];
    assert.equal((await GET(request("", "wrong_".repeat(8)))).status, 401);
    const dark = await GET(request(""));
    assert.equal(dark.status, 409);
    assert.match(dark.headers.get("cache-control") ?? "", /no-store/);
    process.env[envKeys[1]] = "enabled";
    const id = "00000000-0000-4000-8000-000000000001";
    for (const query of ["", `?requestId=${id}&reservationId=${id}`,
      `?requestId=${id}&requestId=${id}&reservationId=${id}&invocationOrdinal=0`,
      `?requestId=${id}&reservationId=${id}&invocationOrdinal=01`,
      `?requestId=${id}&reservationId=${id}&invocationOrdinal=-1`,
      `?requestId=${id}&reservationId=${id}&invocationOrdinal=0&extra=x`]) {
      assert.equal((await GET(request(query))).status, 400);
    }
    process.env[envKeys[2]] = secret;
    assert.equal((await GET(request(""))).status, 401);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("v19 claim readback route is read-only and does not require its write switch", async () => {
  const source = await readFile(new URL(
    "../app/api/internal/amux/v19/analysis-budget/claim/route.ts", import.meta.url),
  "utf8");
  assert.match(source, /readAmuxSessionBudgetClaimReceipt/);
  assert.doesNotMatch(source, /commitAmuxSessionBudgetClaim|export async function POST/);
  assert.doesNotMatch(source, /CLAIM_WRITE_ENV|TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_WRITE/);
});
