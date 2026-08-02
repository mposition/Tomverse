import { ThemeBootstrap } from "@/components/ThemeBootstrap";
import { ThemeController } from "@/components/ThemeController";
import { fontVariables } from "@/lib/fonts";
import type { Language } from "@/lib/language";
import { themeDocumentClass, type ThemePreference } from "@/lib/theme";
import {
  MAIN_CONTENT_ID,
  SkipToContentLink,
} from "@/components/SkipToContentLink";

/**
 * The `<html>` / `<body>` wrapper every root layout renders.
 *
 * VAL-004 / RECON-I18N-001. This app has more than one root layout, because
 * `<html lang>` has more than one correct source:
 *
 * - `app/(site)/layout.tsx` serves the English marketing pages and the
 *   application. Their language is a property of the *request* (an explicit
 *   `?lang=`, or the browser's preference for the dynamic routes), which the
 *   proxy resolves into a header.
 * - `app/[locale]/layout.tsx` serves the localized marketing routes, which are
 *   prerendered one file per locale. Their language is a property of the
 *   *route*, known at build time and not readable from any header.
 *
 * A single shared root layout can see neither the other's source: it cannot
 * read a route param, and a header read would return nothing on a prerendered
 * page. That is why the split exists, and this component is what stops the two
 * roots drifting apart in everything else -- the font variables, the theme
 * bootstrap, the base classes are declared once.
 *
 * `suppressHydrationWarning` stays on `<html>` for the theme bootstrap, which
 * writes `class`/`data-theme` before React hydrates. It is deliberately *not*
 * covering `lang`: both roots now render the same language the client resolves
 * to, so a mismatch there is a defect to surface, not to silence.
 */
export function DocumentShell({
  lang,
  theme,
  nonce,
  children,
}: Readonly<{
  lang: Language;
  /**
   * UI-001. The explicit choice this request is known to carry, or null when
   * it cannot be known — which is every `force-static` marketing route, where
   * the HTML is prerendered once and cached publicly. Null renders no theme
   * class at all, so the stylesheet's `prefers-color-scheme` answers and
   * ThemeBootstrap corrects an explicit choice before the first paint. Writing
   * a per-visitor class into cacheable HTML would poison that cache.
   */
  theme?: ThemePreference | null;
  /** Present on nonce'd dynamic routes; absent on hash-based static ones. */
  nonce?: string;
  children: React.ReactNode;
}>) {
  const themeClass = theme ? themeDocumentClass(theme) : "";
  return (
    <html
      lang={lang}
      suppressHydrationWarning
      data-theme={theme || undefined}
      className={`${fontVariables} h-full antialiased${themeClass ? ` ${themeClass}` : ""}`}
    >
      <body className="min-h-full flex flex-col">
        {/*
          First child of <body>, above everything renderable: the parser
          executes it before it has reached any content to paint, which is the
          same guarantee <head> would give without tripping
          @next/next/no-head-element. MarketingConsentReservation is placed the
          same way for the same reason. On dynamic routes the class is already
          on <html> above and this only re-asserts it; on static marketing
          routes it is the only thing that can.
        */}
        <ThemeBootstrap nonce={nonce} />
        <ThemeController />
        <SkipToContentLink lang={lang} />
        {/*
          UX-016. The skip link's target. `display: contents` means this adds a
          focusable anchor and nothing else -- no box, no landmark, no layout
          effect -- so every route has a working target without each page having
          to opt in, and without competing with the `<main>` a page declares.
        */}
        <div id={MAIN_CONTENT_ID} tabIndex={-1} className="contents">
          {children}
        </div>
      </body>
    </html>
  );
}
