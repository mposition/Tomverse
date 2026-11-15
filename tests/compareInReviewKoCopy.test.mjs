import assert from "node:assert/strict";
import test from "node:test";
import { ko } from "../locales/ko.ts";
import { mobileCompareInReviewCopy } from "../locales/mobileCompareInReview.ts";

test("the Korean compare action uses the same Korean label on web and mobile", () => {
  assert.equal(ko.chat.compareInReview, "여러 모델로 비교");
  assert.equal(mobileCompareInReviewCopy("ko").label, ko.chat.compareInReview);
});
