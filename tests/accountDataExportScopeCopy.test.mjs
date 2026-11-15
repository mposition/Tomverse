import assert from "node:assert/strict";
import test from "node:test";
import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";

test("export copy names the scope and exclusions before a download is requested", () => {
  for (const text of [en.accountDataExport.pageDescription, en.accountDataExport.dataTabDescription]) {
    assert.match(text, /exportable account data/);
    assert.match(text, /non-user data.*excluded/);
    assert.doesNotMatch(text, /everything/);
  }
  for (const text of [ko.accountDataExport.pageDescription, ko.accountDataExport.dataTabDescription]) {
    assert.match(text, /내보내기 가능한 계정 데이터/);
    assert.match(text, /사용자 데이터가 아닌 항목은 제외/);
    assert.doesNotMatch(text, /데이터 전체/);
  }
});
