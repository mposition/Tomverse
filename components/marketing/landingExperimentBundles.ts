/**
 * Landing experiment copy (docs/policy/marketing-automation.md section 9.1).
 *
 * A bundle is version-pinned code. The activation setting never carries words:
 * it names a bundle and a variant from this file, and changing the words means
 * a new bundle id (`home-hero-v2`), which is a pull request, not a console
 * edit. Every variant becomes its own prerendered, noindex route at build time
 * (`app/[locale]/lx/[bundle]/[variant]`), so the HTML a visitor gets is as
 * static as the default page.
 *
 * Only the hero headline, the subtitle and the primary call to action of the
 * home page can be varied. Prices, checkout, terms, privacy, refunds, Auto,
 * starters and the AI Review description are outside this surface by policy;
 * the type below has no field for them, so a bundle cannot reach them.
 */

export type LandingExperimentLocale =
  | "en"
  | "ko"
  | "zh"
  | "fr"
  | "de"
  | "es"
  | "pt";

export type LandingSurfaceCopy = {
  /** Two lines, like the default headline. */
  title?: readonly [string, string];
  /** The subtitle under the headline. */
  body?: string;
  /** The primary call-to-action label; the destination never changes. */
  cta?: string;
};

export type LandingExperimentBundle = {
  /** `home-` prefix: the proxy rewrites only home pages for these. */
  id: string;
  surface: "home";
  /** Variant id -> copy per locale. A locale without copy keeps the default page. */
  variants: Readonly<
    Record<string, Partial<Record<LandingExperimentLocale, LandingSurfaceCopy>>>
  >;
};

/**
 * An example only. The operator decides real copy and adds it as a new bundle
 * id; this one exists so the route, the rewrite and the tests have a variant
 * to build.
 */
export const LANDING_EXPERIMENT_BUNDLES: readonly LandingExperimentBundle[] = [
  {
    id: "home-hero-v1",
    surface: "home",
    variants: {
      b: {
        en: {
          title: ["One question.", "Several AI answers."],
          body: "Ask once and read answers from different AI models side by side. Tomverse Review helps you see where they agree, differ or leave something out, so you can decide what to explore next.",
        },
        ko: {
          title: ["질문은 하나,", "AI 답변은 여럿."],
          body: "한 번 질문하고 여러 AI 모델의 답변을 나란히 읽어 보세요. Tomverse Review가 답변이 어디서 같고 다르고 빠졌는지 살펴보도록 도와 주니, 다음에 무엇을 더 알아볼지 직접 정할 수 있습니다.",
        },
      },
    },
  },
];

const bundleById = new Map(
  LANDING_EXPERIMENT_BUNDLES.map((bundle) => [bundle.id, bundle] as const)
);

export const landingExperimentBundle = (bundleId: string) =>
  bundleById.get(bundleId) ?? null;

export const landingVariantCopy = (
  bundleId: string,
  variantId: string,
  locale: string
): LandingSurfaceCopy | null => {
  const variants = landingExperimentBundle(bundleId)?.variants;
  if (!variants || !Object.hasOwn(variants, variantId)) return null;
  const perLocale = variants[variantId] as Partial<
    Record<string, LandingSurfaceCopy>
  >;
  return Object.hasOwn(perLocale, locale) ? (perLocale[locale] ?? null) : null;
};

/** Locales a variant has copy for: the only ones an activation may list. */
export const landingVariantLocales = (
  bundleId: string,
  variantId: string
): string[] => {
  const variants = landingExperimentBundle(bundleId)?.variants;
  if (!variants || !Object.hasOwn(variants, variantId)) return [];
  return Object.keys(variants[variantId]);
};

/** Every `{ locale, bundle, variant }` the build prerenders. */
export const landingExperimentStaticParams = () =>
  LANDING_EXPERIMENT_BUNDLES.flatMap((bundle) =>
    Object.keys(bundle.variants).flatMap((variant) =>
      landingVariantLocales(bundle.id, variant).map((locale) => ({
        locale,
        bundle: bundle.id,
        variant,
      }))
    )
  );
