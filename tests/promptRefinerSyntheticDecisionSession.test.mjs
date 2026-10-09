import assert from "node:assert/strict";
import test from "node:test";
import {
  createPromptRefinerSyntheticDecisionSession,
  PromptRefinerSyntheticDecisionError,
  PROMPT_REFINER_SYNTHETIC_PROPOSAL_TTL_MS,
} from "../lib/promptRefinerSyntheticDecisionSession.ts";
import {
  bindPromptRefinerSuggestion,
  PROMPT_REFINER_INPUT_SCOPE,
  resolvePromptRefinerFixtureDecision,
} from "../lib/promptRefinerSuggestion.ts";

const source = "  Cafe\u0301 한글 👩‍💻\r\n합성 원문  ";
const refined = "  Cafe\u0301 한글 👩‍💻\r\n합성 제안의 기준과 결과를 표로 비교해 주세요.  ";
const scope = Object.freeze({ identityKey: "synthetic_account", mountedSurface: "synthetic_chat", conversationId: "synthetic_conversation" });
const snapshot = { draft: source, sourceMessageId: "synthetic_message", scope };
const history = Object.freeze({ id: "history", role: "assistant", content: "synthetic history" });
const attachments = Object.freeze([{ id: "synthetic_attachment" }]);
const current = Object.freeze({ id: snapshot.sourceMessageId, role: "user", content: source, attachments });
const messages = Object.freeze([history, current]);

function fixture() {
  let now = 1_000;
  const session = createPromptRefinerSyntheticDecisionSession({ snapshot, now: () => now });
  const request = session.beginProposal();
  const response = {
    requestId: request.requestId, suggestionId: "synthetic_suggestion", refinedPrompt: refined,
    refinerVersion: "suggest-v1", inputScope: PROMPT_REFINER_INPUT_SCOPE,
  };
  const choice = (decision = "accepted") => ({ requestId: request.requestId, suggestionId: response.suggestionId, decision });
  return { session, request, response, choice, ready: () => session.completeProposal(request.requestId, response), setTime: (value) => { now = value; } };
}

function rejects(operation, code) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof PromptRefinerSyntheticDecisionError);
    assert.equal(error.code, code);
    assert.equal(error.message, `prompt_refiner_synthetic_${code}`);
    assert.equal("cause" in error, false);
    return true;
  });
}

test("C02 explicit preview choice alone produces one accepted synthetic execution view", () => {
  const f = fixture();
  const response = f.ready();
  const bound = bindPromptRefinerSuggestion({ request: f.request, response, currentPrompt: source });
  const preview = resolvePromptRefinerFixtureDecision({ suggestion: bound, currentPrompt: source, decision: "accepted" });
  assert.equal(preview.displayPrompt, source, "C02 composer still keeps its original draft");
  assert.equal(current.content, source);
  const projected = f.session.consumeSyntheticInput(messages, {
    requestId: preview.provenance.requestId, suggestionId: preview.provenance.suggestionId,
    decision: preview.decision,
  });
  assert.equal(projected.authoredMessages, messages);
  assert.equal(projected.authoredMessages[1].content, source);
  assert.equal(projected.executionMessages[1].content, refined);
  assert.equal(projected.executionMessages[0], history);
  assert.equal(projected.executionMessages[1].attachments, attachments);
  assert.equal(f.session.status(), "accepted");
  rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "unavailable");
  assert.equal(current.content, source);
});

test("explicit keep-original consumes once and preserves the exact transcript", () => {
  const f = fixture(); f.ready();
  const projected = f.session.consumeSyntheticInput(messages, f.choice("kept_original"));
  assert.equal(projected.authoredMessages, messages);
  assert.equal(projected.executionMessages, messages);
  assert.equal(projected.provenance.decision, "kept_original");
  assert.equal(f.session.status(), "kept_original");
  rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "unavailable");
});

test("requesting and ready states never automatically substitute an unconfirmed proposal", () => {
  for (const ready of [false, true]) {
    const f = fixture(); if (ready) f.ready();
    const projected = f.session.consumeSyntheticInput(messages);
    assert.equal(projected.authoredMessages, messages);
    assert.equal(projected.executionMessages, messages);
    assert.equal(projected.provenance, null);
    rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "unavailable");
    rejects(() => f.ready(), "unavailable");
  }
});

test("close and error revoke pending and ready proposals without changing authored bytes", () => {
  for (const ready of [false, true]) for (const action of ["close", "fail"]) {
    const f = fixture(); if (ready) f.ready(); f.session[action]();
    rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "unavailable");
    rejects(() => f.ready(), "unavailable");
    assert.equal(f.session.consumeSyntheticInput(messages).executionMessages, messages);
    assert.equal(current.content, source);
  }
});

test("exact draft and each scope change revoke old decisions, including same-value ABA", () => {
  const changes = [
    { ...snapshot, draft: source + " " },
    { ...snapshot, sourceMessageId: "other_message" },
    ...["identityKey", "mountedSurface", "conversationId"].map((key) => ({ ...snapshot, scope: { ...scope, [key]: "other" } })),
  ];
  for (const change of changes) for (const ready of [false, true]) {
    const f = fixture(); if (ready) f.ready();
    f.session.updateSnapshot(change); f.session.updateSnapshot(snapshot);
    rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "stale");
    rejects(() => f.ready(), "stale");
    assert.equal(f.session.consumeSyntheticInput(messages).executionMessages, messages);
  }
});

