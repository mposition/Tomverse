import assert from "node:assert/strict";
import test from "node:test";
import {
  chatWorkspaceGuideHref,
  helpCentreHref,
} from "../lib/localizedHelpHref.ts";

test("help links preserve every supported app language", () => {
  for (const language of ["en", "ko", "zh", "fr", "de", "es", "pt"]) {
    assert.equal(
      chatWorkspaceGuideHref(language),
      `/support/help-centre/chat-workspace?lang=${language}`
    );
    assert.equal(
      helpCentreHref(language),
      `/support/help-centre?lang=${language}`
    );
  }
});

test("workspace guide sections keep the query before the fragment", () => {
  assert.equal(
    chatWorkspaceGuideHref("ko", "ai-review"),
    "/support/help-centre/chat-workspace?lang=ko#ai-review"
  );
  assert.equal(
    chatWorkspaceGuideHref("fr", "#credits-and-plans"),
    "/support/help-centre/chat-workspace?lang=fr#credits-and-plans"
  );
});

