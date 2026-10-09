import assert from "node:assert/strict";
import test from "node:test";

import { createPromptRefinerSyntheticAutoSession } from "../lib/promptRefinerSyntheticAutoSession.ts";
import { PROMPT_REFINER_SYNTHETIC_PROPOSAL_TTL_MS } from "../lib/promptRefinerSyntheticDecisionSession.ts";
import { PROMPT_REFINER_INPUT_SCOPE } from "../lib/promptRefinerSuggestion.ts";

const source = "  Cafe\u0301 한글 👩‍💻\r\n합성 원문  ";
const refined = "  Cafe\u0301 한글 👩‍💻\r\n합성 비교 기준을 표로 작성해 주세요.  ";
const scope = Object.freeze({ identityKey: "synthetic_account", mountedSurface: "synthetic_chat", conversationId: "synthetic_conversation" });
const snapshot = { draft: source, sourceMessageId: "synthetic_message", scope };
const history = Object.freeze({ id: "history", role: "assistant", content: "synthetic history" });
const attachments = Object.freeze([{ id: "synthetic_attachment", label: "not refiner input" }]);
const current = Object.freeze({ id: snapshot.sourceMessageId, role: "user", content: source, attachments });
const messages = Object.freeze([history, current]);
const measurement = Object.freeze({ qualityScore: 0.8, costMicroUsd: 100, preparationLatencyMs: 20 });
const comparison = (changes = {}) => ({ original: measurement, candidate: measurement, candidateOutcome: "completed", ...changes });

function fixture(options = { syntheticAutoEnabled: true }) {
  let now = 1_000;
  const session = createPromptRefinerSyntheticAutoSession({ snapshot, now: () => now, ...options });
  const request = session.beginProposal();
  const response = {
    requestId: request.requestId, suggestionId: "synthetic_suggestion", refinedPrompt: refined,
    refinerVersion: "suggest-v1", inputScope: PROMPT_REFINER_INPUT_SCOPE,
  };
  const choice = (decision = "accepted") => ({ requestId: request.requestId, suggestionId: response.suggestionId, decision });
  return { session, request, response, choice, ready: () => session.completeProposal(request.requestId, response), setTime: (value) => { now = value; } };
}

function assertOriginal(result, transcript = messages) {
  assert.equal(result.inputSource, "original");
  assert.equal(result.authoredMessages, transcript);
  assert.equal(result.routerMessages, transcript);
  assert.equal(result.plannerMessages, transcript);
  assert.equal(result.dispatchAuthorized, false);
  assert.equal(result.evidenceAuthority, "synthetic_only");
  assert.equal(current.content, source);
}

function assertAccepted(result, transcript = messages, expected = refined) {
  // These stand-ins actually consume the selected view; no real stage runs.
  const routerRead = (view) => view.at(-1).content;
  const plannerRead = (view) => view.at(-1).content;
  assert.equal(routerRead(result.routerMessages), expected);
  assert.equal(plannerRead(result.plannerMessages), expected);
  assert.equal(result.inputSource, "accepted_proposal");
  assert.equal(result.authoredMessages, transcript);
  assert.equal(result.routerMessages, result.plannerMessages);
  assert.notEqual(result.routerMessages, transcript);
  assert.equal(result.routerMessages[0], transcript[0]);
  assert.equal(result.routerMessages.at(-1).attachments, transcript.at(-1).attachments);
  assert.equal(result.provenance.decision, "accepted");
  assert.equal(result.dispatchAuthorized, false);
  assert.equal(result.evidenceAuthority, "synthetic_only");
  assert.equal(transcript.at(-1).content, source);
}

test("only strict true enables a current explicitly accepted synthetic Auto input", () => {
  for (const syntheticAutoEnabled of [undefined, false, null, 0, 1, "true", {}, []]) {
    const f = fixture({ syntheticAutoEnabled }); f.ready();
    const result = f.session.consumeAutoInput({ messages, choice: f.choice() });
    assertOriginal(result);
    assert.equal(result.reason, "default_off");
    assert.equal(result.provenance, null);
    assertOriginal(f.session.consumeAutoInput({ messages, choice: f.choice() }));
  }
  const f = fixture(); f.ready();
  assertAccepted(f.session.consumeAutoInput({ messages, choice: f.choice() }));
});

