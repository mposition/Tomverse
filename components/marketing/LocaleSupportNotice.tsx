"use client";

import { CircleAlert } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { getLocaleLaunchPolicy } from "@/lib/localeLaunchPolicy";

export const MARKETING_LOCALE_NOTICE_ID = "marketing-locale-support-notice";

export function LocaleSupportNotice({
  localizedContentAvailable = true,
  maxWidth = "max-w-7xl",
}: {
  localizedContentAvailable?: boolean;
  maxWidth?: string;
}) {
  const { lang } = useLanguage();
  const policy = getLocaleLaunchPolicy(lang);
  if (policy.marketTier === "primary") return null;

  const message = localizedContentAvailable
    ? policy.scopeNotice
    : policy.englishFallbackNotice;
  if (!message) return null;

  return (
    <aside
      id={MARKETING_LOCALE_NOTICE_ID}
      role="note"
      lang={localizedContentAvailable ? lang : undefined}
      data-market-tier={policy.marketTier}
      data-paid-marketing-eligible={String(policy.paidMarketingEligible)}
      className="border-b border-amber-300/70 bg-amber-50 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/35 dark:text-amber-100"
    >
      <div
        className={`mx-auto flex ${maxWidth} items-start gap-3 px-4 py-3 text-xs leading-5 sm:px-6 lg:px-8`}
      >
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <span className="font-black">{policy.badge}</span>
          <span className="ml-2 font-medium">{message}</span>
        </div>
      </div>
    </aside>
  );
}
