import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { ZodError } from "zod";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let writes = 0;
let lastInput: Record<string, unknown> | null = null;

mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  readLimitedJson: async (request: Request, _limit: number,
    schema: { parse: (value: unknown) => unknown }) =>
    schema.parse(await request.json()),
  apiSecurityResponse: (error: unknown) => error instanceof ZodError
    ? Response.json({ code: "INVALID_INPUT" }, { status: 400 }) : null,
} });
mock.module(mod("lib/promptRefinerVnextOneShotTerminalReceipt.ts"), {
  namedExports: { recordPromptRefinerVnextOneShotTerminal: async (
    input: Record<string, unknown>) => {
    writes++;
    lastInput = input;
    return { terminalAuditLogId: "synthetic-terminal-audit",
      requestId: input.requestId, slotIndex: input.slotIndex,
      observedCostMicroUsd: input.observedCostMicroUsd,
      dispatchAuthorized: false };
  } },
});

const token = "synthetic-runner-token-with-at-least-32-characters";
const body = { requestId: "11111111-1111-4111-8111-111111111111",
  slotIndex: 0, runApprovalAuditLogId: "synthetic-run-audit",
  slotConsumptionAuditLogId: "synthetic-slot-audit",
  resultKind: "failed", failureCode: "vnext_strict_parse_failure",
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0,
    cacheWriteInputTokens: 0, reasoningTokens: 0 },
  observedCostMicroUsd: 1, intentToTerminalLatencyMs: 10 };
const request = (value: unknown) => new Request(
  "https://example.test/api/internal/prompt-refiner/vnext-one-shot-terminal", {
    method: "POST", headers: { authorization: `Bearer ${token}`,
      "content-type": "application/json" }, body: JSON.stringify(value),
  });

test("terminal route accepts only a closed content-free failure code", async () => {
  const prior = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = token;
  try {
    const route = await import(mod(
      "app/api/internal/prompt-refiner/vnext-one-shot-terminal/route.ts"));
    assert.equal((await route.POST(request({ ...body,
      failureCode: "unrecognized" }))).status, 400);
    assert.equal((await route.POST(request({ ...body,
      output: "restricted-output" }))).status, 400);
    assert.equal(writes, 0);
    const response = await route.POST(request(body));
    assert.equal(response.status, 201);
    assert.equal(writes, 1);
    assert.deepEqual(lastInput, body);
    assert.equal(JSON.stringify(await response.json()).includes("failureCode"), false);
  } finally {
    if (prior === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
    else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = prior;
  }
});
