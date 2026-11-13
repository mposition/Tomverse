import assert from "node:assert/strict";
import test from "node:test";

import { composerModelCountLabel } from "../components/chat/composerModelCountLabel.ts";
import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";

const label = (dictionary, count) =>
  composerModelCountLabel(
    count,
    dictionary.chat.modelsSelectedOne,
    dictionary.chat.modelsSelectedOther
  );

// At 320px the footer model button wrapped the Korean label to a lone "1"
// over "개 모델". The label keeps the count and unit on one line.
test("the composer model count label has no breakable space", () => {
  for (const dictionary of [en, ko]) {
    for (const count of [1, 3]) {
      const text = label(dictionary, count);
      assert.ok(text.startsWith(`${count} `), text);
      assert.doesNotMatch(text, / /, `${text} can wrap between the count and its unit`);
    }
  }
});

test("the composer model count label still reads as the localized count", () => {
  assert.equal(label(ko, 1).replace(/ /g, " "), "1 개 모델");
  assert.equal(label(en, 3).replace(/ /g, " "), `3 ${en.chat.modelsSelectedOther}`);
});
