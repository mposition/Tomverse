/**
 * The images and videos a marketing post is allowed to use, and where each one
 * came from.
 *
 * Contract: docs/policy/marketing-automation.md §7.3 -- "assets use only ids
 * from the approved asset list. The provenance (capture, operator upload, AI
 * generated, AI modified) and the per-channel AI disclosure decision are kept
 * with it. AI generated images and video do not imitate the product's UI."
 *
 * Provenance is the field everything else hangs off. A screen capture and an
 * AI-generated picture of a screen look the same in a post and are not the
 * same claim: one shows the product, the other shows something that resembles
 * it, and every platform that requires an AI disclosure requires it for the
 * second. So provenance is recorded per asset, the disclosure is recorded per
 * channel rather than globally -- the platforms do not agree on what they
 * require -- and an asset that is AI generated or AI modified cannot be marked
 * as depicting the product interface.
 *
 * Alt text is per locale and lives here rather than in a post, because it is a
 * property of the asset: the same picture needs the same description whichever
 * post carries it, and a description written per post is a description written
 * differently every time.
 *
 * The registry file is `docs/marketing/asset-registry.json` and it is empty.
 * An asset is added by a person who has the file and its provenance in front of
 * them.
 *
 * Pure: no server-only import, no filesystem read at module scope, no Prisma.
 */

import { z } from "zod";

import {
  MARKETING_CHANNELS,
  MARKETING_LOCALES,
} from "@/lib/marketingAutomationSchema";

/**
 * Where an asset came from.
 *
 * `capture` is a real screenshot or recording of the product. `operator_upload`
 * is a file a person supplied that is not a capture -- a photograph, a logo, a
 * designed graphic. `ai_generated` was produced by a model; `ai_modified` began
 * as one of the first two and was changed by one. The last two are the ones a
 * disclosure rule cares about.
 */
export const MARKETING_ASSET_PROVENANCES = Object.freeze([
  "capture",
  "operator_upload",
  "ai_generated",
  "ai_modified",
] as const);
export type MarketingAssetProvenance =
  (typeof MARKETING_ASSET_PROVENANCES)[number];

/** The provenances that carry an AI origin, whatever a platform then requires. */
export const AI_ORIGIN_PROVENANCES = Object.freeze([
  "ai_generated",
  "ai_modified",
] as const);

/**
 * What a channel is told about an asset's origin.
 *
 * `platform_label` is the platform's own switch -- the "AI generated" toggle on
 * a post form -- and `caption_disclosure` is a sentence in our copy. They are
 * separate because some platforms have the first and some do not, and a channel
 * that has neither would be `none`, which is a decision somebody has to make
 * rather than an absence.
 */
export const MARKETING_ASSET_DISCLOSURES = Object.freeze([
  "none",
  "platform_label",
  "caption_disclosure",
  "platform_label_and_caption",
] as const);
export type MarketingAssetDisclosure =
  (typeof MARKETING_ASSET_DISCLOSURES)[number];

const registryId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/);

const isoDate = z.iso.date();

export const marketingAssetSchema = z
  .object({
    id: registryId,
    provenance: z.enum(MARKETING_ASSET_PROVENANCES),
    /** Which channels may carry it at all. */
    allowedChannels: z.array(z.enum(MARKETING_CHANNELS)).min(1),
    /**
     * Alt text per locale. Prose, and the one place in the marketing registries
     * that holds any: a description of a picture cannot be a token, and it is
     * written by a person rather than generated.
     */
    alt: z.partialRecord(z.enum(MARKETING_LOCALES), z.string().min(1).max(400)),
    /** The claims this asset is evidence for, if any. */
    claimIds: z.array(registryId).max(20),
    validUntil: isoDate,
    /** What each channel is told. Every allowed channel needs an entry. */
    // `partialRecord` rather than `record`: a record keyed by an enum requires
    // every member, and an asset that may appear on one channel has one entry.
    // The pair of checks below is what makes the set exactly right instead.
    disclosure: z.partialRecord(
      z.enum(MARKETING_CHANNELS),
      z.enum(MARKETING_ASSET_DISCLOSURES),
    ),
    /**
     * Whether the asset shows the product's own interface. An AI origin cannot
     * claim this: a generated picture of our UI is a picture of something that
     * does not exist, and §7.3 refuses it outright rather than disclosing it.
     */
    depictsProductInterface: z.boolean(),
  })
  .strict()
  .superRefine((asset, context) => {
    const aiOrigin = (AI_ORIGIN_PROVENANCES as readonly string[]).includes(
      asset.provenance,
    );

    if (aiOrigin && asset.depictsProductInterface) {
      context.addIssue({
        code: "custom",
        message:
          "an AI generated or modified asset may not depict the product interface",
      });
    }

    for (const channel of asset.allowedChannels) {
      const disclosure = asset.disclosure[channel];
      if (!disclosure) {
        context.addIssue({
          code: "custom",
          message: `${channel} is allowed but has no disclosure decision`,
        });
        continue;
      }
      // A decision, not a default: an AI-origin asset going out with `none`
      // would be the platform's rule broken silently, so it has to be written
      // down as something else before it can be used there.
      if (aiOrigin && disclosure === "none") {
        context.addIssue({
          code: "custom",
          message: `${channel} carries an AI ${asset.provenance} asset with no disclosure`,
        });
      }
    }

    // A disclosure for a channel that may not carry the asset is a decision
    // about nothing, and reads as though the channel were allowed.
    for (const channel of Object.keys(asset.disclosure)) {
      if (!(asset.allowedChannels as readonly string[]).includes(channel)) {
        context.addIssue({
          code: "custom",
          message: `${channel} has a disclosure decision but is not an allowed channel`,
        });
      }
    }

    // Alt text is what a reader who cannot see the asset is given, so every
    // locale the asset can appear in needs one. The registry does not know the
    // locales here, so the rule is the weaker, checkable one: at least one.
    if (Object.keys(asset.alt).length === 0) {
      context.addIssue({ code: "custom", message: "an asset needs alt text" });
    }
  });

