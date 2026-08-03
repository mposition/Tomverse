import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildFeedbackLifecycleEmail } from "../lib/feedbackLifecycleEmails.ts";
import {
  FEEDBACK_CLOSURE_OUTCOMES,
  FEEDBACK_LIFECYCLE_STAGE,
} from "../lib/feedbackLifecycleCore.ts";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";

// The submitter-facing lifecycle emails. What must hold:
//
//  - every supported language renders every stage and every closure outcome,
//    as both HTML and plain text;
//  - the completed wording is decided by the outcome code, and only `fixed`
//    and `shipped` may claim a fix or a release;
//  - everything interpolated from the input is escaped in the HTML;
//  - the module cannot even carry the report body, admin notes, trace IDs or
//    user agents -- pinned against its source;
//  - rendering is deterministic, because the retry queue depends on a retried
//    payload matching the first attempt byte for byte.

const ROOT = resolve(import.meta.dirname, "..");
const STAGES = Object.values(FEEDBACK_LIFECYCLE_STAGE);
const REFERENCE = "AB12CD34";

const build = (stage, overrides = {}) =>
  buildFeedbackLifecycleEmail(stage, {
    reference: REFERENCE,
    type: "bug",
    language: "en",
    ...overrides,
  });

// --- coverage ----------------------------------------------------------------

test("every supported language renders every stage with subject, text and html", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    for (const stage of STAGES) {
      for (const type of ["bug", "feature"]) {
        const message = build(stage, {
          language,
          type,
          ...(stage === "completed" ? { outcomeCode: "answered" } : {}),
        });
        assert.ok(
          message.subject.includes("Tomverse"),
          `${language}/${stage} subject is missing the brand`
        );
        assert.ok(
          message.subject.includes(REFERENCE),
          `${language}/${stage} subject is missing the reference`
        );
        assert.ok(
          message.text.includes(REFERENCE),
          `${language}/${stage} text is missing the reference`
        );
        assert.ok(
          message.html.includes(REFERENCE),
          `${language}/${stage} html is missing the reference`
        );
        assert.ok(
          message.html.includes("/support"),
          `${language}/${stage} html is missing the support contact`
        );
        assert.ok(
          message.text.includes("/support"),
          `${language}/${stage} text is missing the support contact`
        );
      }
    }
  }
});

test("every closure outcome renders in every supported language", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    for (const outcomeCode of FEEDBACK_CLOSURE_OUTCOMES) {
      const message = build("completed", { language, outcomeCode });
      assert.ok(message.subject.length > 0);
      assert.ok(message.text.length > 0);
      assert.ok(message.html.length > 0);
    }
  }
});

// --- the outcome decides the wording -----------------------------------------

/**
 * The completion claims each language is allowed to make -- and therefore the
 * strings that must NOT appear unless the outcome actually is a fix or a
 * release.
 */
const COMPLETION_CLAIMS = {
  ko: ["수정했", "수정되었", "출시되었"],
  en: ["has been fixed", "has shipped", "has been released"],
  zh: ["已修复", "已上线", "已发布"],
  fr: ["a été corrigé", "a été publié"],
  de: ["wurde behoben", "wurde veröffentlicht"],
  es: ["se ha corregido", "se ha publicado"],
  pt: ["foi corrigido", "foi publicada"],
};

test("only fixed and shipped may claim a fix or a release", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const claims = COMPLETION_CLAIMS[language];
    assert.ok(claims, `no claim list for ${language}`);
    for (const outcomeCode of FEEDBACK_CLOSURE_OUTCOMES) {
      if (outcomeCode === "fixed" || outcomeCode === "shipped") continue;
      const message = build("completed", { language, outcomeCode });
      const rendered = `${message.subject}\n${message.text}\n${message.html}`;
      for (const claim of claims) {
        assert.ok(
          !rendered.includes(claim),
          `${language}/${outcomeCode} claims completion: "${claim}"`
        );
      }
    }
    // And the two that may claim it actually do, so the assertion above is
    // testing real strings rather than a stale list.
    const fixed = build("completed", { language, outcomeCode: "fixed" });
    assert.ok(
      claims.some((claim) => fixed.text.includes(claim) || fixed.subject.includes(claim)),
      `${language}/fixed makes no completion claim at all`
    );
  }
});

