import assert from "node:assert/strict";
import test from "node:test";
import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";

test("the empty history describes the retained 90-day window rather than lifetime activity", () => {
  assert.match(en.accountDataExport.historyEmpty, /last 90 days/);
  assert.match(ko.accountDataExport.historyEmpty, /최근 90일간/);
  assert.doesNotMatch(en.accountDataExport.historyEmpty, /not.*yet|never/i);
  assert.doesNotMatch(ko.accountDataExport.historyEmpty, /적이 없/);
});
