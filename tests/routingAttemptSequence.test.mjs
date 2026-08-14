import assert from "node:assert/strict";
import test from "node:test";

import { runAttemptSequence } from "../lib/routingAttemptSequence.ts";
import { splitRoutingRetrySignal } from "../lib/routingRetrySignal.ts";

/**
 * Step 1 of the rollout note's §9.1: the fallback swap driven by a double,
 * before any real provider exists.
 *
 * The double is a scripted reader. Each attempt is given a list of actions and
 * performs them in order, so "the first reader raises a pre-token error and
 * the second succeeds" is a literal fixture rather than a fault injected into
 * a live provider and hoped for.
 */

/**
 * @param {Array<{ text?: string, throws?: unknown, done?: true }>} script
 */
const scriptedReader = (script) => {
  let index = 0;
  const reader = {
    cancelled: false,
    cancelReason: undefined,
    async read() {
      const step = script[index];
      index += 1;
      if (!step || step.done) return { done: true };
      if (step.throws) throw step.throws;
      return { done: false, value: step.text };
    },
    async cancel(reason) {
      reader.cancelled = true;
      reader.cancelReason = reason;
    },
  };
  return reader;
};

/** A run built from one script per attempt, in the order they are dispatched. */
const runWith = async (attemptScripts, overrides = {}) => {
  const emitted = [];
  const readers = [];
  const dispatched = [];
  let open = true;

  const result = await runAttemptSequence({
    primaryModelId: "gpt-5-6-luna",
    startAttempt: async ({ modelId, attemptIndex, plannerMode }) => {
      dispatched.push({ modelId, attemptIndex, plannerMode });
      const script = attemptScripts[attemptIndex];
      if (typeof script === "function") return script({ modelId, attemptIndex });
      const reader = scriptedReader(script ?? [{ done: true }]);
      readers.push(reader);
      return {
        started: true,
        execution: {
          modelId,
          provider: "openai",
          plannerMode,
          reader,
          complete: overrides.complete,
        },
      };
    },
    nextCandidateModelIds: (attempted) =>
      (overrides.candidates ?? ["deepseek-v4-flash", "claude-5-2-sonnet"]).filter(
        (candidate) => !attempted.includes(candidate)
      ),
    emit: (chunk) => {
      emitted.push(chunk);
      if (overrides.rejectEmitAt !== undefined && emitted.length > overrides.rejectEmitAt) {
        return false;
      }
      return true;
    },
    downstreamOpen: () => (overrides.downstreamOpen ? overrides.downstreamOpen() : open),
    plannerMode: overrides.plannerMode,
    onAttemptSettled: overrides.onAttemptSettled,
  });

  return {
    result,
    emitted,
    readers,
    dispatched,
    close: () => {
      open = false;
    },
    /** What the user would actually read, signal stripped. */
    visibleText: splitRoutingRetrySignal(emitted.join("")).text,
    signal: splitRoutingRetrySignal(emitted.join("")).signal,
  };
};

const providerFailure = Object.assign(new Error("upstream unavailable"), {
  name: "APICallError",
  statusCode: 503,
});

test("one model that answers is one attempt and no signal", async () => {
  const { result, emitted, dispatched, signal } = await runWith([
    [{ text: "Hello" }, { text: " world" }, { done: true }],
  ]);

  assert.equal(result.stop.kind, "succeeded");
  assert.equal(result.succeededModelId, "gpt-5-6-luna");
  assert.equal(result.rerouteCount, 0);
  assert.equal(result.displacedModelId, null);
  assert.equal(result.fallbackState, "none");
  assert.deepEqual(emitted, ["Hello", " world"]);
  assert.equal(signal, null);
  assert.equal(dispatched.length, 1);
});

// The case the whole step exists for.
test("a pre-token provider failure is answered by the next candidate", async () => {
  const { result, readers, dispatched, visibleText, signal } = await runWith([
    [{ throws: providerFailure }],
    [{ text: "Hello from the fallback" }, { done: true }],
  ]);

  assert.equal(result.stop.kind, "succeeded");
  assert.equal(result.succeededModelId, "deepseek-v4-flash");
  assert.equal(result.displacedModelId, "gpt-5-6-luna");
  assert.equal(result.rerouteCount, 1);
  assert.equal(result.fallbackState, "fallback_used");

  // §5: an independent attempt, numbered, with its own preparation.
  assert.deepEqual(
    dispatched.map((entry) => [entry.attemptIndex, entry.modelId]),
    [
      [0, "gpt-5-6-luna"],
      [1, "deepseek-v4-flash"],
    ]
  );

  // §7: the client is told, and told only a model id.
  assert.deepEqual(signal, {
    state: "retrying_with_another_model",
    modelId: "deepseek-v4-flash",
  });
  assert.equal(visibleText, "Hello from the fallback");

  // The failed provider stream does not stay open next to the one that
  // replaced it.
  assert.equal(readers[0].cancelled, true);
});

