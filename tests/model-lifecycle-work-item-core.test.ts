import assert from "node:assert/strict";
import test from "node:test";
import {
  OPEN_WORK_ITEM_STATUSES,
  candidateIdentity,
  mergeObservedVia,
  newCandidatesForQueue,
  observationsForExistingItems,
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_STATUSES,
  workItemAgeDays,
  workItemForObservation,
  workItemTimestampField,
  workItemTransitionRefusal,
  type WorkItemStatus,
} from "../lib/modelLifecycleWorkItemCore.ts";

const move = (
  from: WorkItemStatus,
  to: WorkItemStatus,
  overrides: Partial<Parameters<typeof workItemTransitionRefusal>[0]> = {}
) =>
  workItemTransitionRefusal({
    from,
    to,
    hasDecision: true,
    pendingValidations: [],
    communicationRequired: false,
    actorEmail: "operator@tomverse.app",
    ...overrides,
  });

test("a discovered item survives the next scan", () => {
  // The measured failure: newCandidates is empty on the second run because the
  // catalogue row already exists, so nothing re-reports the model. The queue
  // has to answer "still waiting" rather than re-deriving from today's scan.
  assert.deepEqual(
    workItemForObservation({ existingStatus: null, alreadyInCatalogue: false }),
    { create: true, status: "discovered" }
  );
  assert.equal(
    workItemForObservation({
      existingStatus: "discovered",
      alreadyInCatalogue: false,
    }),
    null
  );
});

test("a second sighting never reopens a decision", () => {
  for (const status of ["rejected", "closed_no_action", "completed"] as const) {
    assert.equal(
      workItemForObservation({ existingStatus: status, alreadyInCatalogue: false }),
      null,
      `${status} must stay closed`
    );
  }
});

test("a model already in the catalogue is not a candidate at all", () => {
  // ML-12: kimi-k3 was announced as new three times, the last of them three
  // weeks after it shipped, because the check was per-provider.
  assert.equal(
    workItemForObservation({ existingStatus: null, alreadyInCatalogue: true }),
    null
  );
});

test("approving without a recorded decision is refused", () => {
  assert.equal(
    move("awaiting_decision", "approved", { hasDecision: false })?.code,
    "decision_missing"
  );
  assert.equal(move("awaiting_decision", "approved"), null);
});

test("automation may not decide", () => {
  assert.equal(
    move("discovered", "awaiting_decision", { actorEmail: null })?.code,
    "actor_required"
  );
});

test("a registry row is not the finish line", () => {
  // approved -> completed would be exactly the "it exists, so we are done"
  // shortcut the audit found: pricing, access and staging verification all
  // still owed.
  assert.equal(move("approved", "completed")?.code, "not_allowed");
  assert.equal(move("approved", "implementation_pending"), null);
});

test("outstanding validations block the rollout, and name themselves", () => {
  const refusal = move("validation_pending", "rollout_pending", {
    pendingValidations: ["pricing", "staging"],
  });
  assert.equal(refusal?.code, "validations_outstanding");
  assert.match(refusal!.message, /pricing, staging/);
  assert.equal(move("validation_pending", "rollout_pending"), null);
});

test("an item that owes users a notice cannot close without one", () => {
  assert.equal(
    move("rollout_pending", "completed", { communicationRequired: true })?.code,
    "communication_required"
  );
  // ...and closes through the notice instead.
  assert.equal(
    move("rollout_pending", "communication_pending", { communicationRequired: true }),
    null
  );
  assert.equal(move("communication_pending", "completed"), null);
});

test("an item owing nobody a notice closes directly", () => {
  assert.equal(move("rollout_pending", "completed"), null);
});

test("terminal states are terminal, including completed", () => {
  for (const from of TERMINAL_WORK_ITEM_STATUSES) {
    for (const to of WORK_ITEM_STATUSES) {
      assert.equal(
        move(from, to)?.code,
        "terminal",
        `${from} -> ${to} must be refused`
      );
    }
  }
});

test("deferring is reversible and rejecting is not", () => {
  assert.equal(move("awaiting_decision", "deferred"), null);
  assert.equal(move("deferred", "awaiting_decision"), null);
  assert.equal(move("rejected", "awaiting_decision")?.code, "terminal");
});

