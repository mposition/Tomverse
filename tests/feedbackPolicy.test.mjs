import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_MESSAGE_MIN_LENGTH,
  canSubmitFeedback,
  classifyFeedbackFailure,
  composeFeedbackMessage,
  feedbackFailureCopyKey,
  feedbackMessageState,
  feedbackReferenceFromId,
  isFeedbackReference,
  isPlausibleTraceId,
  isRetryableFeedbackFailure,
  sanitizeFeedbackDiagnostics,
} from "../lib/feedbackPolicy.ts";
import { guestVerificationFailureKey } from "../components/chat/guestVerificationCopy.ts";
import { ko } from "../locales/ko.ts";
import { en } from "../locales/en.ts";
import { zh } from "../locales/zh.ts";
import { fr } from "../locales/fr.ts";
import { de } from "../locales/de.ts";
import { es } from "../locales/es.ts";
import { pt } from "../locales/pt.ts";

const ROOT = resolve(import.meta.dirname, "..");
const read = (relativePath) => readFileSync(resolve(ROOT, relativePath), "utf8");

// ---------------------------------------------------------------------------
// The minimum length is product policy. These tests exist to make weakening it
// a visibly failing change rather than a quiet one.
// ---------------------------------------------------------------------------

test("the minimum stays at five characters, on both sides of the wire", () => {
  assert.equal(FEEDBACK_MESSAGE_MIN_LENGTH, 5);
  assert.equal(FEEDBACK_MESSAGE_MAX_LENGTH, 2_000);

  // The server contract this module mirrors, asserted against the route source
  // so the two can never drift apart unnoticed.
  const route = read("app/api/feedback/route.ts");
  assert.match(
    route,
    /message:\s*z\.string\(\)\.trim\(\)\.min\(5\)\.max\(2_000\)/,
    "the server schema no longer enforces trim().min(5).max(2_000)"
  );
});

test("an empty box cannot submit and is told the rule up front", () => {
  const state = feedbackMessageState("");
  assert.equal(state.kind, "empty");
  assert.equal(state.trimmedLength, 0);
  assert.equal(state.remaining, 5);
  assert.equal(state.isValid, false);
  assert.equal(canSubmitFeedback({ message: "" }), false);
});

test("one to four characters report how many are still missing", () => {
  for (const [value, remaining] of [
    ["a", 4],
    ["ab", 3],
    ["abc", 2],
    ["abcd", 1],
  ]) {
    const state = feedbackMessageState(value);
    assert.equal(state.kind, "tooShort", value);
    assert.equal(state.remaining, remaining, value);
    assert.equal(canSubmitFeedback({ message: value }), false, value);
  }
});

test("exactly five characters can be sent", () => {
  const state = feedbackMessageState("abcde");
  assert.equal(state.kind, "ready");
  assert.equal(state.trimmedLength, 5);
  assert.equal(state.remaining, 0);
  assert.equal(canSubmitFeedback({ message: "abcde" }), true);
});

test("surrounding whitespace is not a character on either side", () => {
  // Four real characters wrapped in padding: the server would trim it to four
  // and reject, so the client must too.
  assert.equal(feedbackMessageState("   abcd   ").trimmedLength, 4);
  assert.equal(canSubmitFeedback({ message: "   abcd   " }), false);
  // Five real characters with padding is fine.
  assert.equal(canSubmitFeedback({ message: "  abcde  " }), true);
});

test("whitespace alone is never a message", () => {
  for (const value of ["     ", "\n\n\n\n\n\n", "\t \t \t \t", "      "]) {
    assert.equal(feedbackMessageState(value).trimmedLength, 0, JSON.stringify(value));
    assert.equal(canSubmitFeedback({ message: value }), false, JSON.stringify(value));
  }
});

test("the maximum is 2,000 characters and one more is refused", () => {
  const atLimit = "a".repeat(2_000);
  assert.equal(feedbackMessageState(atLimit).kind, "ready");
  assert.equal(canSubmitFeedback({ message: atLimit }), true);

  const overLimit = "a".repeat(2_001);
  const state = feedbackMessageState(overLimit);
  assert.equal(state.kind, "tooLong");
  assert.equal(state.available, 0);
  assert.equal(canSubmitFeedback({ message: overLimit }), false);
});