test("the retry signal carries nothing of the provider's error", async () => {
  const { emitted } = await runWith([
    [
      {
        throws: Object.assign(new Error("openai says: quota for org-abc exceeded"), {
          statusCode: 503,
        }),
      },
    ],
    [{ text: "ok" }, { done: true }],
  ]);
  const wire = emitted.join("");
  assert.equal(wire.includes("openai says"), false);
  assert.equal(wire.includes("org-abc"), false);
});

// §7's rule with the most user-visible consequence.
test("nothing is substituted once the user has seen a token", async () => {
  const { result, dispatched, visibleText } = await runWith([
    [{ text: "Once upon a" }, { throws: providerFailure }],
    [{ text: "SHOULD NOT RUN" }, { done: true }],
  ]);

  assert.equal(result.stop.kind, "refused");
  assert.equal(result.stop.reason, "visible_token_emitted");
  assert.equal(dispatched.length, 1);
  // The partial response is preserved, exactly as it was read.
  assert.equal(visibleText, "Once upon a");
  assert.equal(result.visibleTokenEmitted, true);
});

test("a disconnected client ends the turn instead of starting another attempt", async () => {
  let open = true;
  const { result, dispatched } = await runWith(
    [[{ throws: providerFailure }], [{ text: "SHOULD NOT RUN" }, { done: true }]],
    {
      downstreamOpen: () => {
        open = false;
        return open;
      },
    }
  );

  assert.equal(result.stop.kind, "refused");
  assert.equal(result.stop.reason, "cancelled");
  assert.equal(dispatched.length, 1);
});

test("a fallback that fails too does not go looking for a third model", async () => {
  const { result, dispatched } = await runWith([
    [{ throws: providerFailure }],
    [{ throws: providerFailure }],
    [{ text: "SHOULD NOT RUN" }, { done: true }],
  ]);

  assert.equal(result.stop.kind, "refused");
  // §6's two-build budget, spent.
  assert.equal(result.stop.reason, "build_budget_exhausted");
  assert.equal(dispatched.length, 2);
  assert.equal(result.succeededModelId, null);
  assert.equal(result.fallbackState, "exhausted");
  assert.equal(result.error, providerFailure);
});

test("a fallback cancelled mid-stream keeps what it had shown", async () => {
  const { result, visibleText } = await runWith([
    [{ throws: providerFailure }],
    [
      { text: "Partial answer" },
      { throws: Object.assign(new Error("aborted"), { name: "AbortError" }) },
    ],
  ]);

  assert.equal(result.stop.kind, "refused");
  assert.equal(result.stop.reason, "visible_token_emitted");
  assert.equal(visibleText, "Partial answer");
  assert.equal(result.succeededModelId, null);
  // §8 has nothing to record: no model finished, so none displaced another.
  assert.equal(result.displacedModelId, null);
});

test("a candidate whose own preparation refuses is not dispatched", async () => {
  // §5: the fallback candidate needs its own draft, adapter serialization,
  // token check and manifest. A manifest failure there fails closed.
  const { result, dispatched } = await runWith([
    [{ throws: providerFailure }],
    () => ({ started: false, failureLayer: "manifest" }),
  ]);

  assert.equal(result.stop.kind, "refused");
  assert.equal(result.stop.reason, "fail_closed_layer");
  assert.equal(result.attempts[1].outcome, "not_dispatched");
  assert.equal(result.attempts[1].provider, null);
  assert.equal(dispatched.length, 2);
});

test("an adapter failure on the primary falls back without a provider call", async () => {
  const { result } = await runWith([
    () => ({ started: false, failureLayer: "adapter" }),
    [{ text: "answered" }, { done: true }],
  ]);

  assert.equal(result.stop.kind, "succeeded");
  assert.equal(result.attempts[0].outcome, "not_dispatched");
  assert.equal(result.succeededModelId, "deepseek-v4-flash");
});

test("an empty stream is a successful call, not a reason to try another model", async () => {
  // Deliberately: an empty completion is model-scoped and the chat route
  // already handles it as AI_EMPTY_RESPONSE. A second, quieter policy for it
  // here is exactly what this assertion is here to prevent.
  const { result, dispatched } = await runWith([[{ done: true }]]);

  assert.equal(result.stop.kind, "succeeded");
  assert.equal(result.attempts[0].emptyResponse, true);
  assert.equal(dispatched.length, 1);
});

test("a completion-handling failure is not blamed on the model", async () => {
  const { result, dispatched } = await runWith(
    [[{ text: "answer" }, { done: true }], [{ text: "SHOULD NOT RUN" }, { done: true }]],
    {
      complete: async () => {
        throw new Error("settlement write failed");
      },
    }
  );

  assert.equal(result.stop.kind, "refused");
  assert.equal(result.stop.reason, "visible_token_emitted");
  assert.equal(result.attempts[0].failureLayer, "stream");
  assert.equal(dispatched.length, 1);
});