test("every non-terminal status has at least one way out", () => {
  // A state with no exit is a queue that silently accumulates.
  for (const from of OPEN_WORK_ITEM_STATUSES) {
    const exits = WORK_ITEM_STATUSES.filter((to) => move(from, to) === null);
    assert.ok(exits.length > 0, `${from} is a dead end`);
  }
});

test("every status is reachable from discovered", () => {
  const seen = new Set<WorkItemStatus>(["discovered"]);
  for (let pass = 0; pass < WORK_ITEM_STATUSES.length; pass += 1) {
    for (const from of [...seen]) {
      for (const to of WORK_ITEM_STATUSES) {
        // communicationRequired varies per item, so both branches count.
        const open =
          move(from, to) === null ||
          move(from, to, { communicationRequired: true }) === null;
        if (open) seen.add(to);
      }
    }
  }
  assert.deepEqual(
    WORK_ITEM_STATUSES.filter((status) => !seen.has(status)),
    []
  );
});

test("a terminal state stamps exactly one timestamp", () => {
  assert.equal(workItemTimestampField("completed"), "completedAt");
  assert.equal(workItemTimestampField("rejected"), "closedAt");
  assert.equal(workItemTimestampField("closed_no_action"), "closedAt");
  assert.equal(workItemTimestampField("awaiting_decision"), null);
});

test("open statuses are exactly the non-terminal ones", () => {
  assert.deepEqual(
    [...OPEN_WORK_ITEM_STATUSES].sort(),
    WORK_ITEM_STATUSES.filter((s) => !TERMINAL_WORK_ITEM_STATUSES.has(s)).sort()
  );
});

test("age is whole days and never negative", () => {
  const now = new Date("2026-08-22T00:00:00Z");
  assert.equal(workItemAgeDays(new Date("2026-07-25T00:00:00Z"), now), 28);
  assert.equal(workItemAgeDays(new Date("2026-08-22T00:00:00Z"), now), 0);
  assert.equal(workItemAgeDays(new Date("2026-08-23T00:00:00Z"), now), 0);
});

test("one model is one decision, however many providers list it", () => {
  // GLM-5.3 arrived as three unrelated one-line entries across three days:
  // Zhipu's own `glm-5.3`, Qwen's `ZHIPU/GLM-5.3`, Perplexity's
  // `perplexity/glm-5.3`. It is one model and one decision.
  assert.equal(candidateIdentity("glm-5.3"), "glm-5.3");
  assert.equal(candidateIdentity("ZHIPU/GLM-5.3"), "glm-5.3");
  assert.equal(candidateIdentity("perplexity/glm-5.3"), "glm-5.3");
  assert.equal(candidateIdentity("moonshotai/kimi-k3"), "kimi-k3");
});

test("a model already in the catalogue is never queued again", () => {
  // kimi-k3 shipped on 3 August and was still being announced as new on
  // 22 August, because the catalogue check was per-provider.
  assert.deepEqual(
    newCandidatesForQueue({
      observed: [{ provider: "qwen", apiModel: "kimi-k3" }],
      catalogueApiModels: ["kimi-k3"],
      queuedApiModels: [],
    }),
    []
  );
});

test("two providers listing the same new model on one day is one candidate", () => {
  const fresh = newCandidatesForQueue({
    observed: [
      { provider: "zhipu", apiModel: "glm-5.3" },
      { provider: "qwen", apiModel: "ZHIPU/GLM-5.3" },
      { provider: "perplexity", apiModel: "perplexity/glm-5.3" },
    ],
    catalogueApiModels: [],
    queuedApiModels: [],
  });
  // One candidate, named by the first sighting. What it was seen through is
  // asserted by the ML-12 tests below.
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].provider, "zhipu");
  assert.equal(fresh[0].apiModel, "glm-5.3");
});

test("a model queued yesterday is not queued again under another provider", () => {
  assert.deepEqual(
    newCandidatesForQueue({
      observed: [{ provider: "perplexity", apiModel: "perplexity/glm-5.3" }],
      catalogueApiModels: [],
      queuedApiModels: ["glm-5.3"],
    }),
    []
  );
});

