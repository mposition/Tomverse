import assert from "node:assert/strict";
import test from "node:test";

import {
  preflightInputEstimate,
  profileTextFor,
  turnCarriesAttachments,
} from "../lib/autoDispatchPreflight.ts";
import { estimateRawTextTokens } from "../lib/chatTokenEstimate.ts";
import { selectAutoModel } from "../lib/autoModelSelection.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";

// The chat route can only choose a model before it knows the input size if
// something computes that size without a model. These tests are about the one
// case where it cannot be honest -- an attachment -- and about the estimate
// agreeing with the accumulator it has to stand in for.

const text = (content, role = "user") => ({ role, content });

test("a turn with no attachment carries none, whatever the key looks like", () => {
  assert.equal(turnCarriesAttachments([text("hello")]), false);
  assert.equal(turnCarriesAttachments([{ ...text("hello"), attachments: [] }]), false);
  assert.equal(
    turnCarriesAttachments([{ ...text("hello"), attachments: undefined }]),
    false
  );
  assert.equal(turnCarriesAttachments([]), false);
});

test("one attachment anywhere in the turn is an attachment turn", () => {
  assert.equal(
    turnCarriesAttachments([
      text("first"),
      { ...text("second"), attachments: [{ name: "a.pdf" }] },
    ]),
    true
  );
});

// The estimate is exact only when nothing had to be guessed, and the flag is
// what stops a caller routing on a lower bound.
test("the estimate reports whether it is the size or a floor", () => {
  assert.equal(preflightInputEstimate([text("hello")]).exact, true);
  assert.equal(
    preflightInputEstimate([{ ...text("hello"), attachments: [{ name: "a.pdf" }] }])
      .exact,
    false
  );
});

test("every message counts, because the whole transcript is sent", () => {
  const one = preflightInputEstimate([text("hello")]).estimatedInputTokens;
  const three = preflightInputEstimate([
    text("hello"),
    text("there", "assistant"),
    text("again"),
  ]).estimatedInputTokens;
  assert.ok(three > one);
});

// The chat route's own accumulator applies a one-token floor per piece,
// because an empty message still costs the provider its role framing. Two
// figures that disagreed about a turn containing one would put a request on
// the wrong side of a context window.
test("an empty message costs a token here too", () => {
  assert.equal(preflightInputEstimate([text("")]).estimatedInputTokens, 1);
  assert.equal(
    preflightInputEstimate([text(""), text("")]).estimatedInputTokens,
    2
  );
});

test("the estimate is the tokenizer's own count, not a second opinion", () => {
  const content = "이 계약서를 요약해 주세요. Summarise this contract, please.";
  assert.equal(
    preflightInputEstimate([text(content)]).estimatedInputTokens,
    Math.max(1, estimateRawTextTokens(content))
  );
});

test("a non-string content is read as empty rather than thrown on", () => {
  assert.equal(
    preflightInputEstimate([{ role: "user", content: { parts: [] } }])
      .estimatedInputTokens,
    1
  );
});

// The profile describes the request, not the conversation: a model chosen
// from the whole transcript would be chosen for something the user already
// had an answer to.
test("the profile text is the last user message", () => {
  assert.equal(
    profileTextFor([
      text("first question"),
      text("an answer", "assistant"),
      text("second question"),
    ]),
    "second question"
  );
});

test("a turn with no user message profiles as empty rather than as the assistant's", () => {
  assert.equal(profileTextFor([text("an answer", "assistant")]), "");
  assert.equal(profileTextFor([]), "");
});

// --- the boundary itself ---

const ready = { ready: true, outstanding: [], problems: [] };
const openCohort = {
  killSwitch: false,
  rolloutPercent: 100,
  salt: "cohort-2026-08",
  eligiblePlans: ["Pro"],
};

const selection = (overrides = {}) =>
  selectAutoModel({
    requestedModelId: "gpt-5-6-luna",
    conversation: {
      selectionMode: "auto",
      routerModelId: null,
      routerChallengerTurns: 0,
    },
    subjectKey: "user_abc",
    isGuest: false,
    plan: "Pro",
    attachmentsPresent: false,
    text: "이 문장을 영어로 번역해 주세요.",
    attachments: [],
    webSearchRequested: false,
    models: AVAILABLE_MODELS,
    reservedInputTokens: 1_200,
    requestOutputCapTokens: 4_000,
    cohortConfig: openCohort,
    readiness: ready,
    ...overrides,
  });

test("an attachment turn falls back instead of routing on a guess", () => {
  const refused = selection({ attachmentsPresent: true });
  assert.equal(refused.routed, false);
  assert.equal(refused.reason, "attachments_present");
  assert.equal(refused.fallbackModelId, "gpt-5-6-luna");
});

// Reported after the cohort, so the count means "turns that would otherwise
// have routed" -- the number that says what the limitation costs.
test("an attachment turn outside the cohort is a cohort refusal, not an attachment one", () => {
  const refused = selection({ attachmentsPresent: true, plan: "Free" });
  assert.equal(refused.reason, "cohort_refused");
});

test("the same turn without the attachment routes", () => {
  assert.equal(selection().routed, true);
});
