import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
const sampleId = "00000000-0000-4000-8000-000000000001";
const limits = [];
const recorded = [];

mock.module("@/lib/apiSecurity", { namedExports: {
  apiSecurityResponse: () => null,
  consumeApiRateLimit: async (_request, subject, scope, bucket, options) => {
    limits.push({ subject, scope, bucket, options });
  },
  readLimitedJson: async (request, _limit, schema) => schema.parse(await request.json()),
} });
mock.module("@/lib/requestOrigin", { namedExports: { hasValidMutationOrigin: () => true } });
mock.module("@/lib/responseLatencyToken", { namedExports: {
  verifyResponseLatencyToken: (token) => token === "signed"
    ? { id: sampleId, product: "chat", mode: "auto", modelId: null, provider: null } : null,
} });
mock.module("@/lib/responseLatencyStore", { namedExports: {
  recordResponseLatency: async (id, sample) => { recorded.push({ id, sample }); },
} });

const { POST } = await import(mod("app/api/chat/timing/route.ts"));

test("a client timing report is limited per signed sample, not per shared IP", async () => {
  const response = await POST(new Request("https://tomverse.test/api/chat/timing", {
    method: "POST", headers: { origin: "https://tomverse.test", "content-type": "application/json" },
    body: JSON.stringify({ token: "signed", outcome: "completed", prepareMs: 10,
      firstContentMs: 900, completionMs: 4_000, stages: {} }),
  }));
  assert.equal(response.status, 204);
  assert.deepEqual(limits, [{ subject: sampleId, scope: "response-latency",
    bucket: { minute: 6, day: 12 }, options: { skipIpBucket: true } }]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].id, `${sampleId}:client`);
  assert.equal(recorded[0].sample.source, "client");
});
