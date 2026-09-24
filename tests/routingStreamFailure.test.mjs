import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { classifyStreamFailure } from "../lib/routingStreamFailure.ts";
import { ROUTING_ATTEMPT_ERROR_CLASSES } from "../lib/routingAttemptStore.ts";
import { DISPATCH_OUTCOMES_COUNTED } from "../lib/routerSignalCore.ts";
import { decideFallback } from "../lib/routingFallbackPolicy.ts";

// The claim under test is the one §9.1 of the rollout note had to withdraw:
// "the stream produced no text" is not the same as "the provider failed in a
// way §7 lets us route around". Most of these are cases where the first is
// true and the second is not.

const classify = (overrides = {}) =>
  classifyStreamFailure({
    error: Object.assign(new Error("upstream exploded"), {
      name: "APICallError",
      statusCode: 503,
    }),
    phase: "read",
    visibleTokenEmitted: false,
    downstreamOpen: true,
    ...overrides,
  });

const errorWith = (fields) => Object.assign(new Error("failed"), fields);

test("a provider stream failure with nothing shown is the fallback case", () => {
  const classified = classify();
  assert.equal(classified.outcome, "failed_pre_token");
  assert.equal(classified.failureLayer, "provider");
  assert.equal(classified.providerRefusal, null);
});

test("the same failure after a visible token is post-token", () => {
  const classified = classify({ visibleTokenEmitted: true });
  assert.equal(classified.outcome, "failed_post_token");
});

test("a closed response means the client left, whatever the error says", () => {
  // The error here is a textbook retryable provider failure. It does not
  // matter: there is nobody to show a second attempt to.
  const classified = classify({ downstreamOpen: false });
  assert.equal(classified.outcome, "cancelled");
  assert.equal(classified.failureLayer, "stream");
});

test("an aborted request is a cancellation, not a provider failure", () => {
  for (const error of [
    errorWith({ name: "AbortError" }),
    errorWith({ name: "TimeoutError" }),
    errorWith({ code: "ABORT_ERR" }),
    errorWith({ code: "ECONNRESET" }),
  ]) {
    const classified = classify({ error });
    assert.equal(classified.outcome, "cancelled", error.name ?? error.code);
    assert.equal(classified.failureLayer, "stream");
  }
});

test("a controller that is already closed is the client, not the provider", () => {
  const classified = classify({
    error: Object.assign(new Error("Controller is already closed"), {
      code: "ERR_INVALID_STATE",
    }),
  });
  assert.equal(classified.outcome, "cancelled");
  assert.equal(classified.failureLayer, "stream");
});

// The case §9.1 called out by name: `pull()`'s catch also receives failures
// from the completion handling that runs after the last chunk.
test("a completion-handling failure is ours, so it is never a provider failure", () => {
  const classified = classify({ phase: "completion" });
  assert.equal(classified.failureLayer, "stream");
  // Truthful about what the user saw -- the layer, not the outcome, is what
  // keeps this from being substituted.
  assert.equal(classified.outcome, "failed_pre_token");
});

test("a completion failure fails closed rather than trying another model", () => {
  const classified = classify({ phase: "completion" });
  const decision = decideFallback({
    attempt: {
      modelId: "gpt-5-6-luna",
      outcome: classified.outcome,
      failureLayer: classified.failureLayer,
      providerRefusal: classified.providerRefusal,
    },
    run: { passThroughUsed: false, rerouteCount: 0, visibleTokenEmitted: false },
    nextCandidateModelIds: ["deepseek-v4-flash"],
  });
  assert.equal(decision.action, "terminate");
  assert.equal(decision.reason, "fail_closed_layer");
});