export type MarketingAsset = z.infer<typeof marketingAssetSchema>;

export const marketingAssetRegistrySchema = z
  .object({
    version: z.number().int().min(1),
    assets: z.array(marketingAssetSchema),
  })
  .strict()
  .superRefine((registry, context) => {
    const seen = new Set<string>();
    for (const asset of registry.assets) {
      if (seen.has(asset.id)) {
        context.addIssue({
          code: "custom",
          message: `${asset.id} appears twice`,
        });
      }
      seen.add(asset.id);
    }
  });

export type MarketingAssetRegistry = z.infer<typeof marketingAssetRegistrySchema>;

/** Where the registry lives, so the validator and its test name one path. */
export const MARKETING_ASSET_REGISTRY_PATH = "docs/marketing/asset-registry.json";

/** Why an asset cannot be used for a draft. */
export type MarketingAssetRefusal =
  | "unknown_asset"
  | "channel_not_allowed"
  | "asset_expired"
  | "no_alt_for_locale"
  | "no_disclosure_for_channel"
  /** A registry that did not come from `loadMarketingAssetRegistry()`. */
  | "registry_not_loaded";

export type MarketingAssetResolution =
  | { ok: true; asset: MarketingAsset; disclosure: MarketingAssetDisclosure }
  | { ok: false; refusal: MarketingAssetRefusal };

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner);
    }
  }
  return value;
};

/**
 * Parse the asset registry file and freeze what comes out of it.
 *
 * This registry is the one input the Guard cannot hold as a module constant:
 * it lives in `docs/marketing/asset-registry.json` and is read at runtime. So
 * the protection the other registries get from being module-private has to
 * come from the value being immutable once it has been checked.
 *
 * Without the freeze, `provenance` is an ordinary property of an ordinary
 * object: parse a `capture` asset, set it to `ai_generated`, and the
 * `depictsProductInterface` rule that `superRefine` enforced at parse time has
 * already run. The asset would resolve with a `none` disclosure while claiming
 * to be a photograph of the product.
 */
export function loadMarketingAssetRegistry(raw: unknown): LoadedAssetRegistry {
  const parsed = deepFreeze(marketingAssetRegistrySchema.parse(raw));
  return deepFreeze({ [LOADED]: true, ...parsed }) as LoadedAssetRegistry;
}

/**
 * A registry that went through the loader, and that the resolver will accept.
 *
 * The brand is a symbol this module owns and does not export, so the type is
 * not a promise a caller can make about an object it assembled itself:
 * `marketingAssetRegistrySchema.parse(x)` produces a valid registry that is
 * still mutable, and that was exactly what the resolver was being handed.
 * Checked at runtime as well as in the type, because a cast is free.
 */
const LOADED: unique symbol = Symbol("marketingAssetRegistryLoaded");

export type LoadedAssetRegistry = MarketingAssetRegistry & {
  readonly [LOADED]: true;
};

const isLoadedRegistry = (value: unknown): value is LoadedAssetRegistry =>
  !!value &&
  typeof value === "object" &&
  (value as Record<PropertyKey, unknown>)[LOADED] === true &&
  Object.isFrozen(value);

export function resolveMarketingAsset({
  id,
  channel,
  locale,
  on,
  registry,
}: {
  id: string;
  channel: string;
  locale: string;
  on: Date;
  /**
   * The registry, as `loadMarketingAssetRegistry()` returned it. Only that
   * function can make one: a plain `.parse()` gives a valid registry that is
   * still mutable, and handing the resolver one of those was how a checked
   * `capture` asset could be turned into `ai_generated` after every rule had
   * run.
   */
  registry: LoadedAssetRegistry;
}): MarketingAssetResolution {
  if (!isLoadedRegistry(registry)) {
    return { ok: false, refusal: "registry_not_loaded" };
  }

  const asset = registry.assets.find((candidate) => candidate.id === id);
  if (!asset) return { ok: false, refusal: "unknown_asset" };

  if (!(asset.allowedChannels as readonly string[]).includes(channel)) {
    return { ok: false, refusal: "channel_not_allowed" };
  }
  if (on.toISOString().slice(0, 10) > asset.validUntil) {
    return { ok: false, refusal: "asset_expired" };
  }

  // `Object.hasOwn` rather than a bare index. A deep-frozen registry still
  // inherits from `Object.prototype`, so setting `Object.prototype.ko`
  // anywhere in the process would give every English-only asset a Korean alt
  // text -- and the asset would resolve for a locale nobody wrote it for.
  const alt = Object.hasOwn(asset.alt, locale)
    ? (asset.alt as Record<string, string | undefined>)[locale]
    : undefined;
  if (!alt) return { ok: false, refusal: "no_alt_for_locale" };

  // The schema's `superRefine` guarantees a disclosure for every allowed
  // channel; the type does not. Casting the lookup would make that guarantee
  // load-bearing at the one place it is not expressed, so a registry that
  // never went through `.parse()` -- a literal in a test, or a caller who
  // trusted the type -- would put `undefined` where the decision about
  // labelling an image as AI-generated is made.
  const disclosure = Object.hasOwn(asset.disclosure, channel)
    ? (asset.disclosure as Record<string, MarketingAssetDisclosure | undefined>)[
        channel
      ]
    : undefined;
  if (!disclosure) return { ok: false, refusal: "no_disclosure_for_channel" };

  return { ok: true, asset, disclosure };
}