test("an accepted view preserves original bytes, all historical objects and attachments", () => {
  const f = fixture(); f.ready();
  const priorUser = Object.freeze({ id: "prior_user", role: "user", content: "prior synthetic user" });
  const transcript = Object.freeze([priorUser, history, current]);
  const result = f.session.consumeAutoInput({ messages: transcript, choice: f.choice() });
  assertAccepted(result, transcript);
  assert.equal(result.routerMessages[0], priorUser);
  assert.equal(result.routerMessages[1], history);
  assert.deepEqual(Buffer.from(result.authoredMessages.at(-1).content), Buffer.from(source));
  assert.equal(result.authoredMessages.at(-1), current);
});

test("explicit rejection keeps the exact original transcript and cannot later accept it", () => {
  const f = fixture(); f.ready();
  const result = f.session.consumeAutoInput({ messages, choice: f.choice("kept_original") });
  assertOriginal(result);
  assert.equal(result.reason, "kept_original");
  assert.equal(result.provenance.decision, "kept_original");
  const replay = f.session.consumeAutoInput({ messages, choice: f.choice() });
  assertOriginal(replay);
  assert.equal(replay.decisionErrorCode, "unavailable");
});

test("requesting and ready states cannot silently promote an unconfirmed suggestion", () => {
  for (const ready of [false, true]) for (const options of [{}, { shadowComparison: comparison() }]) {
    const f = fixture(); if (ready) f.ready();
    const result = f.session.consumeAutoInput({ messages, ...options });
    assertOriginal(result);
    assert.equal(result.reason, "explicit_acceptance_required");
    assertOriginal(f.session.consumeAutoInput({ messages, choice: f.choice() }));
  }
});

test("closed, failed and not-yet-ready sessions fall back on original input", () => {
  for (const action of [null, "close", "fail"]) for (const ready of [false, true]) {
    if (action === null && ready) continue;
    const f = fixture(); if (ready) f.ready(); if (action) f.session[action]();
    const result = f.session.consumeAutoInput({ messages, choice: f.choice() });
    assertOriginal(result);
    assert.equal(result.decisionErrorCode, "unavailable");
    assertOriginal(f.session.consumeAutoInput({ messages, choice: f.choice() }));
  }
});

test("draft, source and every scope transition revoke acceptance, including ABA", () => {
  const changes = [
    { ...snapshot, draft: source + " " },
    { ...snapshot, sourceMessageId: "other_message" },
    ...["identityKey", "mountedSurface", "conversationId"].map((key) => ({ ...snapshot, scope: { ...scope, [key]: "other" } })),
  ];
  for (const change of changes) for (const ready of [false, true]) {
    const f = fixture(); if (ready) f.ready();
    f.session.updateSnapshot(change); f.session.updateSnapshot(snapshot);
    const result = f.session.consumeAutoInput({ messages, choice: f.choice() });
    assertOriginal(result);
    assert.equal(result.decisionErrorCode, "stale");
  }
});

test("the exact expiry boundary blocks proposal input without renewing it", () => {
  const f = fixture(); f.ready();
  f.setTime(1_000 + PROMPT_REFINER_SYNTHETIC_PROPOSAL_TTL_MS);
  const result = f.session.consumeAutoInput({ messages, choice: f.choice() });
  assertOriginal(result);
  assert.equal(result.decisionErrorCode, "expired");
  const currentSession = fixture(); currentSession.ready();
  currentSession.setTime(999 + PROMPT_REFINER_SYNTHETIC_PROPOSAL_TTL_MS);
  assertAccepted(currentSession.session.consumeAutoInput({ messages, choice: currentSession.choice() }));
});

