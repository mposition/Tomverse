import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const secret = ["synthetic", "retention", "secret", "0123456789"].join("-");
const envNames = ["TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET",
  "TOMVERSE_AMUX_V4_CONTENT_RETENTION",
  "TOMVERSE_AMUX_V4_COLLECTION_AGENT_SECRET", "TOMVERSE_AMUX_SYNC_SECRET",
  "TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET"] as const;
const priorEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
let calls: string[] = [];
let manifestFailure = false;
const counts = { bodiesPurged: 0, keysDeleted: 0, scanned: 0, batchLimit: 8 };

mock.module(mod("lib/amux/ideaRetentionHoldNoticeService.ts"), { namedExports: {
  notifyDueAmuxRetentionHolds: async () => {
    calls.push("holds");
    return { sent: 0, scanned: 0, batchLimit: 8 };
  },
} });
mock.module(mod("lib/amux/ideaRawRetentionService.ts"), { namedExports: {
  cancelOverdueAmuxIdeaAnalyses: async () => {
    calls.push("cancellation");
    return { cancelled: 0, scanned: 0, batchLimit: 8 };
  },
  purgeDueAmuxRawIdeas: async () => { calls.push("raw"); return counts; },
} });
mock.module(mod("lib/amux/ideaTrackedCheckoutReadManifestRetention.ts"), {
  namedExports: { purgeDueAmuxReadManifests: async () => {
    calls.push("read-manifests");
    if (manifestFailure) throw new Error("synthetic external key outcome unknown");
    return counts;
  } },
});
mock.module(mod("lib/amux/ideaAnalysisContentPurgeService.ts"), { namedExports: {
  purgeDueAmuxAnalysisContent: async () => {
    calls.push("analysis");
    return counts;
  },
} });
mock.module(mod("lib/amux/v22TaskResultRetention.ts"), { namedExports: {
  purgeDueAmuxV22TaskResults: async () => {
    throw new Error("v22 retention must remain disabled");
  },
} });

let route: typeof import("../../app/api/internal/amux/v4/content-retention/route.ts");
before(async () => { route = await import(mod(
  "app/api/internal/amux/v4/content-retention/route.ts")); });
after(() => {
  for (const name of envNames) {
    const value = priorEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const request = () => new Request(
  "https://tomverse.test/api/internal/amux/v4/content-retention", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`,
      "x-amux-agent-id": "amux-v4-intake-retention",
      "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1 }),
  });
const enable = () => {
  calls = [];
  manifestFailure = false;
  process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET = secret;
  process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION = "enabled";
  delete process.env.TOMVERSE_AMUX_V4_COLLECTION_AGENT_SECRET;
  delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
  delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET;
};

test("retention tick purges read manifests and preserves the deployed response shape", async () => {
  enable();
  const response = await route.POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["holds", "cancellation", "raw", "read-manifests", "analysis"]);
  assert.deepEqual(await response.json(), {
    holdNotices: { sent: 0, scanned: 0, batchLimit: 8 },
    cancellation: { cancelled: 0, scanned: 0, batchLimit: 8 },
    raw: counts, analysis: counts,
    taskResults: { available: false, reason: "v22_task_result_retention_disabled" },
  });
});

test("unknown manifest key outcome halts the tick without exposing key details", async () => {
  enable();
  manifestFailure = true;
  const response = await route.POST(request());
  assert.equal(response.status, 503);
  assert.deepEqual(calls, ["holds", "cancellation", "raw", "read-manifests"]);
  assert.deepEqual(await response.json(), {
    error: "content_retention_outcome_unknown", retry: false,
  });
});