// §7 lists policy rejection next to cancellation. Routing around a safety
// refusal is asking a second model to do what the first one would not.
test("a content-policy refusal is a provider failure that is not routed around", () => {
  for (const error of [
    errorWith({ code: "content_filter" }),
    errorWith({ name: "ContentPolicyViolationError" }),
    Object.assign(new Error("blocked by the safety system"), { statusCode: 400 }),
    Object.assign(new Error("prohibited_content in the request"), { statusCode: 400 }),
  ]) {
    const classified = classify({ error });
    assert.equal(classified.failureLayer, "provider");
    assert.equal(classified.providerRefusal, "policy", error.message);

    const decision = decideFallback({
      attempt: {
        modelId: "gpt-5-6-luna",
        outcome: classified.outcome,
        failureLayer: classified.failureLayer,
        providerRefusal: classified.providerRefusal,
      },
      run: { passThroughUsed: false, rerouteCount: 0, visibleTokenEmitted: false },
      nextCandidateModelIds: ["deepseek-v4-flash"],
    });
    assert.equal(decision.action, "terminate");
    assert.equal(decision.reason, "provider_policy_rejection");
  }
});

test("a provider that cannot fund the call is not answered by spending elsewhere", () => {
  const classified = classify({
    error: Object.assign(new Error("payment required"), { statusCode: 402 }),
  });
  assert.equal(classified.providerRefusal, "insufficient_credits");

  const decision = decideFallback({
    attempt: {
      modelId: "gpt-5-6-luna",
      outcome: classified.outcome,
      failureLayer: classified.failureLayer,
      providerRefusal: classified.providerRefusal,
    },
    run: { passThroughUsed: false, rerouteCount: 0, visibleTokenEmitted: false },
    nextCandidateModelIds: ["deepseek-v4-flash"],
  });
  assert.equal(decision.reason, "provider_insufficient_credits");
});

test("rate limits and server errors stay eligible, which is the point", () => {
  // If the exclusions above swallowed these too, the classifier would be safe
  // and useless: 429 and 503 are the failures a fallback exists for.
  for (const statusCode of [429, 500, 502, 503]) {
    const classified = classify({
      error: Object.assign(new Error("upstream"), { statusCode }),
    });
    assert.equal(classified.providerRefusal, null, String(statusCode));
    assert.equal(classified.failureLayer, "provider");
  }
});

test("the reason never carries the provider's own words", () => {
  // Provider errors routinely echo the request back, and this string is
  // written to operator surfaces.
  const secret = "sk-live-do-not-log-this";
  const classified = classify({
    error: Object.assign(new Error(`refused: ${secret}`), { statusCode: 500 }),
  });
  assert.equal(classified.reason.includes(secret), false);
});

test("an unrecognisable error is still a provider failure, not a shrug", () => {
  const classified = classify({ error: "a string, somehow" });
  assert.equal(classified.failureLayer, "provider");
  assert.equal(classified.outcome, "failed_pre_token");
});

/**
 * The provider category the classification now keeps.
 *
 * `classifyProviderFailure` produced one for every provider failure and this
 * function read it, kept `PAYMENT_REQUIRED` and dropped the rest, so a rate
 * limit, a 5xx, a DNS failure and an unrecognised error all arrived in the
 * attempt record as one `failureLayer: "provider"` and nothing else. Telling
 * capacity apart from availability is a later change; it cannot be made from
 * records that never kept the difference.
 *
 * The layer and the outcome are deliberately unchanged. `decideFallback` reads
 * those, so nothing about what runs is different.
 */

const providerError = (code, status) =>
    Object.assign(new Error("upstream"), { code, status });

test("a rate limit and an outage are no longer the same record", () => {
    const rateLimited = classifyStreamFailure({
        error: providerError(undefined, 429),
        phase: "read",
        visibleTokenEmitted: false,
        downstreamOpen: true,
    });
    const serverError = classifyStreamFailure({
        error: providerError(undefined, 503),
        phase: "read",
        visibleTokenEmitted: false,
        downstreamOpen: true,
    });

    assert.equal(rateLimited.errorClass, "provider_rate_limited");
    assert.equal(serverError.errorClass, "provider_server_error");
    assert.notEqual(rateLimited.errorClass, serverError.errorClass);

    // And the parts that decide are identical, which is the point: this is a
    // record keeping a difference, not a routing change.
    assert.equal(rateLimited.failureLayer, serverError.failureLayer);
    assert.equal(rateLimited.outcome, serverError.outcome);
    assert.equal(rateLimited.providerRefusal, serverError.providerRefusal);
});

