"use client";

import { useLanguage } from "@/components/LanguageProvider";

/**
 * A screenshot of the real product, art-directed across theme, breakpoint and
 * locale.
 *
 * ## Why `<picture>` rather than `next/image`
 *
 * These are not one image served at several sizes; they are four different
 * pictures. The desktop capture is a 1440px comparison with three answer
 * panels side by side, the mobile capture is a 390px comparison with one panel
 * and a tab strip, and each exists in a light and a dark rendering of the
 * product's own theme. `next/image` resizes a single source, which would mean
 * shrinking the desktop screenshot on a phone until its text was unreadable.
 *
 * `<picture>` with `media` sources is what art direction is for, and it fetches
 * exactly one file. The properties `next/image` would have contributed are
 * kept by hand: intrinsic `width`/`height` on the `<img>` plus an
 * `aspect-ratio` box, so the space is reserved before the bytes arrive and the
 * image contributes nothing to CLS; `loading`/`fetchPriority` set per
 * placement; `decoding="async"` throughout.
 *
 * ## Locale
 *
 * The captures exist in English and Korean, the two `primary` locales. Every
 * other locale gets the English capture, which is consistent with what
 * `LocaleSupportNotice` already tells those visitors about the state of their
 * localisation, and honest in a way that a Korean screenshot shown to a French
 * visitor would not be.
 *
 * ## Staleness
 *
 * Every model named inside these files is registered in
 * `LANDING_CAPTURE_MODEL_IDS`, so a retirement fails the build rather than
 * quietly leaving the page advertising a model nobody can select. Regenerate
 * with `tests/e2e/marketing-capture.spec.ts`; no figure that changes
 * server-side is inside the frame.
 */

type CaptureName = "comparison" | "review-findings";

const DIMENSIONS: Record<
  CaptureName,
  { desktop: { w: number; h: number }; mobile: { w: number; h: number } }
> = {
  comparison: { desktop: { w: 1440, h: 900 }, mobile: { w: 390, h: 844 } },
  "review-findings": { desktop: { w: 974, h: 1237 }, mobile: { w: 348, h: 1108 } },
};

export function ProductCapture({
  name,
  alt,
  priority = false,
  className = "",
}: {
  name: CaptureName;
  /** Describes what the screenshot shows. Never "screenshot" or a filename. */
  alt: string;
  /** True for the one capture above the fold, which is the LCP candidate. */
  priority?: boolean;
  className?: string;
}) {
  const { lang } = useLanguage();
  const locale = lang === "ko" ? "ko" : "en";
  const size = DIMENSIONS[name];
  const src = (theme: "light" | "dark", crop: "desktop" | "mobile") =>
    `/marketing/${name}-${theme}-${crop}-${locale}.webp`;

  return (
    <picture>
      {/*
        Order matters: the first matching `source` wins, so the dark variants
        are declared before the light ones at each breakpoint.
      */}
      <source
        media="(min-width: 768px) and (prefers-color-scheme: dark)"
        srcSet={src("dark", "desktop")}
        width={size.desktop.w}
        height={size.desktop.h}
      />
      <source
        media="(min-width: 768px)"
        srcSet={src("light", "desktop")}
        width={size.desktop.w}
        height={size.desktop.h}
      />
      <source
        media="(prefers-color-scheme: dark)"
        srcSet={src("dark", "mobile")}
        width={size.mobile.w}
        height={size.mobile.h}
      />
      <img
        src={src("light", "mobile")}
        alt={alt}
        width={size.mobile.w}
        height={size.mobile.h}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        decoding="async"
        // `h-auto` with an intrinsic width/height pair is what reserves the
        // box: the browser derives the ratio before the file lands, so the
        // sections below never jump.
        className={`h-auto w-full ${className}`}
      />
    </picture>
  );
}
