import assert from "node:assert/strict";
import test from "node:test";
import { chatWorkspaceGuideContent } from "../components/marketing/chatWorkspaceGuideContent.ts";

const languages = ["en", "ko", "zh", "fr", "de", "es", "pt"];

test("chat workspace guide is complete in every supported language", () => {
  assert.deepEqual(Object.keys(chatWorkspaceGuideContent).sort(), languages.sort());

  for (const language of languages) {
    const copy = chatWorkspaceGuideContent[language];
    assert.ok(copy.title.length > 10, `${language} title is missing`);
    assert.equal(copy.tourItems.length, 7, `${language} tour must explain seven controls`);
    assert.equal(copy.sections.length, 9, `${language} guide must contain ten sections including the tour`);
    assert.deepEqual(
      copy.sections.map((section) => section.id),
      [
        "states-and-labels",
        "projects",
        "labels",
        "lock-and-share",
        "models-and-panels",
        "ai-review",
        "files-and-drive",
        "credits-and-plans",
        "troubleshooting",
      ],
      `${language} section order changed`
    );
    assert.ok(copy.sections.every((section) => section.items.length >= 3));
  }
});

test("workspace guide states the critical project, label, sharing, and review limits", () => {
  const english = JSON.stringify(chatWorkspaceGuideContent.en).toLowerCase();
  assert.match(english, /automatically share content, files, or ai memory/);
  assert.match(english, /browser/);
  assert.match(english, /read-only snapshot/);
  assert.match(english, /does not browse the web/);
  assert.match(english, /not encryption/);
});