test("genuinely new first-party models still come through", () => {
  // The seven the audit found. None of them should be collapsed away.
  const observed = [
    { provider: "qwen", apiModel: "qwen3.8-max" },
    { provider: "xai", apiModel: "grok-4.6" },
    { provider: "google", apiModel: "gemini-3.7-flash" },
  ];
  const fresh = newCandidatesForQueue({
    observed,
    catalogueApiModels: ["gemini-3.6-flash", "grok-4.5", "qwen3.7-max"],
    queuedApiModels: [],
  });
  assert.deepEqual(
    fresh.map(({ provider, apiModel }) => ({ provider, apiModel })),
    observed
  );
  // Each was seen once, through the provider that owns it.
  assert.deepEqual(fresh.map((entry) => entry.observedVia.length), [1, 1, 1]);
});

// ML-12: one model, several providers.
//
// `glm-5.3` arrived three times over three days -- as `glm-5.3` from Zhipu,
// `ZHIPU/GLM-5.3` from Qwen and `perplexity/glm-5.3` from Perplexity -- and no
// report said it was the one from the day before. `kimi-k3` was reported new
// three times, the last three weeks after it shipped, because the providers
// that list it are not the one it is registered under.
//
// Collapsing them to one decision is right. Discarding what was collapsed is
// not: which providers serve a model is what somebody deciding about it needs.

test("the same model through three providers is one candidate carrying three sightings", () => {
    const fresh = newCandidatesForQueue({
        observed: [
            { provider: "zhipu", apiModel: "glm-5.3" },
            { provider: "qwen", apiModel: "ZHIPU/GLM-5.3" },
            { provider: "perplexity", apiModel: "perplexity/glm-5.3" },
        ],
        catalogueApiModels: [],
        queuedApiModels: [],
    });

    assert.equal(fresh.length, 1);
    assert.deepEqual(
        fresh[0].observedVia.map((entry) => entry.provider),
        ["zhipu", "qwen", "perplexity"]
    );
    // The exact string each provider returned, not the normalised key: an
    // operator checking the claim needs what was actually there.
    assert.deepEqual(
        fresh[0].observedVia.map((entry) => entry.apiModel),
        ["glm-5.3", "ZHIPU/GLM-5.3", "perplexity/glm-5.3"]
    );
});

test("a model already in the catalogue under one provider is not new under another", () => {
    const fresh = newCandidatesForQueue({
        observed: [
            { provider: "perplexity", apiModel: "perplexity/kimi-k3" },
            { provider: "qwen", apiModel: "kimi-k3" },
        ],
        // Registered under Moonshot, which is neither of the above.
        catalogueApiModels: ["moonshotai/kimi-k3"],
        queuedApiModels: [],
    });

    assert.deepEqual(fresh, []);
});

test("a sighting through a new provider attaches to the item that already exists", () => {
    const grouped = observationsForExistingItems({
        observed: [
            { provider: "qwen", apiModel: "ZHIPU/GLM-5.3" },
            { provider: "openai", apiModel: "gpt-5-9" },
        ],
        queuedIdentities: ["glm-5.3"],
    });

    assert.equal(grouped.size, 1);
    assert.deepEqual(grouped.get("glm-5.3"), [
        { provider: "qwen", apiModel: "ZHIPU/GLM-5.3" },
    ]);
});

test("merging is idempotent, so an unchanged scan writes nothing", () => {
    const existing = [
        { provider: "zhipu", apiModel: "glm-5.3" },
        { provider: "qwen", apiModel: "ZHIPU/GLM-5.3" },
    ];

    const same = mergeObservedVia(existing, existing);
    assert.equal(same.added, 0);
    assert.deepEqual(same.merged, existing);

    const grown = mergeObservedVia(existing, [
        { provider: "zhipu", apiModel: "glm-5.3" },
        { provider: "perplexity", apiModel: "perplexity/glm-5.3" },
    ]);
    assert.equal(grown.added, 1);
    assert.equal(grown.merged.length, 3);
    // Appended, not reordered: the first sighting stays first.
    assert.equal(grown.merged[0].provider, "zhipu");
});

test("the same provider spelling a model two ways is two sightings, one candidate", () => {
    // 7/28 `moonshotai/kimi-k3`, 7/29 `perplexity/kimi-k3` -- the same provider
    // changed the spelling and the old code made a second candidate of it.
    const fresh = newCandidatesForQueue({
        observed: [
            { provider: "perplexity", apiModel: "moonshotai/kimi-k3" },
            { provider: "perplexity", apiModel: "perplexity/kimi-k3" },
        ],
        catalogueApiModels: [],
        queuedApiModels: [],
    });

    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].observedVia.length, 2);
});