test("every classification carries a class from the closed vocabulary", () => {
    const observations = [
        { error: new Error("x"), phase: "read", visibleTokenEmitted: false, downstreamOpen: false },
        { error: Object.assign(new Error("x"), { name: "AbortError" }), phase: "read", visibleTokenEmitted: false, downstreamOpen: true },
        { error: new Error("x"), phase: "emit", visibleTokenEmitted: true, downstreamOpen: true },
        { error: new Error("x"), phase: "completion", visibleTokenEmitted: true, downstreamOpen: true },
        { error: providerError(undefined, 402), phase: "read", visibleTokenEmitted: false, downstreamOpen: true },
        { error: providerError(undefined, 401), phase: "read", visibleTokenEmitted: false, downstreamOpen: true },
        { error: providerError("ENOTFOUND"), phase: "read", visibleTokenEmitted: false, downstreamOpen: true },
        { error: new Error("x"), phase: "read", visibleTokenEmitted: false, downstreamOpen: true },
    ];
    for (const observation of observations) {
        const classification = classifyStreamFailure(observation);
        assert.ok(
            ROUTING_ATTEMPT_ERROR_CLASSES.includes(classification.errorClass),
            `${observation.phase}: ${classification.errorClass}`
        );
    }
});

test("a client that went away is not filed as a provider failure", () => {
    const gone = classifyStreamFailure({
        error: new Error("x"),
        phase: "read",
        visibleTokenEmitted: false,
        downstreamOpen: false,
    });
    assert.equal(gone.errorClass, "client_gone");
    assert.equal(gone.failureLayer, "stream");
    assert.ok(!gone.errorClass.startsWith("provider_"));
});

/**
 * A lost connection is not a person changing their mind.
 *
 * `TimeoutError` and `ECONNRESET` share the *verdict* with a client abort --
 * neither is substituted -- and the module says in as many words that they are
 * not user cancellations. Filing them under `client_gone` would put a cause in
 * the record that nobody observed, and would contradict provider health, which
 * classifies the same event as `NETWORK`.
 */
test("a lost connection is not recorded as the client going away", () => {
    for (const error of [
        Object.assign(new Error("x"), { name: "TimeoutError" }),
        Object.assign(new Error("x"), { code: "ECONNRESET" }),
    ]) {
        const classification = classifyStreamFailure({
            error,
            phase: "read",
            visibleTokenEmitted: false,
            downstreamOpen: true,
        });
        assert.equal(classification.errorClass, "provider_network");
        // The verdict it shares with an abort is unchanged.
        assert.equal(classification.outcome, "cancelled");
        assert.equal(classification.failureLayer, "stream");
    }
});

test("a real client abort still says so", () => {
    for (const error of [
        Object.assign(new Error("x"), { name: "AbortError" }),
        Object.assign(new Error("x"), { code: "ABORT_ERR" }),
    ]) {
        const classification = classifyStreamFailure({
            error,
            phase: "read",
            visibleTokenEmitted: false,
            downstreamOpen: true,
        });
        assert.equal(classification.errorClass, "client_gone");
        assert.equal(classification.outcome, "cancelled");
    }
});

/**
 * The verdict and the observation are two values now.
 *
 * `outcome` answers "may this be substituted" and is conservative: a lost
 * connection is `cancelled` there so no second model is tried. Recording that
 * as what happened told the success rate the person had changed their mind,
 * which is true of an abort and false of a dropped connection.
 */
