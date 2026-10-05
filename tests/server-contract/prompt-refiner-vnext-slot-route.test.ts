import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const token = "synthetic-runner-token-with-at-least-32-characters";
const manifestRoot = "ab".repeat(32);
const runnerDigest = "cd".repeat(32);
const requestId = "11111111-1111-4111-8111-111111111111";
let writes = 0;
let writeErrorCode: string | null = null;
let routePromise: Promise<{ POST: (request: Request) => Promise<Response> }> | null = null;

function loadRoute() {
  if (!routePromise) {
    mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
      apiSecurityResponse: (error: unknown) =>
        error instanceof z.ZodError
          ? Response.json({ code: "INVALID_REQUEST" }, { status: 400 })
          : null,
      readLimitedJson: async (request: Request, maxBytes: number,
        schema: { parse: (value: unknown) => unknown }) => {
        const text = await request.text();
        if (Buffer.byteLength(text) > maxBytes) throw new Error("too large");
        return schema.parse(JSON.parse(text));
      },
    } });
    mock.module(mod("lib/promptRefinerVnextOneShotSlotConsumption.ts"), {
      namedExports: {
        consumePromptRefinerVnextOneShotSlot: async (input: {
          requestId: string; slotIndex: number; runApprovalAuditLogId: string;
        }) => {
          writes++;
          assert.deepEqual(input, { requestId, slotIndex: 0,
            runApprovalAuditLogId: "synthetic-run-audit" });
          if (writeErrorCode) throw new Error(writeErrorCode);
          return { requestId, slotIndex: 0,
            slotConsumptionAuditLogId: "synthetic-slot-audit",
            reservationConsumed: true, dispatchAuthorized: false,
            futureInternalField: "must-not-appear-in-runner-receipt" };
        },
      },
    });
    routePromise = import(mod("app/api/internal/prompt-refiner/vnext-one-shot-slot/route.ts"));
  }
  return routePromise;
}

const request = (authorization = `Bearer ${token}`, body: object = {
  requestId, slotIndex: 0, runApprovalAuditLogId: "synthetic-run-audit",
  manifestRoot, runnerDigest,
}) => new Request("https://example.test/api/internal/prompt-refiner/vnext-one-shot-slot", {
  method: "POST",
  headers: { authorization, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const noStore = (response: Response) =>
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");

test("slot consumption is default-off and only the dedicated runner token can call it", async () => {
  const route = await loadRoute();
  const oldToken = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
  const oldFlag = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED;
  const oldDispatch = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED;
  try {
    delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED = "1";
    const missing = await route.POST(request());
    assert.equal(missing.status, 404);
    noStore(missing);
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = token;
    delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED;
    const wrong = await route.POST(request(`Bearer ${"x".repeat(48)}`));
    assert.equal(wrong.status, 404);
    const dispatchDisabled = await route.POST(request());
    assert.equal(dispatchDisabled.status, 409);
    assert.deepEqual(await dispatchDisabled.json(), { code: "ONE_SHOT_DISPATCH_DISABLED" });
    delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED;
    const disabled = await route.POST(request());
    assert.equal(disabled.status, 409);
    noStore(disabled);
    assert.equal(writes, 0);
  } finally {
    if (oldToken === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
    else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = oldToken;
    if (oldFlag === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED;
    else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED = oldFlag;
    if (oldDispatch === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED;
    else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED = oldDispatch;
  }
});

test("strict input, fixed success receipt, and failures expose no private fields", async () => {
  const route = await loadRoute();
  const oldToken = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
  const oldFlag = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED;
  const oldDispatch = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED;
  const oldRoot = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT;
  const oldRunner = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
  try {
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = token;
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED = "1";
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED = "1";
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT = manifestRoot;
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = runnerDigest;
    const malformed = await route.POST(request(`Bearer ${token}`, {
      requestId, slotIndex: 80, runApprovalAuditLogId: "synthetic-run-audit",
    }));
    assert.equal(malformed.status, 400);
    noStore(malformed);
    assert.equal(writes, 0);
    const wrongPin = await route.POST(request(`Bearer ${token}`, {
      requestId, slotIndex: 0, runApprovalAuditLogId: "synthetic-run-audit",
      manifestRoot: "ee".repeat(32), runnerDigest,
    }));
    assert.equal(wrongPin.status, 409);
    assert.equal(writes, 0);
    const success = await route.POST(request());
    assert.equal(success.status, 201);
    noStore(success);
    assert.deepEqual(await success.json(), { requestId, slotIndex: 0,
      slotConsumptionAuditLogId: "synthetic-slot-audit",
      reservationConsumed: true, dispatchAuthorized: true });
    for (const code of [
      "vnext_one_shot_slot_request_invalid",
      "vnext_one_shot_slot_custody_pin_unavailable",
      "vnext_one_shot_slot_reservation_unavailable",
      "vnext_one_shot_slot_binding_mismatch",
      "vnext_one_shot_slot_already_consumed",
      "vnext_one_shot_slot_transition_conflict",
      "vnext_one_shot_shadow_evidence_unavailable",
    ]) {
      writeErrorCode = code;
      const refused = await route.POST(request());
      assert.equal(refused.status, 409, code);
      noStore(refused);
      assert.deepEqual(await refused.json(), { code: "SLOT_CONSUMPTION_REFUSED",
        retryAuthorized: false });
    }
    writeErrorCode = "private database detail";
    const unavailable = await route.POST(request());
    assert.equal(unavailable.status, 503);
    noStore(unavailable);
    assert.deepEqual(await unavailable.json(), {
      code: "SLOT_CONSUMPTION_OUTCOME_UNKNOWN", retryAuthorized: false,
      humanReviewRequired: true });
    assert.equal(writes, 9);
  } finally {
    writeErrorCode = null;
    if (oldToken === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
    else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = oldToken;
    if (oldFlag === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED;
    else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED = oldFlag;
    if (oldDispatch === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED;
    else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED = oldDispatch;
    if (oldRoot === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT;
    else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT = oldRoot;
    if (oldRunner === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
    else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = oldRunner;
  }
});
