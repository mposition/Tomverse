import assert from "node:assert/strict";
import test from "node:test";
import { chatHelpCopy } from "../components/chat/chatHelpCopy.ts";

const languages = ["en", "ko", "zh", "fr", "de", "es", "pt"];

test("contextual chat help is available in every supported language", () => {
  assert.deepEqual(Object.keys(chatHelpCopy).sort(), languages.sort());

  for (const language of languages) {
    const copy = chatHelpCopy[language];
    assert.equal(copy.tourSteps.length, 3, `${language} sidebar tour is incomplete`);
    // CJK copy conveys the same information with substantially fewer characters.
    assert.ok(copy.statusDescription.length > 50, `${language} status help is too short`);
    assert.ok(copy.labelsDescription.length > 40, `${language} label help is too short`);
    assert.ok(copy.projectsDescription.length > 40, `${language} project help is too short`);
    assert.ok(copy.emptyLabels.work.length > 10);
    assert.ok(copy.shareDialogSnapshot.length > 30);
  }
});

test("English and Korean copy state the critical product boundaries", () => {
  assert.match(chatHelpCopy.en.labelsDescription, /stored in this browser/i);
  assert.match(chatHelpCopy.en.projectsDescription, /do not automatically share/i);
  assert.match(chatHelpCopy.en.shareDialogSnapshot, /not added.*automatically/i);
  assert.match(chatHelpCopy.en.aiReviewDescription, /does not search external sources/i);
  assert.match(chatHelpCopy.ko.labelsDescription, /현재 브라우저/);
  assert.match(chatHelpCopy.ko.projectsDescription, /자동으로 공유하지/);
});
