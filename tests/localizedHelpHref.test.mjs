import assert from "node:assert/strict";
import test from "node:test";
import { helpCentreHref } from "../lib/localizedHelpHref.ts";

test("help links preserve every supported app language", () => {
  for (const language of ["en", "ko", "zh", "fr", "de", "es", "pt"]) {
    assert.equal(
      helpCentreHref(language),
      `/support/help-centre?lang=${language}`
    );
  }
});

test("the retired chat workspace guide has no link builder", async () => {
  const helpHrefs = await import("../lib/localizedHelpHref.ts");
  assert.equal("chatWorkspaceGuideHref" in helpHrefs, false);
});
