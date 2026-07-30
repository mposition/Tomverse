import { ThemeController } from "@/components/ThemeController";
import { fontVariables } from "@/lib/fonts";
import type { Language } from "@/lib/language";

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
  children,
}: Readonly<{
  lang: Language;
  children: React.ReactNode;
}>) {
  return (
    <html
      lang={lang}
      suppressHydrationWarning
      className={`${fontVariables} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeController />
        {children}
      </body>
    </html>
  );
}
