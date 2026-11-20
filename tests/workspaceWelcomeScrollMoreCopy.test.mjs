import assert from "node:assert/strict";
import test from "node:test";

import { workspaceWelcomeCopy } from "../locales/workspaceWelcome.ts";

test("Korean starter scroll button names the action, not a position", () => {
  const label = workspaceWelcomeCopy.ko.starter.scrollMore;
  assert.equal(label, "추천 질문 더 보기");
  assert.doesNotMatch(label, /아래|위/);
});