test("a lost connection is observed as a failure and disposed of as a cancellation", () => {
    const lost = classifyStreamFailure({
        error: Object.assign(new Error("x"), { code: "ECONNRESET" }),
        phase: "read",
        visibleTokenEmitted: false,
        downstreamOpen: true,
    });
    assert.equal(lost.outcome, "cancelled", "not substituted");
    assert.equal(lost.observedOutcome, "failed_pre_token", "nobody cancelled");
    assert.ok(DISPATCH_OUTCOMES_COUNTED.includes(lost.observedOutcome));
});

test("a turn the person abandoned is observed as a cancellation", () => {
    const abandoned = classifyStreamFailure({
        error: Object.assign(new Error("x"), { name: "AbortError" }),
        phase: "read",
        visibleTokenEmitted: false,
        downstreamOpen: true,
    });
    assert.equal(abandoned.outcome, "cancelled");
    assert.equal(abandoned.observedOutcome, "cancelled");
    assert.ok(!DISPATCH_OUTCOMES_COUNTED.includes(abandoned.observedOutcome));
});

test("the refusal says which of the two it was", () => {
    const refusal = (classification) =>
        decideFallback({
            attempt: {
                modelId: "m",
                outcome: classification.outcome,
                observedOutcome: classification.observedOutcome,
                failureLayer: classification.failureLayer,
                providerRefusal: classification.providerRefusal,
            },
            run: { passThroughUsed: false, rerouteCount: 0, visibleTokenEmitted: false },
            nextCandidateModelIds: ["other"],
        });

    const lost = classifyStreamFailure({
        error: Object.assign(new Error("x"), { code: "ECONNRESET" }),
        phase: "read",
        visibleTokenEmitted: false,
        downstreamOpen: true,
    });
    const abandoned = classifyStreamFailure({
        error: Object.assign(new Error("x"), { name: "AbortError" }),
        phase: "read",
        visibleTokenEmitted: false,
        downstreamOpen: true,
    });

    // Both refuse. They say different things about why.
    assert.equal(refusal(lost).action, "terminate");
    assert.equal(refusal(lost).reason, "connection_lost");
    assert.equal(refusal(abandoned).action, "terminate");
    assert.equal(refusal(abandoned).reason, "cancelled");
});

test("the classifier does not mint provider_pre_token_failure", () => {
    assert.equal(ROUTING_ATTEMPT_ERROR_CLASSES.includes("provider_pre_token_failure"), true);
    assert.equal(ROUTING_ATTEMPT_ERROR_CLASSES.some((value) => value == null || value === "NULL"), false);

    const source = readFileSync(new URL("../lib/routingStreamFailure.ts", import.meta.url), "utf8");
    assert.equal(source.includes("provider_pre_token_failure"), false);
    const migration = readFileSync(
        new URL(
            "../prisma/migrations/20260922130000_routing_attempt_error_class_vocabulary/migration.sql",
            import.meta.url
        ),
        "utf8"
    );
    const inStart = migration.indexOf("IN (");
    const notValid = migration.lastIndexOf("NOT VALID");
    assert.ok(inStart >= 0);
    assert.ok(notValid > inStart);
    const inList = migration.slice(inStart, notValid);
    assert.equal(inList.includes("'NULL'"), false);
    assert.equal(inList.includes("provider_pre_token_failure"), true);

    const cases = [
        classify(),
        classify({ error: errorWith({ statusCode: 401 }) }),
        classify({ error: errorWith({ statusCode: 402 }) }),
        classify({ error: errorWith({ statusCode: 404 }) }),
        classify({ error: errorWith({ statusCode: 429 }) }),
        classify({ error: errorWith({ statusCode: 500 }) }),
        classify({ error: errorWith({ code: "ECONNRESET" }) }),
        classify({ error: errorWith({ name: "AbortError" }) }),
        classify({ error: errorWith({ name: "TimeoutError" }) }),
        classify({ phase: "completion" }),
        classify({ phase: "emit" }),
        classify({ downstreamOpen: false }),
        classify({ error: errorWith({ statusCode: 400, message: "content_policy" }) }),
    ];
    for (const classified of cases) {
        assert.notEqual(classified.errorClass, "provider_pre_token_failure");
    }
});