test("superseded and late responses cannot replace the current server-held request", () => {
  const f = fixture(); f.ready();
  const next = f.session.beginProposal();
  rejects(() => f.ready(), "unavailable");
  const nextResponse = { ...f.response, requestId: next.requestId, refinedPrompt: "new synthetic proposal" };
  f.session.completeProposal(next.requestId, nextResponse);
  rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "invalid_choice");
  rejects(() => f.session.consumeSyntheticInput(messages, { ...f.choice(), requestId: next.requestId }), "unavailable");
  assert.equal(f.session.consumeSyntheticInput(messages).executionMessages, messages);
  const latest = f.session.beginProposal();
  f.session.completeProposal(latest.requestId, { ...nextResponse, requestId: latest.requestId });
  const projected = f.session.consumeSyntheticInput(messages, { ...f.choice(), requestId: latest.requestId });
  assert.equal(projected.executionMessages[1].content, nextResponse.refinedPrompt);
});

test("expiry boundary refuses ready acceptance and late completion without renewal", () => {
  for (const ready of [false, true]) {
    const f = fixture(); if (ready) f.ready();
    f.setTime(1_000 + PROMPT_REFINER_SYNTHETIC_PROPOSAL_TTL_MS);
    assert.equal(f.session.status(), "expired");
    rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "expired");
    rejects(() => f.ready(), "expired");
    assert.equal(f.session.consumeSyntheticInput(messages).executionMessages, messages);
  }
  const f = fixture(); f.ready();
  f.setTime(999 + PROMPT_REFINER_SYNTHETIC_PROPOSAL_TTL_MS);
  assert.equal(f.session.consumeSyntheticInput(messages, f.choice()).executionMessages[1].content, refined);
});

test("invalid choice, browser-provided text and claimed authorization fail closed", () => {
  for (const override of [{ decision: "auto" }, { refinedPrompt: "forged" }, { approved: true }, { executionPrompt: refined }]) {
    const f = fixture(); f.ready();
    rejects(() => f.session.consumeSyntheticInput(messages, { ...f.choice(), ...override }), "invalid_choice");
    rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "unavailable");
    assert.equal(current.content, source);
  }
  for (const override of [{ suggestionId: "forged" }, { requestId: "forged" }]) {
    const f = fixture(); f.ready();
    rejects(() => f.session.consumeSyntheticInput(messages, { ...f.choice(), ...override }), "invalid_choice");
    assert.equal(f.session.status(), "failed");
    rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "unavailable");
  }
});

test("failed transcript validation consumes the proposal and never exposes an execution view", () => {
  const invalid = [
    [history, { ...current, content: source + " " }],
    [history, { ...current, id: "other" }],
    [history, current, { ...current, id: "newer" }],
    [current, current],
  ];
  for (const transcript of invalid) {
    const f = fixture(); f.ready();
    rejects(() => f.session.consumeSyntheticInput(transcript, f.choice()), "invalid_transcript");
    rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "unavailable");
    assert.equal(current.content, source);
  }
});

test("an unreadable authoritative snapshot revokes ready state rather than trusting the old draft", () => {
  const f = fixture(); f.ready();
  rejects(() => f.session.updateSnapshot({ ...snapshot, scope: null }), "invalid_snapshot");
  rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "unavailable");
  assert.equal(f.session.consumeSyntheticInput(messages).executionMessages, messages);
});

test("adapter errors, response mismatch, no-op and private extra fields cannot seed ready state", () => {
  for (const override of [{ requestId: "other" }, { refinedPrompt: source }, { refinedPrompt: "" }, { provider: "secret" }]) {
    const f = fixture();
    rejects(() => f.session.completeProposal(f.request.requestId, { ...f.response, ...override }), "invalid_proposal");
    assert.equal(f.session.status(), "failed");
    rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "unavailable");
  }
});

test("external mutation of returned requests and responses cannot alter held state", () => {
  const f = fixture();
  const id = f.request.requestId;
  f.request.prompt = "forged source";
  const response = f.session.completeProposal(id, f.response);
  response.refinedPrompt = "forged proposal";
  f.response.refinedPrompt = "forged adapter response";
  const projected = f.session.consumeSyntheticInput(messages, f.choice());
  assert.equal(projected.authoredMessages[1].content, source);
  assert.equal(projected.executionMessages[1].content, refined);
});

test("clock failure, unknown state and a restarted session reject old ids", () => {
  for (const value of [999, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    const f = fixture(); f.ready(); f.setTime(value);
    rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "clock_invalid");
    f.setTime(1_001);
    rejects(() => f.session.consumeSyntheticInput(messages, f.choice()), "unavailable");
  }
  const f = fixture(); f.ready();
  const restarted = createPromptRefinerSyntheticDecisionSession({ snapshot, now: () => 1_000 });
  rejects(() => restarted.consumeSyntheticInput(messages, f.choice()), "unavailable");
});

test("status reports clock faults as a fixed error and leaves the proposal revoked", () => {
  let now = 1_000;
  const session = createPromptRefinerSyntheticDecisionSession({ snapshot, now: () => {
    if (now === null) throw new Error("synthetic clock error prose");
    return now;
  } });
  session.beginProposal();
  now = null;
  rejects(() => session.status(), "clock_invalid");
  now = 1_001;
  assert.equal(session.status(), "failed");
});

test("concurrent explicit choices have one winner and cannot replay acceptance", async () => {
  const f = fixture(); f.ready();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => f.session.consumeSyntheticInput(messages, f.choice())),
    Promise.resolve().then(() => f.session.consumeSyntheticInput(messages, f.choice("kept_original"))),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results[0].value.executionMessages[1].content, refined);
  assert.equal(results[1].reason.code, "unavailable");
  assert.equal(current.content, source);
});
