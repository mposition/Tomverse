/**
 * Places an adoption draft's sentences next to the field they describe.
 *
 * The draft still speaks in one Korean list. The dialog used to print that
 * list above the controls. A sentence whose prefix names a field is a hint on
 * that field. The sale class already has its own confirmation, so its
 * sentence is not repeated. Anything else is a blocker the form has no field
 * for.
 */

import type { AdoptionPriceView } from "@/lib/modelAdoptionDraft";

export const ADOPTION_FIELD_HINTS = {
  registryId: ["Registry ID"],
  minimumPlan: ["최소 플랜"],
  supportsImage: ["이미지 입력 지원"],
  supportsNativePdf: ["Native PDF"],
  reasoning: ["추론 강도"],
  contextWindowTokens: ["컨텍스트 윈도우"],
  maxOutputTokens: ["최대 출력 토큰", "최대 출력 상한"],
  reservationOutputTokens: ["예약 출력 토큰"],
  price: ["입력·출력 단가", "장문 구간", "프로모션 문구", "공급자 문서"],
} as const;

const ATTACHED_ELSEWHERE = ["판매 등급과 크레딧"];

export type AdoptionHintField = keyof typeof ADOPTION_FIELD_HINTS;

export function adoptionSentencePrefix(line: string) {
  const mark = " — ";
  const at = line.indexOf(mark);
  return at === -1 ? line : line.slice(0, at);
}

export function partitionAdoptionGuidance(lines: readonly string[]) {
  const byField = Object.fromEntries(
    (Object.keys(ADOPTION_FIELD_HINTS) as AdoptionHintField[]).map((field) => [
      field,
      [] as string[],
    ])
  ) as Record<AdoptionHintField, string[]>;
  const blockers: string[] = [];
  for (const line of lines) {
    const prefix = adoptionSentencePrefix(line);
    if ((ATTACHED_ELSEWHERE as readonly string[]).includes(prefix)) continue;
    const field = (Object.keys(ADOPTION_FIELD_HINTS) as AdoptionHintField[]).find((key) =>
      (ADOPTION_FIELD_HINTS[key] as readonly string[]).includes(prefix)
    );
    if (field) byField[field].push(line);
    else blockers.push(line);
  }
  return { byField, blockers };
}

/** Price sentences the tier table and the inherited lead already say. */
const PRICE_HINTS_REPLACED_BY_SHAPE = new Set(["입력·출력 단가", "장문 구간"]);

export function priceHintsForView(
  lines: readonly string[],
  shape: AdoptionPriceView["shape"] | null
) {
  // A withheld price has no table, so the draft's own sentences stay.
  if (shape !== "tiered" && shape !== "inherited") return lines;
  return lines.filter((line) => !PRICE_HINTS_REPLACED_BY_SHAPE.has(adoptionSentencePrefix(line)));
}
