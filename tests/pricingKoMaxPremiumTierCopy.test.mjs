import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../components/marketing/PricingPageContent.tsx", import.meta.url),
  "utf8",
);

test("Korean Max card names Premium as a model tier, not an unexplained plan", () => {
  const maxLine = source
    .split("\n")
    .find((line) => line.includes('name: "Max"') && line.includes("Max로 업그레이드"));
  assert.ok(maxLine, "ko Max plan is present");
  assert.doesNotMatch(maxLine, /Premium 사용량/);
  assert.match(maxLine, /Premium 등급 모델 사용에는 월 크레딧 및 공정 사용 정책 적용/);
});
