import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// Owner direction 2026-11-15: a session analysis answer is not refused for its
// size below the 4 MiB safety ceiling. The route must read such an answer and
// hand it to the result preflight.
const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const preflights: Array<{ bytes: number }> = [];
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  $transaction: async () => { throw new Error("synthetic preflight stop"); },
} } });
mock.module(mod("lib/amux/ideaSessionAnalysisResultService.ts"), { namedExports: {
  AmuxMaxSessionResultError: class extends Error {},
  commitAmuxMaxSessionResult: async () => { throw new Error("not reached"); },
  preflightAmuxMaxSessionResult: async (_tx: unknown, body: { rawModelOutput: string }) => {
    preflights.push({ bytes: Buffer.byteLength(body.rawModelOutput, "utf8") });
  },
  readAmuxMaxSessionResultReceipt: async () => ({ status: "absent" }),
} });
const loader = import(mod("app/api/internal/amux/v19/session-analysis-result/route.ts"));
// lib/amux/ideaSessionMaxLauncherAuth.ts AMUX_V19_MAX_LAUNCHER_ID.
const launcher = import(mod("lib/amux/ideaSessionMaxLauncherAuth.ts"));
let AMUX_V19_MAX_LAUNCHER_ID = "";

const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const switches = {
  TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret,
  TOMVERSE_AMUX_V19_SESSION_ANALYSIS_RESULT_RETENTION: "enabled",
  TOMVERSE_AMUX_V19_READ_MANIFEST_RETENTION: "enabled",
};
const body = (rawModelOutput: string) => ({
  claimId: "9942fb52-4b78-4af6-931a-9eec8f66d394",
  requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
  reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
  ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
  invocationOrdinal: 0, referenceOrdinal: 0,
  evidenceId: "0c8b1b8e-5f0a-4a43-9a62-4d3e4f6b8d11",
  manifestId: "1d9c2c9f-6a1b-4b54-8b73-5e4f5a7c9e22",
  rawModelOutput, inputTokens: 1_000, outputTokens: 400_000,
  cliAttestation: { provider: "anthropic", modelAttestation: "served", cliSha256: "a".repeat(64) },
});
const request = (value: unknown) => new Request("https://test.invalid/api/internal/amux/v19/session-analysis-result", {
  method: "POST",
  headers: { authorization: `Bearer ${secret}`, "x-amux-agent-id": AMUX_V19_MAX_LAUNCHER_ID,
    "content-type": "application/json" },
  body: JSON.stringify(value),
});

async function withEnv(values: Record<string, string>, run: () => Promise<void>) {
  const keys = Object.keys(switches);
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    await run();
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
}

test("an answer past the former 64 KiB reaches the result preflight", async () => {
  const { POST } = await loader;
  ({ AMUX_V19_MAX_LAUNCHER_ID } = await launcher);
  const answer =JSON.stringify({ units: [], note: "x".repeat(900_000) });
  await withEnv(switches, async () => {
    preflights.length = 0;
    const response = await POST(request(body(answer)));
    // The synthetic preflight stop answers not_ready, never a size refusal.
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "not_ready");
  });
  await withEnv(switches, async () => {
    const response = await POST(request(body("x".repeat(4 * 1024 * 1024 + 1))));
    assert.equal(response.status, 400);
  });
});
