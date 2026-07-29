"use client";

import { Languages } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { usePathname, useRouter } from "next/navigation";
import {
  LOCALIZED_SEO_PATHS,
  SEO_LOCALES,
  localizedPath,
} from "@/lib/seo";
import {
  getLocaleLaunchPolicy,
  localeLaunchPolicy,
} from "@/lib/localeLaunchPolicy";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { MARKETING_LOCALE_NOTICE_ID } from "./LocaleSupportNotice";

const languageOptions: Language[] = ["ko", "en", "zh", "fr", "de", "es", "pt"];

export function MarketingLanguageSwitcher() {
  const { lang, setLang } = useLanguage();
  const pathname = usePathname();
  const router = useRouter();
  const selectedPolicy = getLocaleLaunchPolicy(lang);

  const localizedBasePath = () => {
    if (LOCALIZED_SEO_PATHS.includes(pathname as (typeof LOCALIZED_SEO_PATHS)[number])) {
      return pathname;
    }
    const segments = pathname.split("/").filter(Boolean);
    if (
      segments.length >= 1 &&
      SEO_LOCALES.includes(segments[0] as Language)
    ) {
      const remainder = segments.length === 1 ? "/" : `/${segments.slice(1).join("/")}`;
      if (LOCALIZED_SEO_PATHS.includes(remainder as (typeof LOCALIZED_SEO_PATHS)[number])) {
        return remainder;
      }
    }
    return null;
  };

  // min-w-0 lets this control absorb the marketing header's horizontal shrink
  // so the brand beside it keeps a whole word at 320px (FINAL-F004): the
  // selected option's label truncates here instead of the brand name.
  return (
    <label
      data-market-tier={selectedPolicy.marketTier}
      // REAUDIT-F005. The select carries `outline-none` so its native focus
      // ring cannot clash with the pill, but nothing replaced it: focused and
      // unfocused screenshots of this control were identical, and it was the
      // only control in the marketing header without a visible focus state
      // (WCAG 2.4.7). The ring goes on the label rather than the select
      // because the label is `overflow-hidden` -- an outline drawn inside it
      // would be clipped, while a ring on the label's own box is not.
      className="inline-flex h-10 min-w-0 max-w-[10.5rem] items-center gap-2 overflow-hidden rounded-xl border border-zinc-300 bg-white px-2.5 text-sm font-bold text-zinc-700 shadow-sm transition hover:bg-zinc-50 focus-within:ring-2 focus-within:ring-blue-600 focus-within:ring-offset-2 dark:focus-within:ring-blue-400 dark:focus-within:ring-offset-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 sm:max-w-none sm:px-3"
    >
      <Languages className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
      <span className="sr-only">Language</span>
      <select
        aria-label="Language"
        aria-describedby={
          selectedPolicy.marketTier === "primary"
            ? undefined
            : MARKETING_LOCALE_NOTICE_ID
        }
        value={lang}
        onChange={(event) => {
          const nextLanguage = event.target.value as Language;
          const basePath = localizedBasePath();
          // RECON-I18N-001. Emitted before anything else in this handler,
          // because `router.push` below leaves the localized routes' own root
          // layout and therefore reloads the document -- an event queued after
          // it would race the unload. The delivery itself is `keepalive`, so
          // the request survives the navigation either way; this only makes
          // sure it is issued.
          //
          // `navigation` is the reason this event exists: switching language
          // costs about 2x when it crosses the root boundary, and that cost
          // was accepted on the argument that the path is rare. This is what
          // lets that argument be checked.
          trackProductEvent("marketing_language_switched", 0, {
            language_from: lang,
            language_to: nextLanguage,
            navigation: basePath ? "document" : "client",
          });
          setLang(nextLanguage);
          if (basePath) router.push(localizedPath(nextLanguage, basePath));
        }}
        className="min-w-0 flex-1 cursor-pointer truncate bg-transparent text-sm font-bold text-zinc-800 outline-none [color-scheme:light] dark:text-zinc-100 dark:[color-scheme:dark]"
      >
        {languageOptions.map((language) => (
          <option
            key={language}
            value={language}
            className="bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
          >
            {localeLaunchPolicy[language].selectorLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