test("forged ids, browser text and claimed permission never replace the server-held proposal", () => {
  for (const change of [
    { suggestionId: "forged" }, { requestId: "forged" }, { decision: "auto" },
    { refinedPrompt: "forged" }, { executionPrompt: refined }, { approved: true },
    { projection: { executionMessages: [{ ...current, content: refined }] } },
  ]) {
    const f = fixture(); f.ready();
    const result = f.session.consumeAutoInput({ messages, choice: { ...f.choice(), ...change } });
    assertOriginal(result);
    assert.equal(result.decisionErrorCode, "invalid_choice");
    assertOriginal(f.session.consumeAutoInput({ messages, choice: f.choice() }));
  }
});

test("an arbitrary top-level projection is ignored and never supplies an Auto view", () => {
  const f = fixture(); f.ready();
  const result = f.session.consumeAutoInput({
    messages, projection: { authoredMessages: messages, executionMessages: [{ ...current, content: refined }] },
    executionPrompt: refined, dispatchAuthorized: true,
  });
  assertOriginal(result);
  assert.equal(result.provenance, null);
});

test("acceptance is consumed once before both views and replays return original", () => {
  const f = fixture(); f.ready();
  assertAccepted(f.session.consumeAutoInput({ messages, choice: f.choice() }));
  const result = f.session.consumeAutoInput({ messages, choice: f.choice() });
  assertOriginal(result);
  assert.equal(result.decisionErrorCode, "unavailable");
});

test("concurrent choices have one accepted result and one original replay", async () => {
  const f = fixture(); f.ready();
  const results = await Promise.all([
    Promise.resolve().then(() => f.session.consumeAutoInput({ messages, choice: f.choice() })),
    Promise.resolve().then(() => f.session.consumeAutoInput({ messages, choice: f.choice() })),
  ]);
  assertAccepted(results[0]);
  assertOriginal(results[1]);
});

test("current transcript mismatches consume and fall back without replacing any bytes", () => {
  for (const transcript of [
    [history, { ...current, content: source + " " }],
    [history, { ...current, id: "other" }],
    [history, current, { ...current, id: "newer" }],
    [current, current],
  ]) {
    const f = fixture(); f.ready();
    const result = f.session.consumeAutoInput({ messages: transcript, choice: f.choice() });
    assertOriginal(result, transcript);
    assert.equal(result.decisionErrorCode, "invalid_transcript");
    assertOriginal(f.session.consumeAutoInput({ messages, choice: f.choice() }));
  }
});

test("superseding a proposal rejects the old ids and requires a newly explicit choice", () => {
  const f = fixture(); f.ready();
  const newer = f.session.beginProposal();
  const response = { ...f.response, requestId: newer.requestId, refinedPrompt: "new synthetic proposal" };
  f.session.completeProposal(newer.requestId, response);
  assertOriginal(f.session.consumeAutoInput({ messages, choice: f.choice() }));
  assertOriginal(f.session.consumeAutoInput({ messages, choice: { ...f.choice(), requestId: newer.requestId } }));
  const next = f.session.beginProposal();
  f.session.completeProposal(next.requestId, { ...response, requestId: next.requestId });
  assertAccepted(f.session.consumeAutoInput({ messages, choice: { ...f.choice(), requestId: next.requestId } }), messages, response.refinedPrompt);
});

test("returned request/response mutation cannot alter server-owned Auto input", () => {
  const f = fixture();
  const id = f.request.requestId;
  f.request.prompt = "forged original";
  const response = f.session.completeProposal(id, f.response);
  response.refinedPrompt = "forged returned proposal";
  f.response.refinedPrompt = "forged adapter response";
  assertAccepted(f.session.consumeAutoInput({ messages, choice: f.choice() }));
});

