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
  looksLikeUnknownSecret,
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
const assemble = (...parts) => parts.join("");

const fakeJwt = () =>
  ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NSJ9", "QWxsRG9uZUhlcmVOb3c"].join(".");
const fakeOpenAiKey = () => `sk${"-"}livesecretvalue1234567890`;
const fakeAwsKeyId = () => `AKIA${"IOSFODNN7EXAMPLE"}`;
/** A Google-shaped key: `AIza` followed by 35 characters. */
const fakeGoogleKey = () =>
  assemble("AIza", "SyD1x9Qp", "LmNv2345", "abcdEFGH", "ijkLMNop", "QRs");
/** A vendor prefix the denylist has never heard of. */
const fakeVendorKey = () =>
  assemble("nvapi-", "Xy7Kq2Lm", "9Pw4Rt8Zc", "1Vb6Nh3Jd", "5Fg0As");
/** A bare 48-character hex digest. */
const fakeHexDigest = () =>
  assemble("a3f5c9e1", "b7d24089", "f9a1c3e5", "b7d9f012", "34567890", "abcdef12", "34");
/** A base64 blob. */
const fakeBase64Secret = () =>
  assemble("dGhpcyBp", "c0FSYW5k", "b21CYXNl", "NjRTZWNy", "ZXQxMjM0", "NTY3ODk=");

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

// ---------------------------------------------------------------------------
// Credential shapes nobody registered a pattern for
//
// A denylist is only ever as good as the formats it was told about. These pin
// the second, shape-based pass: it must catch a generated credential whatever
// issued it, and must not eat the trace ID the feature exists to carry.
// ---------------------------------------------------------------------------

test("a credential in an unregistered format is still removed", () => {
  const unknownSecrets = [
    fakeGoogleKey(),
    fakeVendorKey(),
    fakeHexDigest(),
    fakeBase64Secret(),
  ];
  for (const secret of unknownSecrets) {
    assert.equal(looksLikeUnknownSecret(secret), true, secret);
    const sanitized = sanitizeFeedbackDiagnostics(`upstream rejected ${secret}`);
    assert.ok(!sanitized.includes(secret), `${secret} survived sanitisation`);
    assert.ok(sanitized.includes("[redacted]"));
  }
});

test("the trace ID a user is asked to quote is never redacted", () => {
  // The whole point of attaching diagnostics is to carry this back to support.
  const traceId = "0d1f6b1e-9a2c-4d3f-8b7a-5c6d7e8f9012";
  assert.equal(looksLikeUnknownSecret(traceId), false);
  const sanitized = sanitizeFeedbackDiagnostics(`Trace ID: ${traceId}`);
  assert.ok(sanitized.includes(traceId));
});

test("ordinary diagnostic tokens are not mistaken for secrets", () => {
  const keep = [
    "claude-haiku-4-5-20251001",
    "gemini-2-5-flash",
    "components/chat/FeedbackButton.tsx",
    "app/api/internal/maintenance/notification-deliveries/route.ts",
    "PLAN_DAILY_CREDIT_LIMIT_REACHED",
    "OPERATIONAL_COST_GUARDRAIL_TRIGGERED",
    "2026-08-01T12:00:00.000Z",
    "https://api.example.com/v1/chat/completions",
    "1754049600000",
    "support@tomverse.app",
  ];
  for (const token of keep) {
    assert.equal(looksLikeUnknownSecret(token), false, token);
    assert.ok(
      sanitizeFeedbackDiagnostics(`context ${token} end`).includes(token),
      `${token} was redacted`
    );
  }
});

test("a realistic error report keeps its diagnostics and loses its key", () => {
  const googleKey = fakeGoogleKey();
  const sanitized = sanitizeFeedbackDiagnostics(
    [
      "Request failed for model claude-haiku-4-5-20251001.",
      "Trace ID: 0d1f6b1e-9a2c-4d3f-8b7a-5c6d7e8f9012",
      `Upstream said: invalid key ${googleKey}`,
      "at components/chat/ChatApp.tsx:812",
    ].join("\n")
  );
  assert.ok(sanitized.includes("claude-haiku-4-5-20251001"));
  assert.ok(sanitized.includes("0d1f6b1e-9a2c-4d3f-8b7a-5c6d7e8f9012"));
  assert.ok(sanitized.includes("components/chat/ChatApp.tsx:812"));
  assert.ok(!sanitized.includes(googleKey));
});

test("punctuation around a secret does not shield it", () => {
  const secret = fakeGoogleKey();
  for (const wrapped of [`"${secret}"`, `(${secret})`, `${secret},`, `[${secret}]`]) {
    const sanitized = sanitizeFeedbackDiagnostics(`key=${wrapped}`);
    assert.ok(!sanitized.includes(secret), wrapped);
  }
});