test("a completion failure with nothing shown still fails closed", async () => {
  const { result, dispatched } = await runWith([[{ done: true }]], {
    complete: async () => {
      throw new Error("usage read failed");
    },
  });

  assert.equal(result.stop.kind, "refused");
  assert.equal(result.stop.reason, "fail_closed_layer");
  assert.equal(result.attempts[0].outcome, "failed_pre_token");
  assert.equal(result.attempts[0].failureLayer, "stream");
  assert.equal(dispatched.length, 1);
});

test("a client that stops accepting mid-stream is not a provider failure", async () => {
  const { result, readers } = await runWith(
    [[{ text: "one" }, { text: "two" }, { done: true }], [{ text: "SHOULD NOT RUN" }]],
    { rejectEmitAt: 1 }
  );

  assert.equal(result.stop.kind, "refused");
  assert.equal(result.stop.reason, "visible_token_emitted");
  assert.equal(result.attempts[0].failureLayer, "stream");
  assert.equal(readers[0].cancelled, true);
});

test("an empty candidate list ends the turn rather than repeating a model", async () => {
  const { result, dispatched } = await runWith([[{ throws: providerFailure }]], {
    candidates: [],
  });

  assert.equal(result.stop.kind, "refused");
  assert.equal(result.stop.reason, "no_candidate");
  assert.equal(dispatched.length, 1);
});

test("the candidate list never offers a model already attempted", async () => {
  const seen = [];
  await runAttemptSequence({
    primaryModelId: "gpt-5-6-luna",
    startAttempt: async ({ modelId }) => ({
      started: true,
      execution: {
        modelId,
        provider: "openai",
        plannerMode: "planned",
        reader: scriptedReader([{ throws: providerFailure }]),
      },
    }),
    nextCandidateModelIds: (attempted) => {
      seen.push([...attempted]);
      return ["gpt-5-6-luna", "deepseek-v4-flash"].filter(
        (candidate) => !attempted.includes(candidate)
      );
    },
    emit: () => true,
    downstreamOpen: () => true,
  });

  assert.deepEqual(seen[0], ["gpt-5-6-luna"]);
  assert.deepEqual(seen[1], ["gpt-5-6-luna", "deepseek-v4-flash"]);
});

test("a pass-through is refused by name rather than silently skipped", async () => {
  // Nothing reaches this in the shipped configuration: the Planner is "none"
  // and ROUTING_PLANNER_FAILURE_MODE defaults to fail_closed. The assertion is
  // about what happens when it stops being unreachable.
  const { result, dispatched } = await runWith(
    [() => ({ started: false, failureLayer: "planner" }), [{ text: "SHOULD NOT RUN" }]],
    { plannerMode: "pass_through_once" }
  );

  assert.equal(result.stop.kind, "pass_through_unavailable");
  assert.equal(result.stop.modelId, "gpt-5-6-luna");
  assert.equal(dispatched.length, 1);
});

test("a planner failure fails closed in the shipped configuration", async () => {
  const { result } = await runWith(
    [() => ({ started: false, failureLayer: "planner" }), [{ text: "SHOULD NOT RUN" }]],
    { plannerMode: "fail_closed" }
  );

  assert.equal(result.stop.kind, "refused");
  assert.equal(result.stop.reason, "planner_fail_closed");
});

test("every attempt is reported once, in order, before the run returns", async () => {
  const settled = [];
  const { result } = await runWith(
    [[{ throws: providerFailure }], [{ text: "answered" }, { done: true }]],
    { onAttemptSettled: (record) => settled.push(record) }
  );

  assert.deepEqual(
    settled.map((record) => [record.attemptIndex, record.modelId, record.outcome]),
    [
      [0, "gpt-5-6-luna", "failed_pre_token"],
      [1, "deepseek-v4-flash", "succeeded"],
    ]
  );
  assert.deepEqual(settled, result.attempts);
});

test("a safety refusal is not routed around", async () => {
  const { result, dispatched } = await runWith([
    [{ throws: Object.assign(new Error("blocked: content_policy"), { statusCode: 400 }) }],
    [{ text: "SHOULD NOT RUN" }, { done: true }],
  ]);

  assert.equal(result.stop.kind, "refused");
  assert.equal(result.stop.reason, "provider_policy_rejection");
  assert.equal(result.attempts[0].providerRefusal, "policy");
  assert.equal(dispatched.length, 1);
});

test("the double can tell a run that fell back from one that did not", async () => {
  // A negative control for the fixture itself. If the scripted reader could
  // not fail, every assertion above would pass against a loop that never
  // retried anything.
  const never = await runWith([[{ text: "fine" }, { done: true }]]);
  assert.equal(never.dispatched.length, 1);

  const once = await runWith([
    [{ throws: providerFailure }],
    [{ text: "fine" }, { done: true }],
  ]);
  assert.equal(once.dispatched.length, 2);
  assert.notEqual(once.signal, null);
});
