import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
let calls = [];
let fail = null;
mock.module(mod("lib/promptRefinerVnextOneShotOutcomeRecovery.ts"), {
  namedExports: { stopPromptRefinerVnextOneShotUnknown: async (input) => {
    calls.push(input);
    if (fail) throw new Error(fail);
    return { stopAuditLogId: "synthetic-audit", reservationHeld: true,
      humanReviewRequired: true, retryAuthorized: false,
      dispatchAuthorized: false };
  } },
});
const { POST } = await import(mod(
  "app/api/internal/prompt-refiner/vnext-one-shot-stop/route.ts"));

const token = "t".repeat(40);
const prior = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = token;
test.after(() => {
  if (prior === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
  else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = prior;
});
const body = {
  requestId: "12345678-1234-1234-1234-123456789abc", slotIndex: 0,
  runApprovalAuditLogId: "run-audit", slotConsumptionAuditLogId: "consume-audit",
  reason: "timeout",
};
const request = (payload, bearer = token) => new Request("http://localhost/internal/stop", {
  method: "POST", headers: { "content-type": "application/json",
    authorization: `Bearer ${bearer}` }, body: JSON.stringify(payload),
});

test("runner stop route records a content-free unknown receipt exactly once", async () => {
  calls = [];
  const response = await POST(request(body));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(calls, [body]);
  assert.deepEqual(await response.json(), {
    stopAuditLogId: "synthetic-audit", reservationHeld: true,
    humanReviewRequired: true, retryAuthorized: false,
    dispatchAuthorized: false,
  });
});

test("invalid bearer and malformed body never reach the stop writer", async () => {
  calls = [];
  const unauthenticated = await POST(request(body, "wrong".repeat(8)));
  assert.equal(unauthenticated.status, 404);
  const malformed = await POST(request({ ...body, slotIndex: 80 }));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("cache-control"),
    "private, no-store, max-age=0");
  const extra = await POST(request({ ...body, sourceText: "never accepted" }));
  assert.equal(extra.status, 400);
  assert.equal(extra.headers.get("cache-control"),
    "private, no-store, max-age=0");
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
  try {
    assert.equal((await POST(request(body))).status, 404);
  } finally {
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = token;
  }
  assert.equal((await POST(request(body, "short"))).status, 404);
  assert.deepEqual(calls, []);
});

test("uncertain DB outcome is a no-retry human handoff", async () => {
  calls = [];
  fail = "synthetic_database_outcome_unknown";
  try {
    const response = await POST(request(body));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      code: "ONE_SHOT_STOP_OUTCOME_UNKNOWN",
      retryAuthorized: false, humanReviewRequired: true,
    });
    assert.equal(calls.length, 1);
  } finally {
    fail = null;
  }
});

test("definite stop refusal stays distinct from uncertain commit outcome", async () => {
  calls = [];
  fail = "vnext_one_shot_unknown_stage_not_running";
  try {
    const response = await POST(request(body));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      code: "ONE_SHOT_STOP_REFUSED",
      retryAuthorized: false, humanReviewRequired: true,
    });
    assert.equal(calls.length, 1);
  } finally {
    fail = null;
  }
});
