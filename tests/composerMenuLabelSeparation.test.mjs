import assert from "node:assert/strict";
import test from "node:test";

import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";
import { zh } from "../locales/zh.ts";
import { fr } from "../locales/fr.ts";
import { de } from "../locales/de.ts";
import { es } from "../locales/es.ts";
import { pt } from "../locales/pt.ts";

const dictionaries = { en, ko, zh, fr, de, es, pt };

// `chat.moreActions` used to name two unrelated controls: the composer's `+`
// button and the sidebar row's conversation overflow button. Renaming the
// composer to "add and tools" therefore renamed the sidebar too, and the
// sidebar menu renames, shares and deletes a conversation -- it adds nothing.
// The two are separate keys now, and this keeps them separate: a future
// terminology sweep that collapses them fails here rather than in an E2E run.
test("the composer menu and the conversation overflow menu have separate labels", () => {
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    const { moreActions, addAndTools } = dictionary.chat;

    assert.ok(moreActions, `${language} is missing chat.moreActions`);
    assert.ok(addAndTools, `${language} is missing chat.addAndTools`);
    assert.notEqual(
      moreActions,
      addAndTools,
      `${language} gives the composer menu and the conversation menu the same name`
    );
  }
});
