import assert from "node:assert/strict";
import test from "node:test";

import { isAmuxIdeaRequestId } from "@/lib/amux/ideaRequestIdCore";
import { AMUX_IDEA_RESUBMIT_SOURCE, amuxIdeaResubmitRequestId,
  inspectAmuxIdeaResubmission, runAmuxIdeaResubmit,
  type AmuxIdeaResubmitSteps } from "@/lib/amux/ideaSessionResubmitCore";
import type { IdeaInput } from "@/lib/amux/ideaInputCore";

const OLD = "0f0e0d0c-0b0a-4909-8807-060504030201";
const NEW = "11111111-2222-4333-8444-555555555555";
const input: IdeaInput = { version: 1, idea: "Show the price before the run.",
  repositories: ["mposition/Tomverse"], pullRequests: [] };

/** A fake intake that records calls in order and keeps one row per request id. */
function fake(overrides: Partial<AmuxIdeaResubmitSteps> = {}) {
  const calls: string[] = [];
  const stored = new Map<string, string>();
  const steps: AmuxIdeaResubmitSteps = {
    readBack: async (requestId) => {
      calls.push("readBack");
      const ideaId = stored.get(requestId);
      return ideaId ? { status: "committed", ideaId } : { status: "absent" };
    },
    readInput: async () => { calls.push("readInput"); return { ok: true, input }; },
    submit: async (requestId) => {
      calls.push("submit");
      stored.set(requestId, NEW);
      return { ideaId: NEW };
    },
    close: async () => { calls.push("close"); return true; },
    ...overrides,
  };
  return { calls, stored, steps };
}

test("the resubmit request id is a fixed UUID v4 of the old idea, never its own id", () => {
  const id = amuxIdeaResubmitRequestId(OLD);
  assert.equal(isAmuxIdeaRequestId(id), true);
  assert.equal(id, amuxIdeaResubmitRequestId(OLD));
  assert.notEqual(id, OLD);
  assert.notEqual(id, amuxIdeaResubmitRequestId(NEW));
});

test("the resubmission carries the same idea and references under the resubmit labels", () => {
  const inspected = inspectAmuxIdeaResubmission(amuxIdeaResubmitRequestId(OLD),
    { ...input, pullRequests: [{ repository: "mposition/Tomverse", number: 7 }] });
  assert.equal(inspected.ok, true);
  if (!inspected.ok) return;
  assert.deepEqual(inspected.input, { version: 1, idea: input.idea,
    repositories: ["mposition/Tomverse"],
    pullRequests: [{ repository: "mposition/Tomverse", number: 7 }] });
  assert.deepEqual(inspected.source, AMUX_IDEA_RESUBMIT_SOURCE);
  assert.equal(inspected.requestId, amuxIdeaResubmitRequestId(OLD));
});

test("reads the old idea, submits once, and closes it only after the new idea is in", async () => {
  const { calls, steps } = fake();
  assert.deepEqual(await runAmuxIdeaResubmit(steps, OLD), { result: "resubmitted",
    ideaId: NEW, requestId: amuxIdeaResubmitRequestId(OLD), previousClosed: true });
  assert.deepEqual(calls, ["readBack", "readInput", "submit", "close"]);
});

test("a second click finds the committed idea and only finishes the close", async () => {
  const { calls, steps } = fake();
  await runAmuxIdeaResubmit(steps, OLD);
  calls.length = 0;
  const again = await runAmuxIdeaResubmit(steps, OLD);
  assert.equal(again.result, "resubmitted");
  assert.deepEqual(calls, ["readBack", "close"]);
});

test("an unknown write is read back by its request id, never sent again", async () => {
  let submits = 0;
  const committed = fake({ submit: async () => { submits += 1;
    committed.stored.set(amuxIdeaResubmitRequestId(OLD), NEW); throw new Error("lost"); } });
  assert.equal((await runAmuxIdeaResubmit(committed.steps, OLD)).result, "resubmitted");
  assert.deepEqual(committed.calls, ["readBack", "readInput", "readBack", "close"]);
  assert.equal(submits, 1);

  const absent = fake({ submit: async () => { throw new Error("lost"); } });
  assert.deepEqual(await runAmuxIdeaResubmit(absent.steps, OLD), { result: "outcome_unknown" });
  assert.equal(absent.calls.includes("close"), false);

  const partial = fake({ readBack: async () => ({ status: "partial", ideaId: NEW }) });
  assert.deepEqual(await runAmuxIdeaResubmit(partial.steps, OLD), { result: "outcome_unknown" });
  assert.deepEqual(partial.calls, []);
});

test("a refusal or an idea that cannot be resubmitted closes nothing", async () => {
  for (const reason of ["not_found", "not_resubmittable", "raw_purged"] as const) {
    const run = fake({ readInput: async () => ({ ok: false, reason }) });
    assert.deepEqual(await runAmuxIdeaResubmit(run.steps, OLD), { result: reason });
    assert.deepEqual(run.calls, ["readBack"]);
  }
  const refused = fake({ submit: async () => ({ refused: "outside_scope" }) });
  assert.deepEqual(await runAmuxIdeaResubmit(refused.steps, OLD),
    { result: "refused", code: "outside_scope" });
  assert.equal(refused.calls.includes("close"), false);
});

test("a failed close still reports the new idea, with the old one left open", async () => {
  const run = fake({ close: async () => { throw new Error("close lost"); } });
  assert.deepEqual(await runAmuxIdeaResubmit(run.steps, OLD), { result: "resubmitted",
    ideaId: NEW, requestId: amuxIdeaResubmitRequestId(OLD), previousClosed: false });
});
