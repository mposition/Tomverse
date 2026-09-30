import assert from "node:assert/strict";
import test from "node:test";
import { chatHelpCopy } from "../components/chat/chatHelpCopy.ts";

const languages = ["en", "ko", "zh", "fr", "de", "es", "pt"];

test("contextual chat help is available in every supported language", () => {
  assert.deepEqual(Object.keys(chatHelpCopy).sort(), languages.sort());

  for (const language of languages) {
    const copy = chatHelpCopy[language];
    // Two steps since labels were removed (2026-09-16): projects, then status.
    // Every language has to lose the same step, or one of them walks a tour
    // whose second card highlights nothing.
    assert.equal(copy.tourSteps.length, 2, `${language} sidebar tour is incomplete`);
    // CJK copy conveys the same information with substantially fewer characters.
    assert.ok(copy.statusDescription.length > 50, `${language} status help is too short`);
    assert.ok(copy.projectsDescription.length > 40, `${language} project help is too short`);
    assert.ok(copy.shareDialogSnapshot.length > 30);
  }
});

test("English and Korean copy state the critical product boundaries", () => {
  assert.match(chatHelpCopy.en.projectsDescription, /do not automatically share/i);
  assert.match(chatHelpCopy.en.shareDialogSnapshot, /not added.*automatically/i);
  assert.match(chatHelpCopy.en.aiReviewDescription, /does not search external sources/i);
  assert.match(chatHelpCopy.ko.projectsDescription, /자동으로 공유하지/);
});

test("the labels feature left nothing behind in the help copy", () => {
  // Labels were three fixed values kept in one browser, duplicating projects
  // and silently absent on a second device. A stray string is how a removed
  // feature comes back: somebody finds the copy and wires a surface to it.
  for (const copy of Object.values(chatHelpCopy)) {
    for (const [key, value] of Object.entries(copy)) {
      assert.equal(/label/i.test(key), false, `${key} is a leftover of the labels feature`);
      if (typeof value === "string") {
        assert.equal(/\blabels?\b/i.test(value), false, `${key} still mentions labels`);
      }
    }
  }
});