test("the Korean copy matches the product's exact wording", () => {
  assert.equal(
    build("received", { language: "ko" }).subject,
    `[Tomverse] 오류 신고가 접수되었습니다 (${REFERENCE})`
  );
  assert.equal(
    build("received", { language: "ko", type: "feature" }).subject,
    `[Tomverse] 피드백이 접수되었습니다 (${REFERENCE})`
  );
  assert.equal(
    build("reviewing", { language: "ko" }).subject,
    `[Tomverse] 신고 내용을 검토하고 있습니다 (${REFERENCE})`
  );
  assert.equal(
    build("completed", { language: "ko", outcomeCode: "fixed" }).subject,
    `[Tomverse] 신고해 주신 오류를 수정했습니다 (${REFERENCE})`
  );
  assert.equal(
    build("completed", {
      language: "ko",
      type: "feature",
      outcomeCode: "planned",
    }).subject,
    `[Tomverse] 피드백 검토 결과를 안내드립니다 (${REFERENCE})`
  );
  assert.ok(
    build("completed", { language: "ko", outcomeCode: "not_reproduced" }).text.includes(
      "현재 동일한 문제를 재현하지 못했습니다"
    )
  );
  assert.ok(
    build("completed", { language: "ko", outcomeCode: "not_planned" }).text.includes(
      "검토를 완료했으나 현재 변경 계획에는 포함되지 않았습니다"
    )
  );
});

test("an unknown outcome falls back to the neutral wording, not a crash", () => {
  const message = build("completed", { outcomeCode: "definitely-not-a-code" });
  const other = build("completed", { outcomeCode: "other" });
  assert.equal(message.subject, other.subject);
  assert.equal(message.text, other.text);
});

test("an unknown language falls back to English", () => {
  const message = build("received", { language: "xx" });
  assert.equal(message.subject, build("received", { language: "en" }).subject);
  assert.equal(
    build("received", { language: null }).subject,
    build("received", { language: "en" }).subject
  );
});

// --- the reply ---------------------------------------------------------------

test("the user-facing reply is included, escaped, and only when present", () => {
  const withReply = build("completed", {
    outcomeCode: "answered",
    userReply: `Thanks <script>alert("x")</script> & "done"`,
  });
  assert.ok(withReply.html.includes("&lt;script&gt;"));
  assert.ok(!withReply.html.includes("<script>alert"));
  assert.ok(withReply.html.includes("&amp;"));
  assert.ok(withReply.text.includes('Thanks <script>alert("x")</script> & "done"'));

  const withoutReply = build("completed", { outcomeCode: "answered" });
  assert.ok(!withoutReply.html.includes("Reply from Tomverse"));
  const blankReply = build("completed", {
    outcomeCode: "answered",
    userReply: "   ",
  });
  assert.equal(blankReply.html, withoutReply.html);
});

test("a hostile reference cannot break out of the markup", () => {
  const message = build("received", { reference: `<img src=x onerror=1>` });
  assert.ok(!message.html.includes("<img"));
  assert.ok(message.html.includes("&lt;img"));
});

// --- what the module cannot carry --------------------------------------------

test("the input type cannot carry the report body or diagnostics", () => {
  const source = readFileSync(
    resolve(ROOT, "lib", "feedbackLifecycleEmails.ts"),
    "utf8"
  );
  // Fields that must never reach a submitter email; the builder's input type
  // simply does not have them, and nothing in the module names them.
  for (const forbidden of [
    "traceId",
    "adminNote",
    "userAgent",
    "modelId",
    "feedbackId",
    "input.message",
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `lib/feedbackLifecycleEmails.ts mentions ${forbidden}`
    );
  }
});

// --- determinism -------------------------------------------------------------

test("rendering is deterministic for a given input", () => {
  const input = {
    language: "ko",
    outcomeCode: "fixed",
    userReply: "재현 절차 감사합니다. 다음 배포에 포함되었습니다.",
  };
  const first = build("completed", input);
  const second = build("completed", input);
  assert.deepEqual(first, second);
});