test("a short token is left alone however random it looks", () => {
  // Redacting every short mixed token would gut the diagnostics.
  assert.equal(looksLikeUnknownSecret("Ab3Xy9Zq"), false);
  assert.equal(looksLikeUnknownSecret("Err500Retry2"), false);
});

test("the user is shown exactly what will be attached, and can change it", () => {
  const source = read("components/chat/FeedbackButton.tsx");
  // The preview renders the sanitised text, not the raw details.
  assert.match(source, /sanitizedDiagnostics = useMemo/);
  assert.match(source, /data-testid="feedback-diagnostics-body"/);
  // And it is a field, not a read-only block: a pattern cannot know what it
  // missed, so the person reading it has to be able to delete it.
  assert.match(source, /value=\{effectiveDiagnostics\}/);
  assert.match(source, /onChange=\{\(event\) => setDiagnostics\(event\.target\.value\)\}/);
  // Or drop the attachment entirely.
  assert.match(source, /data-testid="feedback-diagnostics-attach"/);
  // What is sent is what was shown, edits included.
  assert.match(source, /rawErrorDetails: effectiveDiagnostics \|\| undefined,/);
  // And the copy button hands over the same thing.
  assert.match(source, /clipboard\.writeText\(effectiveDiagnostics\)/);
  assert.ok(
    !/clipboard\.writeText\(rawErrorDetails\)/.test(source),
    "the copy button still hands over unsanitised text"
  );
});

// ---------------------------------------------------------------------------
// Closing mid-flight
// ---------------------------------------------------------------------------

test("closing is never blocked while a submission is in flight", () => {
  const source = read("components/chat/FeedbackButton.tsx");
  const closeDialog = source.slice(
    source.indexOf("const closeDialog"),
    source.indexOf("const openDialog")
  );
  // The old guard returned early while sending, locking the dialog shut for
  // as long as the request took.
  assert.ok(
    !/if \(submittingRef\.current\) return;/.test(closeDialog),
    "closeDialog still refuses to close during a send"
  );
  assert.match(closeDialog, /setOpen\(false\)/);
  // The close control itself is live too.
  const closeButton = source.slice(
    source.indexOf('data-testid="feedback-close"'),
    source.indexOf('data-testid="feedback-close"') + 400
  );
  assert.ok(
    !/disabled=\{isSending\}/.test(closeButton),
    "the close button is still disabled while sending"
  );
});

test("an outcome that lands after the dialog closed still reaches the user", () => {
  const source = read("components/chat/FeedbackButton.tsx");
  assert.match(source, /const reportFailure = \(failure: SubmitError\) => \{/);
  // Inline when visible, toast when not: the dialog is no longer the only
  // channel a failure can use.
  assert.match(source, /if \(openRef\.current\) return;/);
  assert.match(source, /dispatchAppToast\(text, "error"\)/);
});

// ---------------------------------------------------------------------------
// The fixtures police themselves
//
// Twice now a credential-shaped literal was committed in a test fixture and
// the secret scanner caught it in CI rather than here. The detector this work
// added is exactly the tool for the job, so it is pointed at this feature's
// own source: a fake key is still a real key *shape* in the history, and
// .gitleaks.toml's allowlist is deliberately narrow (tests/gitleaksAllowlist.
// test.mjs), so the fix is always to assemble the fixture at runtime.
// ---------------------------------------------------------------------------

test("no file this feature owns commits a credential shape", () => {
  const owned = [
    "lib/feedbackPolicy.ts",
    "lib/feedbackClient.ts",
    "lib/notificationRetryCore.ts",
    "lib/notificationDeliveries.ts",
    "lib/notificationDeliveryJob.ts",
    "lib/supportNotificationEmail.ts",
    "components/chat/FeedbackButton.tsx",
    "app/api/feedback/route.ts",
    "tests/feedbackPolicy.test.mjs",
    "tests/notificationRetryCore.test.mjs",
    "tests/e2e/feedback-modal.spec.ts",
    "tests/server-contract/feedback-route.test.ts",
    "tests/server-contract/notification-delivery-queue.test.ts",
  ];

  for (const path of owned) {
    const source = read(path);
    const offenders = (source.match(/[A-Za-z0-9+/_-]{20,}={0,2}/g) || []).filter(
      (candidate) => looksLikeUnknownSecret(candidate)
    );
    assert.deepEqual(
      offenders,
      [],
      `${path} contains a credential-shaped literal; assemble it at runtime instead`
    );
  }
});
