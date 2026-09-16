import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORTED_LANGUAGES } from "../lib/language";
import { AUTOFIX_CASE_STATE } from "../lib/feedbackAutoFixCore";
import { isValidFeedbackUserReply } from "../lib/feedbackLifecycleCore";
import {
  AUTOFIX_REPLY_DRAFTS_FOR_TEST,
  autoFixReplyDraft,
} from "../lib/feedbackAutoFixReplyDraft";

/**
 * The reply draft. What must hold:
 *   - it exists only once a fix was observed live in production;
 *   - it is a valid user reply in every product language, as written;
 *   - it never carries an identifier the completed email forbids.
 */

test("only a production-verified case gets a draft", () => {
  for (const state of Object.values(AUTOFIX_CASE_STATE)) {
    const draft = autoFixReplyDraft({ caseState: state, language: "en" });
    assert.equal(
      Boolean(draft),
      state === AUTOFIX_CASE_STATE.productionVerified,
      state
    );
  }
  assert.equal(autoFixReplyDraft({ caseState: null, language: "en" }), null);
});

test("the draft is written for the fixed outcome in the reporter's language", () => {
  const ko = autoFixReplyDraft({
    caseState: AUTOFIX_CASE_STATE.productionVerified,
    language: "ko",
  });
  assert.equal(ko?.outcomeCode, "fixed");
  assert.equal(ko?.userReply, AUTOFIX_REPLY_DRAFTS_FOR_TEST.ko);
  const unknown = autoFixReplyDraft({
    caseState: AUTOFIX_CASE_STATE.productionVerified,
    language: "xx",
  });
  assert.equal(unknown?.userReply, AUTOFIX_REPLY_DRAFTS_FOR_TEST.en);
});

test("every language has a valid draft without technical identifiers", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const text = AUTOFIX_REPLY_DRAFTS_FOR_TEST[language];
    assert.ok(isValidFeedbackUserReply(text), language);
    assert.doesNotMatch(text, /trace|PR\b|commit|[0-9a-f]{8,}|https?:/i, language);
  }
});