// ---------------------------------------------------------------------------
// Error-report mode satisfies the contract, it does not bypass it.
// ---------------------------------------------------------------------------

test("error-report mode can submit with no typing, using a compliant default", () => {
  const defaultMessage = ko.feedback.errorReportDefaultMessage;
  assert.ok(
    feedbackMessageState(defaultMessage).isValid,
    "the default description must itself satisfy the five-character minimum"
  );
  assert.equal(
    canSubmitFeedback({ message: "", isErrorReport: true, defaultMessage }),
    true
  );
});

test("error-report mode does not silently replace a half-written sentence", () => {
  const defaultMessage = ko.feedback.errorReportDefaultMessage;
  assert.equal(
    canSubmitFeedback({ message: "ab", isErrorReport: true, defaultMessage }),
    false
  );
});

test("a default that would not satisfy the minimum cannot unlock submission", () => {
  assert.equal(
    canSubmitFeedback({ message: "", isErrorReport: true, defaultMessage: "no" }),
    false
  );
});

test("general feedback keeps the minimum even in a chat that has errored", () => {
  // Same component, no rawErrorDetails: the ordinary rule applies.
  assert.equal(canSubmitFeedback({ message: "abcd", isErrorReport: false }), false);
});

test("every locale's error-report default satisfies the server contract", () => {
  for (const [name, dictionary] of Object.entries({ ko, en, zh, fr, de, es, pt })) {
    assert.ok(
      feedbackMessageState(dictionary.feedback.errorReportDefaultMessage).isValid,
      `${name} default description does not satisfy the minimum`
    );
  }
});

// ---------------------------------------------------------------------------
// Composition and sanitisation
// ---------------------------------------------------------------------------

test("attached diagnostics never push the body past the server maximum", () => {
  const composed = composeFeedbackMessage({
    description: "Something broke",
    rawErrorDetails: "x".repeat(5_000),
  });
  assert.ok(composed.length <= FEEDBACK_MESSAGE_MAX_LENGTH);
  assert.ok(composed.startsWith("Something broke"), "the user's own words were cut");
  assert.ok(composed.includes("[truncated]"));
});

/**
 * Credential-shaped fixtures are assembled here rather than written out as
 * literals. They are all fake, but a literal one is still a JWT-shaped string
 * committed to the repository, and the secret scanner is right to flag it --
 * `.gitleaks.toml`'s allowlist is deliberately narrow (see
 * tests/gitleaksAllowlist.test.mjs), so the fix is to not commit the shape,
 * not to teach the scanner to ignore it.
 */
const fakeJwt = () =>
  ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NSJ9", "QWxsRG9uZUhlcmVOb3c"].join(".");
const fakeOpenAiKey = () => `sk${"-"}livesecretvalue1234567890`;
const fakeAwsKeyId = () => `AKIA${"IOSFODNN7EXAMPLE"}`;

test("credentials in an auto-attached error never leave the browser", () => {
  const jwt = fakeJwt();
  const openAiKey = fakeOpenAiKey();
  const awsKeyId = fakeAwsKeyId();
  const raw = [
    "Request failed",
    "authorization: Bearer abcdefghijklmnop",
    "Cookie: tomverse_guest=abc123; next-auth.session-token=zzz",
    `api_key=${openAiKey}`,
    `token: ${jwt}`,
    `aws ${awsKeyId}`,
  ].join("\n");
  const sanitized = sanitizeFeedbackDiagnostics(raw);

  for (const secret of [
    "abcdefghijklmnop",
    "next-auth.session-token",
    openAiKey,
    jwt.split(".")[0],
    awsKeyId,
  ]) {
    assert.ok(!sanitized.includes(secret), `${secret} survived sanitisation`);
  }
  // The shape of the report survives, so support can still read it.
  assert.ok(sanitized.startsWith("Request failed"));
  assert.ok(sanitized.includes("[redacted]"));
});

