import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxSessionPlanRefusalPanel } from "@/components/admin/AmuxSessionPlanRefusalPanel";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";

test("the panel shows nothing until a refusal is read", () => {
  assert.equal(renderToStaticMarkup(createElement(AmuxSessionPlanRefusalPanel,
    { ideaId: "9942fb52-4b78-4af6-931a-9eec8f66d394" })), "");
});

test("both languages name both decisions", () => {
  for (const messages of [adminAmuxIdeaProgressMessages.en, adminAmuxIdeaProgressMessages.ko]) {
    assert.ok(messages.planRefusalRetry && messages.planRefusalStop && messages.planRefusalTitle);
  }
});
