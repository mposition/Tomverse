import assert from "node:assert/strict";
import test from "node:test";

import {
  attachmentTokensForModel,
  measureTurnAttachments,
  preflightInputEstimate,
  profileTextFor,
  turnCarriesAttachments,
} from "../lib/autoDispatchPreflight.ts";
import { estimateRawTextTokens } from "../lib/chatTokenEstimate.ts";
import { selectAutoModel } from "../lib/autoModelSelection.ts";
import { AVAILABLE_MODELS, modelSupportsNativePdfInput } from "../lib/models.ts";

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
    attachmentsUnmeasurable: false,
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

test("an unmeasurable attachment turn falls back instead of routing on a guess", () => {
  const refused = selection({ attachmentsUnmeasurable: true });
  assert.equal(refused.routed, false);
  assert.equal(refused.reason, "attachments_unmeasurable");
  assert.equal(refused.fallbackModelId, "gpt-5-6-luna");
});

// Reported after the cohort, so the count means "turns that would otherwise
// have routed" -- the number that says what the limitation costs.
test("an unmeasurable turn outside the cohort is a cohort refusal, not an attachment one", () => {
  const refused = selection({ attachmentsUnmeasurable: true, plan: "Free" });
  assert.equal(refused.reason, "cohort_refused");
});

test("a measured attachment turn routes", () => {
  assert.equal(selection().routed, true);
});

// --- measurement ---

// Sizes come from the attachment rows the request layer resolved, so nothing
// here is a figure a client stated and nothing here reads object storage. The
// prefix check survives as the second line of defence: a row that somehow
// named a key outside its owner's storage is refused rather than measured.
test("an attachment outside the caller's own prefix is refused, not measured", () => {
  const measured = measureTurnAttachments(
    [
      {
        mediaType: "application/pdf",
        size: 1024,
        objectKey: "attachments/someone-else/a.pdf",
      },
    ],
    "attachments/mine/"
  );
  assert.equal(measured.measurable, false);
  assert.equal(measured.reason, "not_own_object");
});

test("a caller with no prefix of their own measures nothing", () => {
  const measured = measureTurnAttachments(
    [
      {
        mediaType: "application/pdf",
        size: 1024,
        objectKey: "attachments/mine/a.pdf",
      },
    ],
    null
  );
  assert.equal(measured.measurable, false);
  assert.equal(measured.reason, "not_own_object");
});

test("an attachment that resolved to no storage key cannot be measured", () => {
  const measured = measureTurnAttachments(
    [{ mediaType: "image/png", size: 10, objectKey: "" }],
    "attachments/mine/"
  );
  assert.equal(measured.measurable, false);
  assert.equal(measured.reason, "unresolved");
});

// A stored size of zero is not a small file -- the finalisation step refuses
// an empty object -- so it means the row does not know, and all-or-nothing
// applies.
test("an attachment with no recorded size cannot be measured", () => {
  const measured = measureTurnAttachments(
    [{ mediaType: "image/png", size: 0, objectKey: "attachments/mine/a.png" }],
    "attachments/mine/"
  );
  assert.equal(measured.measurable, false);
  assert.equal(measured.reason, "unmeasurable");
});

test("a turn with no attachment measures as an empty, measurable set", () => {
  const measured = measureTurnAttachments([], "attachments/mine/");
  assert.equal(measured.measurable, true);
  assert.deepEqual(measured.descriptors, []);
});

test("resolved attachments measure to their stored sizes, in order", () => {
  const measured = measureTurnAttachments(
    [
      {
        mediaType: "application/pdf",
        size: 2048,
        objectKey: "attachments/mine/a.pdf",
      },
      {
        mediaType: "image/png",
        size: 512,
        objectKey: "attachments/mine/b.png",
      },
    ],
    "attachments/mine/"
  );
  assert.equal(measured.measurable, true);
  assert.deepEqual(measured.descriptors, [
    { mediaType: "application/pdf", size: 2048 },
    { mediaType: "image/png", size: 512 },
  ]);
});

// --- per-model cost ---

// A real catalogue entry rather than a hand-built object: the cost function
// reads capability through the catalogue's own predicate, and a fixture that
// spelled the field differently would test the fixture.
const anyModel = AVAILABLE_MODELS[0];

test("no attachments cost every model nothing", () => {
  const cost = attachmentTokensForModel([]);
  for (const entry of AVAILABLE_MODELS) assert.equal(cost(entry), 0);
});

// The whole reason the filter takes a callback: one figure would be wrong for
// one side or the other.
test("the same PDF costs a native reader and an extractor differently", () => {
  const cost = attachmentTokensForModel([
    { mediaType: "application/pdf", size: 2_000_000 },
  ]);
  // The catalogue's own predicate, not a guess at the field that carries it.
  const native = AVAILABLE_MODELS.find(modelSupportsNativePdfInput);
  const extractor = AVAILABLE_MODELS.find(
    (entry) => !modelSupportsNativePdfInput(entry)
  );
  assert.ok(native && extractor, "the catalogue has both kinds of model");
  assert.notEqual(
    cost(native),
    cost(extractor),
    "one number was used for both, so the filter is wrong for one of them"
  );
});

test("an extracted attachment's cost is bounded rather than proportional forever", () => {
  const cost = attachmentTokensForModel([
    { mediaType: "text/plain", size: 500_000_000 },
  ]);
  assert.ok(cost(anyModel) <= 75_000 + 1);
});