test("ordinary diagnostics are left readable", () => {
  const raw = "Model gpt-5-4-mini returned an empty response.\nTrace ID: 1f2e3d4c";
  assert.equal(sanitizeFeedbackDiagnostics(raw), raw);
});

// ---------------------------------------------------------------------------
// Trace ID
// ---------------------------------------------------------------------------

test("a trace ID is optional and never blocks a submission", () => {
  assert.equal(isPlausibleTraceId(""), true);
  assert.equal(isPlausibleTraceId("   "), true);
  // A missing trace ID has no bearing on whether the message may be sent.
  assert.equal(canSubmitFeedback({ message: "abcde" }), true);
});

test("a real trace ID is accepted without a hint", () => {
  assert.equal(isPlausibleTraceId("0d1f6b1e-9a2c-4d3f-8b7a-5c6d7e8f9012"), true);
  assert.equal(isPlausibleTraceId("qa-trace-gemini-2-5-flash"), true);
});

test("an obviously wrong trace ID is hinted at, not rejected", () => {
  assert.equal(isPlausibleTraceId("what happened yesterday"), false);
  assert.equal(isPlausibleTraceId("x".repeat(121)), false);
  // It is only a hint: the message itself is still submittable.
  assert.equal(canSubmitFeedback({ message: "abcde" }), true);
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

test("HTTP results map onto the closed set of user-facing failures", () => {
  assert.equal(classifyFeedbackFailure(400, "INVALID_REQUEST"), "invalid");
  assert.equal(classifyFeedbackFailure(401), "verification");
  assert.equal(classifyFeedbackFailure(403, "TURNSTILE_REQUIRED"), "verification");
  assert.equal(classifyFeedbackFailure(403, "TURNSTILE_FAILED"), "verification");
  assert.equal(classifyFeedbackFailure(503, "TURNSTILE_UNAVAILABLE"), "verification");
  assert.equal(classifyFeedbackFailure(413, "REQUEST_BODY_TOO_LARGE"), "tooLarge");
  assert.equal(classifyFeedbackFailure(429, "API_RATE_LIMITED"), "rateLimited");
  assert.equal(classifyFeedbackFailure(500, "FEEDBACK_SUBMIT_FAILED"), "server");
  assert.equal(classifyFeedbackFailure(418), "unknown");
});

test("a rate-limited submission is described as retryable", () => {
  assert.equal(isRetryableFeedbackFailure("rateLimited"), true);
  assert.equal(isRetryableFeedbackFailure("server"), true);
  assert.equal(isRetryableFeedbackFailure("network"), true);
  assert.equal(isRetryableFeedbackFailure("invalid"), false);
});

test("a malformed code cannot smuggle itself into the classification", () => {
  // Anything outside the allow-listed shape is ignored, and only the status
  // decides -- a response body can never steer the copy.
  assert.equal(
    classifyFeedbackFailure(500, "turnstile please enter your password"),
    "server"
  );
  assert.equal(classifyFeedbackFailure(400, "<script>alert(1)</script>"), "invalid");
});

test("every failure resolves to a real locale string in every language", () => {
  const failures = [
    "invalid",
    "verification",
    "tooLarge",
    "rateLimited",
    "server",
    "network",
    "unknown",
  ];
  for (const [name, dictionary] of Object.entries({ ko, en, zh, fr, de, es, pt })) {
    for (const failure of failures) {
      const key = feedbackFailureCopyKey(failure).split(".")[1];
      const copy = dictionary.feedback[key];
      assert.equal(typeof copy, "string", `${name}.feedback.${key} is missing`);
      assert.ok(copy.length > 5, `${name}.feedback.${key} is empty`);
    }
    assert.ok(
      dictionary.feedback.errorUnknown.includes("{reference}"),
      `${name} unknown-error copy drops the reference placeholder`
    );
  }
});

test("guest verification failures resolve on both surfaces in every language", () => {
  const failures = ["failed", "unavailable", "cancelled", "timeout", "expired"];
  for (const [name, dictionary] of Object.entries({ ko, en, zh, fr, de, es, pt })) {
    for (const failure of failures) {
      for (const surface of ["chat", "feedback"]) {
        const [namespace, key] = guestVerificationFailureKey(failure, surface).split(".");
        const copy = dictionary[namespace][key];
        assert.equal(
          typeof copy,
          "string",
          `${name}.${namespace}.${key} is missing (${surface})`
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Localisation completeness
// ---------------------------------------------------------------------------

test("every locale carries the whole feedback namespace", () => {
  const expected = Object.keys(en.feedback).sort();
  for (const [name, dictionary] of Object.entries({ ko, zh, fr, de, es, pt })) {
    const actual = Object.keys(dictionary.feedback).sort();
    assert.deepEqual(
      actual,
      expected,
      `${name}.feedback does not match the English key set`
    );
    for (const key of expected) {
      assert.equal(
        typeof dictionary.feedback[key],
        "string",
        `${name}.feedback.${key} is not a string`
      );
      assert.ok(
        dictionary.feedback[key].trim().length > 0,
        `${name}.feedback.${key} is blank`
      );
    }
  }
});

test("placeholders survive translation", () => {
  const placeholders = {
    messageHelp: "{min}",
    messageRemaining: "{count}",
    messageTooLong: "{max}",
    sentWithReference: "{reference}",
    errorUnknown: "{reference}",
  };
  for (const [name, dictionary] of Object.entries({ ko, en, zh, fr, de, es, pt })) {
    for (const [key, placeholder] of Object.entries(placeholders)) {
      assert.ok(
        dictionary.feedback[key].includes(placeholder),
        `${name}.feedback.${key} lost ${placeholder}`
      );
    }
    assert.ok(dictionary.feedback.messageCounter.includes("{count}"));
    assert.ok(dictionary.feedback.messageCounter.includes("{max}"));
  }
});

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

test("a reference is a short, quotable handle derived from the record id", () => {
  const reference = feedbackReferenceFromId("clz9x1a2b3c4d5e6f7g8h9i0");
  assert.equal(reference, "F7G8H9I0");
  assert.ok(isFeedbackReference(reference));
});

test("only a well-shaped reference is ever displayed", () => {
  assert.equal(isFeedbackReference("ABCD1234"), true);
  assert.equal(isFeedbackReference("<script>"), false);
  assert.equal(isFeedbackReference("way too long to be a reference"), false);
  assert.equal(isFeedbackReference(42), false);
  assert.equal(isFeedbackReference(null), false);
});

// ---------------------------------------------------------------------------
// Source-level guards
// ---------------------------------------------------------------------------

test("neither feedback surface hand-rolls its own submission or copy", () => {
  for (const path of [
    "components/chat/FeedbackButton.tsx",
    "components/marketing/SupportPageContent.tsx",
  ]) {
    const source = read(path);
    assert.match(source, /submitFeedback/, `${path} bypasses the shared client`);
    assert.ok(
      !/fetch\(\s*["']\/api\/feedback/.test(source),
      `${path} calls /api/feedback directly instead of the shared client`
    );
  }
});

test("a guest submission asks for a token; a signed-in one does not", () => {
  const source = read("components/chat/FeedbackButton.tsx");
  assert.match(source, /status === "unauthenticated"/);
  assert.match(source, /useTurnstile\(isGuest && open, "support_request",/);
  assert.match(source, /if \(isGuest\) \{/);
});

test("no feedback surface logs a Turnstile token", () => {
  for (const path of [
    "components/chat/FeedbackButton.tsx",
    "components/marketing/SupportPageContent.tsx",
    "lib/feedbackClient.ts",
    "app/api/feedback/route.ts",
  ]) {
    const source = read(path);
    const logged = source.match(/console\.(log|info|warn|error)\([\s\S]*?\)/g) || [];
    for (const call of logged) {
      assert.ok(
        !/turnstileToken|\btoken\b/.test(call),
        `${path} logs something token-shaped: ${call.slice(0, 120)}`
      );
      assert.ok(
        !/body\.message|rawErrorDetails|userAgent|cookie/i.test(call),
        `${path} logs submission content: ${call.slice(0, 120)}`
      );
    }
  }
});
