import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const captures = [];

mock.module("@sentry/nextjs", {
  namedExports: {
    captureException: (error, hint) => {
      captures.push({ error, tags: hint?.tags });
      return "event-id";
    },
  },
});
mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: { traceErrorEvidence: { create: async () => ({}) } },
  },
});

const { issueChatErrorReportGrant, resetTraceEvidenceWriteBudgetForTests } =
  await import(mod("lib/traceErrorEvidence.ts"));

test.beforeEach(() => {
  captures.length = 0;
  resetTraceEvidenceWriteBudgetForTests();
});

const failure = (overrides = {}) => ({
  traceId: "00000000-0000-4000-8000-000000000001",
  routeClass: "chat",
  errorCode: "AI_STREAM_FAILED.AI_APICallError_HTTP_400",
  httpStatus: 200,
  phase: "stream",
  error: new Error("AI_APICallError HTTP_400"),
  ...overrides,
});

test("a chat stream failure reaches Sentry tagged with its provider and model", () => {
  issueChatErrorReportGrant(failure({ provider: "xai", modelId: "grok-example" }));
  assert.equal(captures.length, 1);
  assert.equal(captures[0].tags.provider, "xai");
  assert.equal(captures[0].tags.modelId, "grok-example");
  assert.equal(captures[0].tags.routeClass, "chat");
  assert.equal(captures[0].tags.errorCode, "AI_STREAM_FAILED.AI_APICallError_HTTP_400");
});

test("a failure with no known provider or model adds no empty tags", () => {
  issueChatErrorReportGrant(failure({ provider: null, modelId: null }));
  assert.equal(captures.length, 1);
  assert.ok(!("provider" in captures[0].tags));
  assert.ok(!("modelId" in captures[0].tags));
});

test("tag values are bounded", () => {
  issueChatErrorReportGrant(failure({ provider: "p".repeat(500), modelId: "m".repeat(500) }));
  assert.equal(captures[0].tags.provider.length, 100);
  assert.equal(captures[0].tags.modelId.length, 100);
});
