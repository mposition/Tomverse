import assert from "node:assert/strict";
import test from "node:test";
import { chatWorkspaceGuideContent } from "../components/marketing/chatWorkspaceGuideContent.ts";

const languages = ["en", "ko", "zh", "fr", "de", "es", "pt"];

test("chat workspace guide is complete in every supported language", () => {
  assert.deepEqual(Object.keys(chatWorkspaceGuideContent).sort(), languages.sort());

  for (const language of languages) {
    const copy = chatWorkspaceGuideContent[language];
    assert.ok(copy.title.length > 10, `${language} title is missing`);
    // Five since the labels filter went with the labels feature (2026-09-16),
    // and every language has to lose the same one: a tour that explains a
    // control one language no longer has is a tour that lies in that language.
    assert.equal(copy.tourItems.length, 5, `${language} tour must explain five controls`);
    assert.equal(copy.sections.length, 8, `${language} guide must contain nine sections including the tour`);
    assert.deepEqual(
      copy.sections.map((section) => section.id),
      [
        "states-and-labels",
        "projects",
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

test("workspace guide states the critical project, pin, sharing, and review limits", () => {
  const english = JSON.stringify(chatWorkspaceGuideContent.en).toLowerCase();
  assert.match(english, /automatically share content, files, or ai memory/);
  // A pin is account state, and saying so is the point of having moved it off
  // localStorage this round. The assertion this replaces asked only for the
  // word "browser", which the labels copy used to supply and which the
  // troubleshooting section still supplies -- so it kept passing after the
  // labels were removed and guarded nothing.
  assert.match(english, /on every device/);
  assert.match(english, /read-only snapshot/);
  assert.match(english, /does not browse the web/);
  assert.match(english, /not encryption/);
});

test("the removed labels feature is not described in any language", () => {
  // Seven languages, one sweep: a guide that still offers Work/Research/
  // Personal sends somebody looking for a control that is not there, and the
  // last two reviews each found a language the line-by-line pass had missed.
  // Stems, not whole words. The copy this replaced said "labeln" and
  // "favorisieren" in German and "加标签" in Chinese, and a `\blabels?\b`
  // pattern matched none of them -- the sweep would have passed on the exact
  // sentences the previous two reviews found.
  const labelWords =
    /label|라벨|标签|libell|étiquet|etiquet|rótulo|favorit|favoris|favorite|收藏/i;
  for (const [language, copy] of Object.entries(chatWorkspaceGuideContent)) {
    const prose = [
      copy.description,
      ...copy.tourItems.flatMap((item) => [item.term, item.detail]),
      ...copy.sections.flatMap((section) => [
        section.title,
        section.description,
        section.note ?? "",
        ...section.items.flatMap((item) => [item.term, item.detail]),
      ]),
    ].join(" ");
    assert.doesNotMatch(prose, labelWords, `${language} still describes labels`);
  }
});
