import assert from "node:assert/strict";
import test from "node:test";
import {
  partitionAdoptionGuidance,
  priceHintsForView,
} from "../lib/adoptionDialogGuidance.ts";

test("adoption sentences land on their fields, and the sale class is not repeated", () => {
  const guidance = partitionAdoptionGuidance([
    "입력·출력 단가 — 비워 두세요.",
    "장문 구간 — 272,000 입력 토큰 초과.",
    "판매 등급과 크레딧 — 확정해야 저장됩니다.",
    "최소 플랜 — Pro로 두었습니다.",
    "컨텍스트 윈도우 — 문서에서 채웠습니다.",
    "Registry ID — 다른 모델의 profile입니다.",
    "이 문장은 칸이 없습니다.",
  ]);
  assert.deepEqual(guidance.byField.price, [
    "입력·출력 단가 — 비워 두세요.",
    "장문 구간 — 272,000 입력 토큰 초과.",
  ]);
  assert.deepEqual(guidance.byField.minimumPlan, ["최소 플랜 — Pro로 두었습니다."]);
  assert.deepEqual(guidance.byField.contextWindowTokens, ["컨텍스트 윈도우 — 문서에서 채웠습니다."]);
  assert.deepEqual(
    partitionAdoptionGuidance(["최대 출력 상한 — API 값으로 판단했습니다."]).byField.maxOutputTokens,
    ["최대 출력 상한 — API 값으로 판단했습니다."]
  );
  assert.deepEqual(guidance.byField.registryId, ["Registry ID — 다른 모델의 profile입니다."]);
  assert.deepEqual(guidance.blockers, ["이 문장은 칸이 없습니다."]);
  assert.equal(
    [...Object.values(guidance.byField).flat(), ...guidance.blockers].some((line) =>
      line.startsWith("판매 등급과 크레딧")
    ),
    false
  );
});

test("a tiered or inherited price does not repeat the sentence the table already says", () => {
  const lines = ["입력·출력 단가 — 비워 두세요.", "프로모션 문구 — 기간이 있습니다."];
  assert.deepEqual(priceHintsForView(lines, "tiered"), ["프로모션 문구 — 기간이 있습니다."]);
  assert.deepEqual(priceHintsForView(lines, "inherited"), ["프로모션 문구 — 기간이 있습니다."]);
  assert.deepEqual(priceHintsForView(lines, "flat"), lines);
});
