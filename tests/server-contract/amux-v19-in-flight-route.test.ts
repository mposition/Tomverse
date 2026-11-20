import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GET } from
  "../../app/api/internal/amux/v19/analysis-budget/in-flight/route.ts";
import { AMUX_V19_MAX_LAUNCHER_ID } from
  "../../lib/amux/ideaSessionMaxLauncherAuth.ts";

const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const keys = ["TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
  "TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET",
  "TOMVERSE_AMUX_SYNC_SECRET"] as const;

async function withEnv(values: Partial<Record<(typeof keys)[number], string>>,
  fn: () => Promise<void>) {
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    await fn();
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
}

const request = (query: string, { bearer = secret,
  agent = AMUX_V19_MAX_LAUNCHER_ID }: { bearer?: string; agent?: string } = {}) =>
  new Request(
    `https://test.invalid/api/internal/amux/v19/analysis-budget/in-flight${query}`,
    { headers: { authorization: `Bearer ${bearer}`, "x-amux-agent-id": agent } });
const before = (offsetMs: number) =>
  `?before=${encodeURIComponent(new Date(Date.now() + offsetMs).toISOString())}`;

test("the in-flight list requires the Max launcher's own credential and identity", async () => {
  await withEnv({}, async () => {
    assert.equal((await GET(request(before(-60_000)))).status, 401);
  });
  await withEnv({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret }, async () => {
    const denied = await GET(request(before(-60_000),
      { bearer: "wrong_".repeat(8) }));
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("cache-control") ?? "", /no-store/);
    // The v4 Agent's identity does not open it.
    assert.equal((await GET(request(before(-60_000),
      { agent: "amux-intake" }))).status, 401);
  });
  // The launcher secret must be its own, never the v4 Agent's or the sync worker's.
  await withEnv({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret,
    TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET: secret }, async () => {
    assert.equal((await GET(request(before(-60_000)))).status, 401);
  });
  await withEnv({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret,
    TOMVERSE_AMUX_SYNC_SECRET: secret }, async () => {
    assert.equal((await GET(request(before(-60_000)))).status, 401);
  });
});

test("the in-flight list refuses a missing, repeated, malformed or future time before the database", async () => {
  await withEnv({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret }, async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    for (const query of ["", "?before=", "?before=yesterday",
      "?before=2026-11-16", "?before=1763340000000",
      `?before=${past}&before=${past}`, `?before=${past}&extra=1`,
      `?other=${past}`, before(60_000), before(3_600_000)]) {
      const response = await GET(request(query));
      assert.equal(response.status, 400, query);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    }
  });
});

test("the in-flight list is read-only and answers identities only", async () => {
  const source = await readFile(new URL(
    "../../app/api/internal/amux/v19/analysis-budget/in-flight/route.ts",
    import.meta.url), "utf8");
  assert.doesNotMatch(source, /export async function (?:POST|PUT|PATCH|DELETE)/);
  assert.match(source, /export async function GET/);
  assert.match(source, /isAmuxV19MaxLauncherAuthorized\(request/);
  // Auth comes before the transaction opens.
  assert.ok(source.indexOf("isAmuxV19MaxLauncherAuthorized(request") <
    source.indexOf("prisma.$transaction"));
  assert.match(source, /listAmuxSessionInFlightShadowClaims/);
  assert.doesNotMatch(source,
    /commitAmuxSession|writeSystemAuditLog|\.(?:create|update|updateMany|upsert|delete|deleteMany)\(/);
  const service = await readFile(new URL(
    "../../lib/amux/ideaSessionAnalysisBudgetClaimService.ts", import.meta.url),
  "utf8");
  const list = service.slice(
    service.indexOf("export async function listAmuxSessionInFlightShadowClaims"),
    service.indexOf("export async function commitAmuxSessionBudgetClaim"));
  assert.match(list, /budgetMode: "max_shadow"/);
  assert.match(list, /status: "in_flight"/);
  assert.match(list, /createdAt: \{ lt: input\.before \}/);
  // A claim a current runner marked is never listed, and the mark is read from
  // the claim's own audit row (filtered in code: a SQL "not equal" would skip
  // a row whose key is missing, which is the very claim this lists).
  assert.ok(list.includes("claimAudit: { select: { metadata: true } }"));
  assert.ok(list.includes("AMUX_V19_MAX_CLAIM_RUNNER_MARKER"));
  assert.ok(list.includes("!marked(row.claimAudit.metadata)"));
  assert.doesNotMatch(list, /\btake:/, "no count limit");
  assert.doesNotMatch(list,
    /\.(?:create|update|updateMany|upsert|delete|deleteMany)\(|writeSystemAuditLog/);
  for (const forbidden of ["prompt", "ciphertext", "inputTokens", "outputTokens"]) {
    assert.doesNotMatch(list, new RegExp(forbidden), forbidden);
  }
});
