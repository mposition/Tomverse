import { defineAdminMessages } from "@/lib/adminLocale";

export const adminAmuxCardDisplayKeyBackfillMessages = defineAdminMessages({
  en: {
    title: "Card number backfill",
    description:
      "Gives existing cards their readable number (AMUX-PREFIX-NNN) and prefix-less Features a prefix derived from their title. Load the plan, check it, then apply exactly that plan. Numbers never change once written.",
    load: "Load plan",
    loading: "Loading plan…",
    readFailed: "The plan could not be loaded.",
    writeFailed: "The backfill was not applied.",
    empty: "Every card already has a number and every Feature a prefix. Nothing to apply.",
    summary: (features: number, cards: number, unresolved: number) =>
      `${features} Feature prefix(es) and ${cards} card number(s) to write; ${unresolved} card(s) cannot be numbered.`,
    featuresHeading: "Feature prefixes",
    featureFrom: (from: "title" | "fallback"): string =>
      from === "title" ? "from the title" : "no usable title: generic prefix",
    untitled: "(title unavailable)",
    cardsHeading: "Card numbers",
    unresolvedHeading: "Not numbered",
    unresolvedReason: (reason: string) => ({
      unknown_source: "unknown source system",
      feature_missing: "its Feature row is missing",
      feature_without_prefix: "its Feature has no prefix",
      number_exhausted: "the prefix has no numbers left",
    })[reason] ?? reason,
    digest: "Plan digest",
    apply: "Apply this plan",
    applying: "Applying…",
    applied: (features: number, cards: number) =>
      `Applied: ${features} Feature prefix(es) and ${cards} card number(s).`,
    planChanged: "The data changed since this plan was loaded. Load the plan again and check it before applying.",
    nothingToApply: "There was nothing left to apply.",
    writeConflict: "A card or Feature changed while the plan was being written, so nothing was written. Load the plan again and check it before applying.",
    outcomeUnknown: "The answer was lost. Load the plan again to see whether the backfill was applied before retrying.",
  },
  ko: {
    title: "카드 번호 backfill",
    description:
      "기존 카드에 읽기 쉬운 번호(AMUX-PREFIX-NNN)를 주고, PREFIX가 없는 Feature에는 제목에서 유도한 PREFIX를 줍니다. 계획을 불러와 확인한 뒤 바로 그 계획만 적용합니다. 한 번 쓴 번호는 바뀌지 않습니다.",
    load: "계획 불러오기",
    loading: "계획을 불러오는 중…",
    readFailed: "계획을 불러오지 못했습니다.",
    writeFailed: "backfill을 적용하지 못했습니다.",
    empty: "모든 카드에 번호가 있고 모든 Feature에 PREFIX가 있습니다. 적용할 것이 없습니다.",
    summary: (features: number, cards: number, unresolved: number) =>
      `Feature PREFIX ${features}개와 카드 번호 ${cards}개를 씁니다. 번호를 줄 수 없는 카드는 ${unresolved}개입니다.`,
    featuresHeading: "Feature PREFIX",
    featureFrom: (from: "title" | "fallback"): string =>
      from === "title" ? "제목에서 유도" : "쓸 수 있는 제목 없음: 일반 PREFIX",
    untitled: "(제목 확인 불가)",
    cardsHeading: "카드 번호",
    unresolvedHeading: "번호를 주지 않는 카드",
    unresolvedReason: (reason: string) => ({
      unknown_source: "알 수 없는 원천",
      feature_missing: "Feature 행이 없음",
      feature_without_prefix: "Feature에 PREFIX가 없음",
      number_exhausted: "PREFIX의 번호가 모두 소진됨",
    })[reason] ?? reason,
    digest: "계획 digest",
    apply: "이 계획 적용",
    applying: "적용하는 중…",
    applied: (features: number, cards: number) =>
      `적용했습니다. Feature PREFIX ${features}개, 카드 번호 ${cards}개.`,
    planChanged: "계획을 불러온 뒤 데이터가 바뀌었습니다. 계획을 다시 불러와 확인한 뒤 적용하세요.",
    nothingToApply: "적용할 것이 남아 있지 않았습니다.",
    writeConflict: "계획을 쓰는 동안 카드나 Feature가 바뀌어 아무것도 쓰지 않았습니다. 계획을 다시 불러와 확인한 뒤 적용하세요.",
    outcomeUnknown: "응답을 받지 못했습니다. 다시 시도하기 전에 계획을 다시 불러와 적용 여부를 확인하세요.",
  },
});
