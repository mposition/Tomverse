import { de } from "@/locales/de";
import { en } from "@/locales/en";
import { es } from "@/locales/es";
import { fr } from "@/locales/fr";
import { ko } from "@/locales/ko";
import { pt } from "@/locales/pt";
import { zh } from "@/locales/zh";
import type { Language } from "@/lib/language";

/** The id `DocumentShell` puts on the wrapper this link jumps to. */
export const MAIN_CONTENT_ID = "main-content";

const dictionaries = { ko, en, zh, fr, de, es, pt };

/**
 * UX-016. WCAG 2.4.1 (Level A): a keyboard user must be able to skip the
 * repeated blocks at the top of a page. On `/chat` with a populated sidebar
 * that was roughly thirty tab stops before the composer, on every load.
 *
 * Rendered by `DocumentShell`, so it exists on every route under both roots --
 * which is also why it is a server component that takes `lang` rather than
 * calling `useLanguage()`. `DocumentShell` sits *above* `LanguageProvider`
 * (the providers live inside `children`), so a context read here fails at
 * prerender time on every localized marketing route.
 *
 * The target is a wrapper `DocumentShell` also renders, not a page's `<main>`:
 * the marketing pages each declare their own `<main>` and the shells declare
 * theirs, so pointing at one id would mean editing every page and would break
 * silently on any new one. The wrapper is `display: contents`, so it adds a
 * focus target and nothing else -- no box, no landmark, no layout effect.
 *
 * Visually hidden until focused, which is what makes it the first tab stop
 * without being visible chrome for everyone else.
 */
export function SkipToContentLink({ lang }: { lang: Language }) {
  const label =
    dictionaries[lang]?.skipLink?.toMainContent ?? en.skipLink.toMainContent;

  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      data-testid="skip-to-content"
      className="sr-only rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white focus-visible:not-sr-only focus-visible:absolute focus-visible:left-3 focus-visible:top-3 focus-visible:z-[200] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
    >
      {label}
    </a>
  );
}