test("clock failures leave both stages on original and revoke the proposal", () => {
  for (const value of [999, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    const f = fixture(); f.ready(); f.setTime(value);
    const result = f.session.consumeAutoInput({ messages, choice: f.choice() });
    assertOriginal(result);
    assert.equal(result.decisionErrorCode, "clock_invalid");
    f.setTime(1_001);
    assertOriginal(f.session.consumeAutoInput({ messages, choice: f.choice() }));
  }
});

test("a restarted facade cannot consume ids from a lost synthetic session", () => {
  const f = fixture(); f.ready();
  const restarted = createPromptRefinerSyntheticAutoSession({ snapshot, syntheticAutoEnabled: true, now: () => 1_000 });
  assertOriginal(restarted.consumeAutoInput({ messages, choice: f.choice() }));
});

test("quality, cost and latency regression send both synthetic consumers the original", () => {
  for (const [change, reason, delta] of [
    [{ qualityScore: 0.79 }, "quality_regressed", 0],
    [{ costMicroUsd: 101 }, "cost_regressed", 0],
    [{ preparationLatencyMs: 21 }, "latency_regressed", 1],
  ]) {
    const f = fixture(); f.ready();
    const result = f.session.consumeAutoInput({ messages, choice: f.choice(), shadowComparison: comparison({ candidate: { ...measurement, ...change } }) });
    assertOriginal(result);
    assert.equal(result.reason, reason);
    assert.equal(result.provenance, null);
    assert.equal(result.shadowAssessment.preparationLatencyDeltaMs, delta);
    assert.equal(result.shadowAssessment.evidenceAuthority, "caller_supplied_unverified");
    assert.equal(result.shadowAssessment.dispatchAuthorized, false);
    assertOriginal(f.session.consumeAutoInput({ messages, choice: f.choice() }));
  }
});

test("missing or invalid comparison measurements keep original despite explicit acceptance", () => {
  for (const shadowComparison of [
    null, undefined,
    comparison({ original: null }), comparison({ candidate: {} }),
    ...[
      { qualityScore: null }, { qualityScore: NaN }, { qualityScore: Infinity }, { qualityScore: 1.1 },
      { costMicroUsd: null }, { costMicroUsd: -1 }, { costMicroUsd: 0.1 }, { costMicroUsd: Number.MAX_SAFE_INTEGER + 1 },
      { preparationLatencyMs: null }, { preparationLatencyMs: -1 }, { preparationLatencyMs: Infinity }, { preparationLatencyMs: 0.1 },
    ].map((change) => comparison({ candidate: { ...measurement, ...change } })),
  ]) {
    const f = fixture(); f.ready();
    const result = f.session.consumeAutoInput({ messages, choice: f.choice(), shadowComparison });
    assertOriginal(result);
    assert.equal(result.reason, "measurement_missing_or_invalid");
    assert.equal(result.shadowAssessment.preparationLatencyDeltaMs, null);
    assertOriginal(f.session.consumeAutoInput({ messages, choice: f.choice() }));
  }
});

test("no regression can preserve explicit acceptance but never certify actual quality", () => {
  const f = fixture(); f.ready();
  const result = f.session.consumeAutoInput({
    messages, choice: f.choice(), shadowComparison: comparison({ candidate: { qualityScore: 0.9, costMicroUsd: 99, preparationLatencyMs: 19 } }),
  });
  assertAccepted(result);
  assert.equal(result.shadowAssessment.futureInputSignal, "no_recorded_regression");
  assert.equal(result.shadowAssessment.preparationLatencyDeltaMs, -1);
  assert.equal(result.shadowAssessment.evidenceAuthority, "caller_supplied_unverified");
  assert.equal(result.shadowAssessment.dispatchAuthorized, false);
});

test("no-regression evidence cannot promote rejected, stale or default-off proposals", () => {
  for (const mode of ["rejected", "stale", "off"]) {
    const f = fixture({ syntheticAutoEnabled: mode !== "off" }); f.ready();
    if (mode === "stale") f.session.updateSnapshot({ ...snapshot, draft: source + " " });
    assertOriginal(f.session.consumeAutoInput({ messages, choice: f.choice(mode === "rejected" ? "kept_original" : "accepted"), shadowComparison: comparison() }));
  }
});

test("pre-dispatch error and unattempted comparison revoke acceptance and retain original", () => {
  for (const [candidateOutcome, reason] of [["not_attempted", "candidate_not_attempted"], ["failed_before_dispatch", "candidate_failed_before_dispatch"]]) {
    const f = fixture(); f.ready();
    const result = f.session.consumeAutoInput({ messages, choice: f.choice(), shadowComparison: comparison({ candidateOutcome }) });
    assertOriginal(result);
    assert.equal(result.reason, reason);
    assertOriginal(f.session.consumeAutoInput({ messages, choice: f.choice() }));
  }
});

test("post-dispatch error and unknown outcome stop both consumers without original retry", () => {
  for (const syntheticAutoEnabled of [false, true]) for (const candidateOutcome of ["failed_after_dispatch", "unknown_after_dispatch", "unrecognized_outcome"]) {
    const f = fixture({ syntheticAutoEnabled }); f.ready();
    const result = f.session.consumeAutoInput({ messages, choice: f.choice(), shadowComparison: comparison({ candidateOutcome }) });
    assert.equal(result.inputSource, "none");
    assert.equal(result.routerMessages, null);
    assert.equal(result.plannerMessages, null);
    assert.equal(result.authoredMessages, messages);
    assert.equal(result.shadowAssessment.futureInputSignal, "stop_and_reconcile");
    assert.equal(result.dispatchAuthorized, false);
    assert.equal(result.provenance, null);
    assert.equal(f.session.status(), "closed");
    assert.equal(current.content, source);
    const retry = f.session.consumeAutoInput({ messages, choice: f.choice() });
    assert.equal(retry.inputSource, "none");
    assert.equal(retry.routerMessages, null);
    assert.equal(retry.plannerMessages, null);
    const newer = f.session.beginProposal();
    f.session.completeProposal(newer.requestId, { ...f.response, requestId: newer.requestId });
    const improved = f.session.consumeAutoInput({ messages, choice: { ...f.choice(), requestId: newer.requestId }, shadowComparison: comparison() });
    assert.equal(improved.inputSource, "none");
    assert.equal(improved.routerMessages, null);
    assert.equal(improved.plannerMessages, null);
    assert.equal(improved.reason, result.reason);
  }
});

test("unreadable comparison outcome stops without leaking external error prose", () => {
  const f = fixture(); f.ready();
  const shadowComparison = { get candidateOutcome() { throw new Error("external comparison secret prose"); } };
  const result = f.session.consumeAutoInput({ messages, choice: f.choice(), shadowComparison });
  assert.equal(result.inputSource, "none");
  assert.equal(result.reason, "candidate_outcome_unknown");
  assert.equal(result.routerMessages, null);
  assert.equal(result.plannerMessages, null);
  assert.equal(JSON.stringify(result).includes("external comparison secret prose"), false);
});

test("mutating returned shadow diagnostics cannot clear a stopped synthetic session", () => {
  const f = fixture(); f.ready();
  const result = f.session.consumeAutoInput({ messages, choice: f.choice(), shadowComparison: comparison({ candidateOutcome: "unknown_after_dispatch" }) });
  assert.throws(() => { result.shadowAssessment.futureInputSignal = "no_recorded_regression"; }, TypeError);
  const retry = f.session.consumeAutoInput({ messages, choice: f.choice(), shadowComparison: comparison() });
  assert.equal(retry.inputSource, "none");
  assert.equal(retry.routerMessages, null);
  assert.equal(retry.plannerMessages, null);
  assert.equal(retry.reason, "candidate_outcome_unknown");
});

test("synthetic voice transcript preserves authored text and metadata under acceptance/fallback", () => {
  const metadata = Object.freeze({ modality: "voice", transcriptOrigin: "synthetic_fixture" });
  const voiceMessage = Object.freeze({ ...current, metadata });
  const transcript = Object.freeze([history, voiceMessage]);
  const accepted = fixture(); accepted.ready();
  const result = accepted.session.consumeAutoInput({ messages: transcript, choice: accepted.choice() });
  assertAccepted(result, transcript);
  assert.equal(result.routerMessages.at(-1).metadata, metadata);
  assert.equal(result.authoredMessages.at(-1), voiceMessage);
  const fallback = fixture(); fallback.ready();
  assertOriginal(fallback.session.consumeAutoInput({ messages: transcript, choice: fallback.choice(), shadowComparison: comparison({ candidate: { ...measurement, preparationLatencyMs: 21 } }) }), transcript);
});
