"use client";

import { useLanguage } from "@/components/LanguageProvider";
import { CreditCoinIcon } from "@/components/credits/CreditCostBadge";
import type { Language } from "@/lib/language";
import { formatLocalizedInteger, pluralizeUnit } from "@/lib/pricingFormat";
import { chatAnswerSurfaceCopy } from "@/locales/chatAnswerSurface";

/** "3 credits" / "3크레딧" in the reader's language, with its plural form. */
export function answerCreditsText(credits: number, lang: Language): string {
  const copy = chatAnswerSurfaceCopy[lang];
  return pluralizeUnit(
    credits,
    { one: copy.answerCreditsOne, other: copy.answerCreditsOther },
    lang
  ).replace("{credits}", formatLocalizedInteger(credits, lang));
}

/**
 * The credits a finished Chat answer was actually charged, beside its tools.
 * Only ever given a settled figure of at least one credit
 * (lib/chatAnswerCreditsCore.ts); it never estimates.
 */
export function AnswerCreditsLabel({ credits }: { credits: number }) {
  const { lang } = useLanguage();
  const copy = chatAnswerSurfaceCopy[lang];
  return (
    <span
      data-testid="chat-answer-credits"
      title={copy.answerCreditsTitle}
      className="inline-flex min-h-9 items-center gap-1 px-2 text-[12px] font-semibold tabular-nums text-zinc-500 dark:text-zinc-400"
    >
      <CreditCoinIcon className="h-3.5 w-3.5" />
      <span className="sr-only">{copy.answerCreditsTitle}: </span>
      {answerCreditsText(credits, lang)}
    </span>
  );
}
