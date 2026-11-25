import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationRecord } from "../../tomverse-cli/src/session.js";
import { journalApiUsage } from "../src/host/journal-view";

test("API usage totals cover older receipts and preserve missing and foreign receipts as unconfirmed", () => {
  const now = "2026-11-23T04:00:00.000Z";
  const generations = Array.from({ length: 84 }, (_, index): GenerationRecord => {
    const seq = index + 1;
    const requestId = `req_${seq.toString(16).padStart(32, "0")}`;
    return {
      seq, purpose: seq === 1 ? "compact" : "agent", state: "complete", createdAt: now, updatedAt: now, idempotencyKey: String(seq),
      requestId, closed: true, lookup: "found",
      receipt: { requestId, modelId: "fixture-model", protocol: "chat_completions", status: "settled", outcome: null,
        heldCredits: 0, chargedCredits: 3, finishReason: null, errorCode: null, createdAt: now, completedAt: now, usage: null },
    };
  });
  const [settled, held, foreign, missing] = generations;
  assert.ok(settled && held && foreign && missing);
  Object.assign(held.receipt!, { status: "held", heldCredits: 7, chargedCredits: null });
  Object.assign(foreign.receipt!, { requestId: settled.requestId, chargedCredits: 999 });
  missing.receipt = null;
  const refused = generations.at(-1)!;
  Object.assign(refused.receipt!, { status: "released", chargedCredits: 0 });
  Object.assign(refused, { state: "headers", httpStatus: 429, error: { kind: "http", code: "key_credit_cap_reached" } });
  const result = journalApiUsage({ id: "fixture-task", generations });
  assert.deepEqual(result.apiUsage, { requestCount: 84, settled: 240, held: 7, unknown: 2 });
  assert.equal(result.transmission.length, 80);
  assert.equal(result.transmission[0]?.seq, 5);
  assert.deepEqual(result.transmission.at(-1)?.quota,
    { source: "tomverse_api", requestId: refused.requestId, reason: "key_credit_cap_reached" });
  assert.equal(result.transmission.at(-1)?.segmentId, "fixture-task");
});
