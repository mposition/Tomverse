import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const token = "synthetic-runner-token-with-at-least-32-characters";
const requestId = "11111111-1111-4111-8111-111111111111";
let writes = 0;
let writeError = false;
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
          if (writeError) throw new Error("private database detail");
          return { requestId, slotIndex: 0,
            slotConsumptionAuditLogId: "synthetic-slot-audit",
            reservationConsumed: true, dispatchAuthorized: false };
        },
      },
    });
    routePromise = import(mod("app/api/internal/prompt-refiner/vnext-one-shot-slot/route.ts"));
  }
  return routePromise;
}

const request = (authorization = `Bearer ${token}`, body: object = {
  requestId, slotIndex: 0, runApprovalAuditLogId: "synthetic-run-audit",
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
  try {
    delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED = "1";
    const missing = await route.POST(request());
    assert.equal(missing.status, 404);
    noStore(missing);
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = token;
    const wrong = await route.POST(request(`Bearer ${"x".repeat(48)}`));
    assert.equal(wrong.status, 404);
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
  }
});

test("strict input and failure response never claim dispatch or expose private errors", async () => {
  const route = await loadRoute();
  const oldToken = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
  const oldFlag = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED;
  try {
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = token;
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED = "1";
    const malformed = await route.POST(request(`Bearer ${token}`, {
      requestId, slotIndex: 80, runApprovalAuditLogId: "synthetic-run-audit",
    }));
    assert.equal(malformed.status, 400);
    noStore(malformed);
    assert.equal(writes, 0);
    const success = await route.POST(request());
    assert.equal(success.status, 201);
    noStore(success);
    assert.deepEqual(await success.json(), { requestId, slotIndex: 0,
      slotConsumptionAuditLogId: "synthetic-slot-audit",
      reservationConsumed: true, dispatchAuthorized: false });
    writeError = true;
    const unavailable = await route.POST(request());
    assert.equal(unavailable.status, 503);
    noStore(unavailable);
    assert.deepEqual(await unavailable.json(), { code: "SLOT_CONSUMPTION_UNAVAILABLE" });
    assert.equal(writes, 2);
  } finally {
    writeError = false;
    if (oldToken === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
    else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = oldToken;
    if (oldFlag === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED;
    else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED = oldFlag;
  }
});
