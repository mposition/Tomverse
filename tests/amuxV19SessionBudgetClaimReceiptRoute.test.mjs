import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const secret = "v19_session_budget_012345678901234567890123456";
const envKeys = ["TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET",
  "TOMVERSE_AMUX_SYNC_SECRET"];
const request = (query, token = secret) => new Request(
  `https://tomverse.example/api/internal/amux/v19/analysis-budget/claim${query}`,
  { headers: { authorization: `Bearer ${token}`,
    "x-amux-agent-id": "amux-intake" } });

test("v19 claim readback denies unauthorised and malformed requests before DB", async () => {
  const imported = await import(
    "../app/api/internal/amux/v19/analysis-budget/claim/route.ts");
  const GET = imported.GET ?? imported.default.GET;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env[envKeys[0]] = secret;
    delete process.env[envKeys[1]];
    const denied = await GET(request("", "wrong_".repeat(8)));
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("cache-control") ?? "", /no-store/);
    const id = "00000000-0000-4000-8000-000000000001";
    for (const query of ["", `?requestId=${id}&reservationId=${id}`,
      `?requestId=${id}&requestId=${id}&reservationId=${id}&invocationOrdinal=0`,
      `?requestId=${id}&reservationId=${id}&invocationOrdinal=01`,
      `?requestId=${id}&reservationId=${id}&invocationOrdinal=-1`,
      `?requestId=${id}&reservationId=${id}&invocationOrdinal=0&extra=x`]) {
      assert.equal((await GET(request(query))).status, 400);
    }
    process.env[envKeys[1]] = secret;
    assert.equal((await GET(request(""))).status, 401);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("v19 claim readback is read-only; the claim write is the launcher's separate POST", async () => {
  const source = await readFile(new URL(
    "../app/api/internal/amux/v19/analysis-budget/claim/route.ts", import.meta.url),
  "utf8");
  const getHandler = source.slice(source.indexOf("export async function GET"));
  const postHandler = source.slice(source.indexOf("export async function POST"),
    source.indexOf("export async function GET"));
  assert.match(getHandler, /readAmuxSessionBudgetClaimReceipt/);
  assert.doesNotMatch(getHandler, /commitAmuxSessionBudgetClaim/);
  // The Max launcher's claim write needs its own credential.
  assert.match(postHandler, /isAmuxV19MaxLauncherAuthorized\(request/);
  assert.match(postHandler, /commitAmuxSessionBudgetClaim/);
  assert.doesNotMatch(source, /TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_(?:READ|WRITE)/);
});
