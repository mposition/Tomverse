/**
 * Evidence-backed triage for models observed in provider catalogues.
 *
 * This module is deliberately pure. The catalogue reader establishes whether
 * a model is still present; these functions only turn that evidence and the
 * model id into a review priority and a short Korean explanation. No model is
 * closed automatically from this suggestion.
 */

import { modelOwner } from "@/lib/modelOwner";
import {
  docCollectableFields,
  providerDocHumanUrl,
} from "@/lib/providerModelDocSources";

export const MODEL_REVIEW_PRIORITIES = [
  "recommended",
  "review",
  "needs_evidence",
  "low",
  "no_action",
] as const;
export type ModelReviewPriority = (typeof MODEL_REVIEW_PRIORITIES)[number];

export const MODEL_REVIEW_KINDS = [
  "retirement",
  "general_chat",
  "image_generation",
  "dated_snapshot",
  "moving_alias",
  "preview",
  "superseded_version",
  "specialized_code",
  "specialized_non_chat",
] as const;
export type ModelReviewKind = (typeof MODEL_REVIEW_KINDS)[number];

export const MODEL_PRODUCT_SURFACES = [
  "chat",
  "image_generation",
  "unsupported",
] as const;
export type ModelProductSurface = (typeof MODEL_PRODUCT_SURFACES)[number];

export type ModelAvailability = "current" | "stale" | "unknown";

export const modelIdentityWithoutVendor = (apiModel: string) => {
  const withoutVendor = apiModel.slice(apiModel.lastIndexOf("/") + 1);
  return withoutVendor.trim().toLowerCase();
};

/**
 * The date and revision suffixes a provider hangs off a model name.
 *
 * The last three entries are the reason a decision stopped being remembered.
 * Google writes the day *inside* the name -- `gemini-2.5-flash-preview-05-20`
 * -- and a list that only knew `-2026-05-20` left the `-05-20` in the identity,
 * so the next month's snapshot was a different family, had no decision against
 * it, and came back for review. Two digits are required on each side on
 * purpose: `claude-opus-4-6` must not read as the sixth of April.
 */
const DATED_SUFFIXES = [
  /-(?:20\d{2})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/,
  /-(?:20\d{6})$/,
  /-(?:0\d|1[0-2])(?:0\d|[12]\d|3[01])$/,
  /-(?:00[1-9]|0[1-9]\d)$/,
  /-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/,
  /-(?:0[1-9]|1[0-2])-20\d{2}$/,
  /-(?:20\d{2})-(?:0[1-9]|1[0-2])$/,
] as const;

const stripOneDatedSuffix = (value: string) => {
  for (const pattern of DATED_SUFFIXES) {
    if (pattern.test(value)) return value.replace(pattern, "");
  }
  return value;
};

/** The release-stage word a provider hangs off the end of a name. */
const STAGE_SUFFIX =
  /-(?:preview\d*|beta\d*|eap|early[-_.]?access|experimental|exp|alpha\d*|rc\d*|nightly|canary)$/;

const MOVING_ALIAS_SUFFIX = /(?:-|@)(?:latest|auto)$/;

export const isDatedModelSnapshot = (apiModel: string) => {
  const identity = modelIdentityWithoutVendor(apiModel);
  const withoutStage = identity.replace(STAGE_SUFFIX, "");
  return stripOneDatedSuffix(withoutStage) !== withoutStage;
};

export const isMovingModelAlias = (apiModel: string) =>
  MOVING_ALIAS_SUFFIX.test(modelIdentityWithoutVendor(apiModel));

/**
 * The words a provider uses for "this is not the finished thing".
 *
 * `exp` is here because leaving it out cost the policy its point: with only the
 * four long spellings, `gemini-3-pro-exp-02-05` and `deepseek-v3.2-exp` were
 * still queued for review every morning after prerelease models were supposed
 * to stop entering it.
 *
 * Three words a reader expects are deliberately absent. `dev` names a shipped
 * production weight (`FLUX.1-dev`), `draft` names the small companion model a
 * speculative-decoding setup actually serves, and `test` is a real word inside
 * model names that have nothing to do with release stage. Excluding a model
 * that a provider does serve is silent -- nothing says the candidate was
 * dropped -- so the list stays to the markers whose meaning is unambiguous.
 */
const PRERELEASE_MARKER =
  /(?:^|[-_.\s])(?:preview\d*|beta\d*|eap|early[-_.]?access|experimental|exp|alpha\d*|rc\d*|nightly|canary)(?:$|[-_.\s])/;

/** Models that a provider has not presented as a stable production release. */
export const isPrereleaseModel = (
  apiModel: string,
  releaseStage?: string | null
) =>
  PRERELEASE_MARKER.test(modelIdentityWithoutVendor(apiModel)) ||
  (typeof releaseStage === "string" &&
    PRERELEASE_MARKER.test(releaseStage.trim().toLowerCase()));

/** Kept for the triage kind and existing callers; it covers every prerelease marker. */
export const isPreviewModel = (apiModel: string) =>
  isPrereleaseModel(apiModel);

export const isCodeSpecializedModel = (apiModel: string) =>
  /(?:^|[-_.])(?:codex|coder|code)(?:$|[-_.])/.test(
    modelIdentityWithoutVendor(apiModel)
  );

/** Models whose primary output is an image, not models that merely accept one. */
export const isImageGenerationModel = (apiModel: string) =>
  /(?:^|[-_.:/])(?:image|images|imagegen|imagen|imagine|dall-e|flux|recraft|ideogram|seedream|stable-diffusion|sdxl|sd3|nano-banana|photon|hidream)(?:$|[-_.:/])/.test(
    modelIdentityWithoutVendor(apiModel)
  );

export const isSearchSpecializedModel = (apiModel: string) =>
  /(?:^|[-_.])(?:search)(?:$|[-_.])/.test(
    modelIdentityWithoutVendor(apiModel)
  );

/** Research orchestrators that require a product path beyond ordinary chat. */
export const isMultiAgentModel = (apiModel: string) =>
  /(?:^|[-_.])multi[-_.]?agent(?:$|[-_.])/.test(
    modelIdentityWithoutVendor(apiModel)
  );

/** Products whose endpoint is not implemented by either Chat or Image Studio. */
export const isSpecializedNonChatModel = (apiModel: string) =>
  !isImageGenerationModel(apiModel) &&
  (isMultiAgentModel(apiModel) ||
    /(?:^|[-_.])(?:audio|realtime|search|transcrib(?:e|er)|transcription|speech|tts|embedding|embed|moderation|rerank|video|veo|whisper|guard|safeguard)(?:$|[-_.])/.test(
      modelIdentityWithoutVendor(apiModel)
    ));

export const modelProductSurface = (apiModel: string): ModelProductSurface => {
  if (isImageGenerationModel(apiModel)) return "image_generation";
  if (isSpecializedNonChatModel(apiModel)) return "unsupported";
  return "chat";
};

/**
 * The identity a catalogue decision is grouped under.
 *
 * Provider prefixes, dated snapshots and moving aliases are observations of a
 * model family, not three independent reasons to ask an operator for a choice.
 * Semantic generations (for example gpt-5.5 and gpt-5.6) remain distinct.
 */
export const candidateFamilyIdentity = (apiModel: string) => {
  let identity = modelIdentityWithoutVendor(apiModel);
  // Until nothing changes, rather than a fixed number of passes. Providers
  // stack these in whatever order they like -- `-preview-05-20` puts the date
  // last, `-05-20-preview` puts the stage last, `-latest` can sit on top of
  // either -- and a fixed two rounds left whichever layer came third in the
  // identity. That residue is what made the same model a new family, and a new
  // family has no decision recorded against it.
  for (let pass = 0; pass < 6; pass += 1) {
    const before = identity;
    identity = identity.replace(MOVING_ALIAS_SUFFIX, "");
    identity = identity.replace(STAGE_SUFFIX, "");
    identity = stripOneDatedSuffix(identity);
    if (identity === before) break;
  }
  return identity;
};

/** Whether a provider is presenting this id as finished work. */
export const modelStage = (
  apiModel: string,
  releaseStage?: string | null
): "stable" | "prerelease" =>
  isPrereleaseModel(apiModel, releaseStage) ? "prerelease" : "stable";

/**
 * The key a decision about a model is remembered under.
 *
 * The family alone is not enough, and the difference matters in one direction
 * only. `candidateFamilyIdentity` deliberately folds a preview into the family
 * it previews, so "no action on the preview" and "no action on the release"
 * would be the same record -- and the release, when it finally shipped, would
 * be suppressed by a decision nobody made about it. Stage-qualifying the key
 * keeps those two apart; `decisionSuppressesCandidate` then says which way the
 * suppression runs.
 */
export const candidateDecisionKey = (
  apiModel: string,
  releaseStage?: string | null
) => `${candidateFamilyIdentity(apiModel)}@${modelStage(apiModel, releaseStage)}`;

/**
 * Whether a recorded decision covers a model seen today.
 *
 * A decision about the finished model covers its previews: nobody wants the
 * preview of something they have already declined. The reverse is not true --
 * declining a preview says nothing about the release.
 */
export const decisionSuppressesCandidate = (
  decisionKey: string,
  candidateApiModel: string,
  candidateReleaseStage?: string | null
) =>
  decisionSuppressesCandidateIdentity(
    decisionKey,
    candidateFamilyIdentity(candidateApiModel),
    modelStage(candidateApiModel, candidateReleaseStage)
  );

/** The same stage-qualified decision rule after an evidence-aware resolver ran. */
export const decisionSuppressesCandidateIdentity = (
  decisionKey: string,
  candidateFamily: string,
  candidateStage: "stable" | "prerelease"
) => {
  const [decidedFamily, decidedStage] = splitDecisionKey(decisionKey);
  if (decidedFamily !== candidateFamily) return false;
  if (decidedStage === "stable") return true;
  return candidateStage === "prerelease";
};

/** The family half of a decision key, for indexing decisions by model. */
export const decisionKeyFamily = (decisionKey: string) =>
  splitDecisionKey(decisionKey)[0];

const splitDecisionKey = (decisionKey: string): [string, string] => {
  const separator = decisionKey.lastIndexOf("@");
  // A key written before this scheme existed is a bare family identity. Read
  // as stable, so it keeps suppressing exactly what it suppressed before.
  if (separator < 0) return [decisionKey, "stable"];
  return [
    decisionKey.slice(0, separator),
    decisionKey.slice(separator + 1) || "stable",
  ];
};

/** A bare version number, with or without a `v`: `5`, `4`, `2.5`, `v3.2`. */
const VERSION_SEGMENT = /^v?(\d+(?:\.\d+)*)$/;
/** A version glued to the name it belongs to: `qwen3`, `o4`. */
const NAMED_VERSION_SEGMENT = /^([a-z]+)(\d+(?:\.\d+)*)$/;

const parseVersionParts = (value: string) =>
  value.split(".").map((part) => Number.parseInt(part, 10));

type ModelLine = { line: string; version: number[] | null };

/**
 * The product line an id belongs to, and which generation of it this is.
 *
 * Split rather than merged because only one half is a guess. The line is the
 * name with the generation removed and **the tier left in** -- `claude-opus`
 * and `claude-sonnet` are two lines, `gpt-mini` is not `gpt` -- and the version
 * is the number that orders one line's releases. An id this cannot read gets a
 * `null` version and is never superseded by anything, which is the whole point
 * of returning it rather than a boolean: a guessed version would retire a model
 * on the strength of a name we did not understand.
 */
export const modelLine = (apiModel: string): ModelLine => {
  const segments = candidateFamilyIdentity(apiModel).split("-").filter(Boolean);
  const lineSegments: string[] = [];
  let version: number[] | null = null;
  // Only bare integers that directly follow a bare integer continue a version:
  // `claude-opus-4-6` is 4.6, while `gemini-2.5-flash` stops at 2.5 and
  // `qwen3-max` stops at 3.
  let versionOpen = false;

  for (const segment of segments) {
    const bare = VERSION_SEGMENT.exec(segment);
    if (bare) {
      const parts = parseVersionParts(bare[1]);
      if (version === null) {
        version = parts;
        versionOpen = parts.length === 1 && !segment.includes(".");
        continue;
      }
      if (versionOpen && parts.length === 1) {
        version = [...version, ...parts];
        continue;
      }
      lineSegments.push(segment);
      versionOpen = false;
      continue;
    }
    versionOpen = false;
    const named = version === null ? NAMED_VERSION_SEGMENT.exec(segment) : null;
    if (named) {
      version = parseVersionParts(named[2]);
      lineSegments.push(named[1]);
      continue;
    }
    lineSegments.push(segment);
  }

  return { line: lineSegments.join("-"), version };
};

export const compareModelVersions = (
  left: readonly number[],
  right: readonly number[]
) => {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * The model already served that makes this candidate an older generation of
 * something Tomverse has, or `null`.
 *
 * Returns the id rather than a boolean because the operator has to be told
 * *which* model this was measured against -- "Opus 4.6 is behind Opus 5" is
 * checkable and "not recommended" is not.
 *
 * Equal versions count: a candidate that is the same generation of the same
 * line as a served model adds nothing, and the id it arrived under is already
 * handled by the family collapse above.
 */
export const supersedingServedModel = (
  candidateApiModel: string,
  servedApiModels: readonly string[]
): string | null => {
  const candidate = modelLine(candidateApiModel);
  if (!candidate.version || !candidate.line) return null;
  let best: { apiModel: string; version: number[] } | null = null;
  for (const servedApiModel of servedApiModels) {
    const served = modelLine(servedApiModel);
    if (!served.version || served.line !== candidate.line) continue;
    if (compareModelVersions(served.version, candidate.version) < 0) continue;
    if (best && compareModelVersions(served.version, best.version) <= 0) continue;
    best = { apiModel: servedApiModel, version: served.version };
  }
  return best?.apiModel ?? null;
};

/**
 * What a provider's own tier word says about the seat a model is sold for.
 *
 * `speed` is separate from `economy` because the two are sold differently:
 * `turbo` and `instant` promise latency at the same size, while `air` and
 * `mini` promise a smaller model. Both are cheaper; only one of them claims to
 * be as capable.
 */
export const MODEL_TIER_KINDS = [
  "flagship",
  "standard",
  "speed",
  "economy",
] as const;
export type ModelTierKind = (typeof MODEL_TIER_KINDS)[number];

const TIER_WORDS: ReadonlyArray<readonly [RegExp, ModelTierKind]> = [
  // `pro` sits with the flagship words because that is how every provider in
  // this catalogue sells it today (Gemini Pro, Qwen Pro, Sonar Pro). `plus` is
  // deliberately not here: vendors use it for the rung below their own top.
  [/^(?:opus|ultra|max|large|premier|titan|pro)$/, "flagship"],
  [/^(?:plus|sonnet|standard|base)$/, "standard"],
  [/^(?:turbo|instant|fast|rapid)$/, "speed"],
  [
    /^(?:air|airx|mini|nano|lite|light|small|tiny|micro|haiku|flash|flashx|flashlite|scout)$/,
    "economy",
  ],
];

export type ModelTierReading = {
  kind: ModelTierKind | null;
  /** The word the provider used, as it appeared. */
  word: string | null;
};

/**
 * The tier word in an id, if the id carries one.
 *
 * Reads every segment rather than only the last: `glm-5.3-flashx` and
 * `gemini-3-flash-lite` hang the word after the generation, `claude-opus-5`
 * hangs it before. Consecutive tier words are one seat: `flash-lite` is not
 * `flash`, or the queue tells the operator the two occupy the same place.
 * A gap breaks the run: `whisper-large-v3-turbo` is `turbo`, not `large-turbo`.
 * Inside one run the kind is the first word. `mini-fast` stays an economy
 * seat that is also fast; the speed word does not erase the grade.
 * A `null` kind is not "standard" -- it is the id declining to say, and the
 * copy reading this keeps the two apart.
 */
export const modelTier = (apiModel: string): ModelTierReading => {
  const segments = modelIdentityWithoutVendor(apiModel)
    .split(/[-_.]/)
    .filter(Boolean);
  const runs: { kind: ModelTierKind; word: string }[][] = [];
  let current: { kind: ModelTierKind; word: string }[] = [];
  for (const segment of segments) {
    let hit: { kind: ModelTierKind; word: string } | null = null;
    for (const [pattern, kind] of TIER_WORDS) {
      if (pattern.test(segment)) {
        hit = { kind, word: segment };
        break;
      }
    }
    if (hit) {
      current.push(hit);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  const last = runs[runs.length - 1];
  if (!last || last.length === 0) return { kind: null, word: null };
  return {
    kind: last[0].kind,
    word: last.map((hit) => hit.word).join("-"),
  };
};

/**
 * The line with its tier word removed: the family a vendor versions as a wave.
 *
 * `glm-air` and `glm-flash` are both `glm`; `claude-opus` and `claude-sonnet`
 * are both `claude`. This is the coarser half of a pair -- `modelLine()` keeps
 * the tier and answers "do we already serve a later one of exactly this", this
 * drops it and answers "which generation wave is this".
 */
type GenerationReading = {
  family: string;
  version: number[] | null;
  tier: ModelTierReading;
  owner: ReturnType<typeof modelOwner>;
};

/**
 * Read once per id, kept for the rest of the process.
 *
 * A queue read asks about one id against every other id of its wave, so the
 * same string is parsed n times per row and n squared times per request. At
 * the 1,000-row ceiling that measured 11 seconds; the ids are immutable and
 * the answer never changes, so it is computed once.
 *
 * Bounded rather than unbounded: this is a long-lived process and the id space
 * is provider-controlled. Clearing wholesale is fine -- a miss costs one parse.
 */
const GENERATION_CACHE_LIMIT = 4_096;
const generationCache = new Map<string, GenerationReading>();

export const modelGenerationFamily = (apiModel: string): GenerationReading => {
  const cached = generationCache.get(apiModel);
  if (cached) return cached;
  const { line, version } = modelLine(apiModel);
  const tier = modelTier(apiModel);
  // Every tier word, not only the first: "gemini-3.5-flash-lite" carries two,
  // and keeping "lite" gave it a family of its own so it was never read as a
  // sibling of "gemini-3.5-flash".
  const family = line
    .split("-")
    .filter(
      (segment) =>
        segment && !TIER_WORDS.some(([pattern]) => pattern.test(segment))
    )
    .join("-");
  const reading: GenerationReading = {
    family,
    version,
    tier,
    owner: modelOwner(apiModel),
  };
  if (generationCache.size >= GENERATION_CACHE_LIMIT) generationCache.clear();
  generationCache.set(apiModel, reading);
  return reading;
};

export const MODEL_PORTFOLIO_RELATIONS = [
  "newer_generation",
  "same_generation",
  "older_generation",
  "family_seat_mismatch",
  "no_shared_family",
  "unreadable_version",
] as const;
export type ModelPortfolioRelationKind =
  (typeof MODEL_PORTFOLIO_RELATIONS)[number];

export type ModelPortfolioRelation = {
  kind: ModelPortfolioRelationKind;
  /** The served model this was measured against, when there is one. */
  against: ServedModelPortfolioEntry | null;
  /** The generations compared, written as the ids wrote them. */
  candidateGeneration: string | null;
  servedGeneration: string | null;
  candidateTier: ModelTierReading;
  servedTier: ModelTierReading;
  /** True when candidate and served carry the same tier word. */
  sameTier: boolean;
};

const formatVersion = (version: readonly number[] | null) =>
  version && version.length ? version.join(".") : null;

/**
 * Where a candidate sits against the served models of its own maker.
 *
 * The queue already had `supersedingServedModel`, and it answers a narrower
 * question: do we serve a later version of exactly this line, tier word
 * included. That is right for closing an item and useless for the question an
 * operator asks about a provider's release wave -- five ids arrive, four of
 * them are tier variants around one generation number, and the facts worth
 * saying are which generation each is and which seat it would take.
 *
 * Zhipu on 2026-09-21 is the measured case. With GLM 5.2 served, the queue was
 * shown `glm-4.5-air`, `glm-5-turbo`, `ZHIPU/GLM-5.3`, `glm-5.3-flash` and
 * `glm-5.3-flashx`, and said the same paragraph about all five: that it could
 * not tell what any of them complements or replaces. Two are older generations
 * of a model already served and three are the next generation of the exact
 * family the catalogue runs -- each of which the identifier states.
 *
 * Naming-based, and the copy quoting it says so. A tier word is what the
 * provider called the model, not a measurement.
 */
/**
 * An id that names no tier is the base seat. A cheaper named seat cannot
 * answer "we already serve this generation" for that base, or for a higher
 * seat. Flash answering for an unnamed GLM, or Flash answering for Pro, is
 * the case this blocks. The same kind with a different word is a different
 * seat too: flash-lite does not answer for flash.
 */
const TIER_SEAT_RANK: Record<ModelTierKind, number> = {
  flagship: 3,
  standard: 2,
  speed: 1,
  economy: 0,
};

const tierRank = (kind: ModelTierKind | null) =>
  kind === null ? TIER_SEAT_RANK.flagship : TIER_SEAT_RANK[kind];

export const modelPortfolioRelation = (
  candidateApiModel: string,
  servedModels: readonly ServedModelPortfolioEntry[]
): ModelPortfolioRelation => {
  const candidate = modelGenerationFamily(candidateApiModel);
  const owner = modelOwner(candidateApiModel);
  const base = {
    candidateGeneration: formatVersion(candidate.version),
    candidateTier: candidate.tier,
  };
  const none = {
    ...base,
    against: null,
    servedGeneration: null,
    servedTier: { kind: null, word: null } as ModelTierReading,
    sameTier: false,
  };
  if (!candidate.version || !candidate.family) {
    return { ...none, kind: "unreadable_version" };
  }

  // The candidate's own tier is measured first, and only then the rest of the
  // family. Ranking by version across tiers answered the wrong question: with
  // Gemini 3.6 Flash and 3.1 Pro served, a Pro 3.5 candidate was measured
  // against Flash 3.6, called an older generation, and dropped out of the
  // default view -- while the row's own text still said it overlapped Pro 3.1.
  const newestOf = (
    candidates: readonly {
      model: ServedModelPortfolioEntry;
      version: number[];
      tier: ModelTierReading;
    }[]
  ) =>
    candidates.reduce<(typeof candidates)[number] | null>(
      (held, entry) =>
        held && compareModelVersions(entry.version, held.version) <= 0
          ? held
          : entry,
      null
    );

  const family: {
    model: ServedModelPortfolioEntry;
    version: number[];
    tier: ModelTierReading;
  }[] = [];
  for (const served of servedModels) {
    const servedFamily = modelGenerationFamily(served.apiModel);
    if (owner === "unknown" || servedFamily.owner !== owner) continue;
    if (!servedFamily.version || servedFamily.family !== candidate.family) {
      continue;
    }
    family.push({
      model: served,
      version: servedFamily.version,
      tier: servedFamily.tier,
    });
  }
  const sameWord = family.filter((entry) => entry.tier.word === candidate.tier.word);
  const eligible = family.filter(
    (entry) => tierRank(entry.tier.kind) >= tierRank(candidate.tier.kind)
  );
  const best = newestOf(sameWord) ?? newestOf(eligible);

  const mismatch = (
    declined: { model: ServedModelPortfolioEntry; version: number[]; tier: ModelTierReading } | null
  ): ModelPortfolioRelation => ({
    ...base,
    kind: "family_seat_mismatch",
    against: declined?.model ?? null,
    servedGeneration: formatVersion(declined?.version ?? null),
    servedTier: declined?.tier ?? { kind: null, word: null },
    sameTier: false,
  });

  if (!best) {
    if (family.length === 0) return { ...none, kind: "no_shared_family" };
    return mismatch(newestOf(family));
  }

  const difference = compareModelVersions(candidate.version, best.version);
  const differentWord = candidate.tier.word !== best.tier.word;
  const servedIsHigherKind =
    tierRank(best.tier.kind) > tierRank(candidate.tier.kind);
  // flash-lite 3.5 must not mark flash 3 as an older generation. The same
  // generation of those two seats is still a comparison.
  if (difference < 0 && differentWord && !servedIsHigherKind) {
    return mismatch(best);
  }

  return {
    ...base,
    kind:
      difference > 0
        ? "newer_generation"
        : difference < 0
          ? "older_generation"
          : "same_generation",
    against: best.model,
    servedGeneration: formatVersion(best.version),
    servedTier: best.tier,
    sameTier: candidate.tier.word === best.tier.word,
  };
};

/** The newest id per line, for collapsing one scan's own generations. */
export const newestByModelLine = <T>(
  items: readonly T[],
  apiModelOf: (item: T) => string
): T[] => {
  const byLine = new Map<string, { item: T; version: number[] }>();
  const keep = new Set<T>();
  for (const item of items) {
    const { line, version } = modelLine(apiModelOf(item));
    if (!version || !line) {
      // Unreadable is not the same as older. It stays.
      keep.add(item);
      continue;
    }
    const held = byLine.get(line);
    if (held && compareModelVersions(version, held.version) <= 0) continue;
    byLine.set(line, { item, version });
  }
  for (const entry of byLine.values()) keep.add(entry.item);
  return items.filter((item) => keep.has(item));
};

/** Stable models are preferable representatives to their aliases/snapshots. */
export const candidateRepresentativeRank = (apiModel: string) => {
  if (modelProductSurface(apiModel) === "unsupported") return 5;
  if (isCodeSpecializedModel(apiModel)) return 4;
  if (isPreviewModel(apiModel)) return 3;
  if (isMovingModelAlias(apiModel)) return 2;
  if (isDatedModelSnapshot(apiModel)) return 1;
  return 0;
};

/** Only stable Chat and Image Studio candidates enter review. */
export const shouldQueueModelCandidate = (apiModel: string) =>
  modelProductSurface(apiModel) !== "unsupported" &&
  !isPrereleaseModel(apiModel);

const providerLabel = (providers: readonly string[]) => {
  const unique = Array.from(new Set(providers.filter(Boolean)));
  if (unique.length === 0) return "공급자";
  if (unique.length === 1) return unique[0];
  return `${unique[0]} 외 ${unique.length - 1}곳`;
};

/**
 * What the queue says about one candidate, in the order an operator reads it.
 *
 * Three parts rather than one paragraph, because the paragraph was the defect.
 * Every row ended with the same sentence about checking official positioning,
 * so five rows of a provider release wave looked copied -- and the one row that
 * was the next generation of a model in the catalogue read exactly like the two
 * that were older generations of it.
 *
 * `analysisKo` stays: it is what the exclusion snapshot records and what the
 * fingerprint binds. It is these three joined, never a fourth wording.
 */
export type ModelTriageAssessment = {
  priority: ModelReviewPriority;
  kind: ModelReviewKind;
  product: ModelProductSurface;
  /** One line: what this candidate is to the catalogue Tomverse runs. */
  verdictKo: string;
  /** Supporting facts, each checkable on its own. */
  pointsKo: string[];
  /** What to do next, and what would change the answer. */
  nextStepKo: string;
  analysisKo: string;
};

const triaged = (input: {
  priority: ModelReviewPriority;
  kind: ModelReviewKind;
  product: ModelProductSurface;
  verdictKo: string;
  pointsKo?: readonly (string | null | undefined | false)[];
  nextStepKo: string;
}): ModelTriageAssessment => {
  const pointsKo = (input.pointsKo ?? []).filter(
    (point): point is string => typeof point === "string" && point.trim() !== ""
  );
  return {
    priority: input.priority,
    kind: input.kind,
    product: input.product,
    verdictKo: input.verdictKo,
    pointsKo,
    nextStepKo: input.nextStepKo,
    analysisKo: [input.verdictKo, ...pointsKo, input.nextStepKo]
      .filter(Boolean)
      .join(" "),
  };
};

/** Facts copied from the provider catalogue response, never inferred pricing. */
export type ModelCandidateEvidence = {
  canonicalApiModel?: string | null;
  equivalentApiModels?: readonly string[];
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  supportsImage?: boolean | null;
  supportsNativePdf?: boolean | null;
  reasoning?: boolean | null;
  observedInputUsdPerMillionTokens?: number | null;
  observedOutputUsdPerMillionTokens?: number | null;
  /** Where the displayed price came from; it is evidence, never billing state. */
  priceEvidenceSource?: "provider_api" | "provider_docs" | "mixed" | null;
  longContextThreshold?: number | null;
};

/** The current Tomverse portfolio projection used only for decision support. */
export type ServedModelPortfolioEntry = {
  apiModel: string;
  provider: string;
  name?: string | null;
  bestFor?: string | null;
  reasoning?: string | null;
  contextWindowTokens?: number | null;
  supportsImage?: boolean | null;
  supportsNativePdf?: boolean | null;
  maxOutputTokens?: number | null;
  inputUsdPerMillionTokens?: number | null;
  outputUsdPerMillionTokens?: number | null;
  usageClass?: string | null;
  product?: ModelProductSurface;
  sortOrder?: number;
};

type ChatRole =
  | "reasoning"
  | "non_reasoning"
  | "economy"
  | "flagship"
  | "general";

const chatRole = (
  apiModel: string,
  evidence?: ModelCandidateEvidence | null,
  served?: ServedModelPortfolioEntry
): ChatRole => {
  const identity = modelIdentityWithoutVendor(apiModel);
  if (/(?:^|[-_.])non[-_.]?reasoning(?:$|[-_.])/.test(identity)) {
    return "non_reasoning";
  }
  if (/(?:^|[-_.])(?:reasoning|reasoner|thinking)(?:$|[-_.])/.test(identity)) {
    return "reasoning";
  }
  // Tier/latency words describe the portfolio seat more specifically than
  // the fact that a modern model can also think. Gemini Flash and Claude Opus
  // should not both collapse into the generic reasoning bucket merely because
  // Tomverse sends each one a reasoning effort.
  //
  // Read from the same table the generation comparison uses. They were two
  // lists of the same words and they disagreed: `glm-5.3-flash` was an economy
  // model with a role, and `glm-5.3-flashx` beside it had no role at all.
  const tier = modelTier(apiModel).kind;
  if (tier === "economy") return "economy";
  if (tier === "flagship") return "flagship";
  // `speed` deliberately falls through. Vendors disagree about what it sells:
  // `glm-5-turbo` is a cheap tier and `gpt-4-turbo` was the flagship of its
  // day, so the word decides the tier phrase and never the portfolio role.
  if (
    evidence?.reasoning === true ||
    (served?.reasoning && served.reasoning !== "none") ||
    served?.usageClass?.includes("reasoning")
  ) {
    return "reasoning";
  }
  if (evidence?.reasoning === false || served?.reasoning === "none") {
    return "non_reasoning";
  }
  return "general";
};

const roleLabel = (role: ChatRole) => {
  switch (role) {
    case "reasoning":
      return "추론형";
    case "non_reasoning":
      return "비추론 일반대화형";
    case "economy":
      return "속도·비용형";
    case "flagship":
      return "상위 성능형";
    default:
      return "일반대화형";
  }
};

const formatInteger = (value: number) =>
  new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(value);

const formatUsd = (value: number) =>
  value < 1 ? value.toFixed(2) : value.toLocaleString("en-US", { maximumFractionDigits: 2 });

const portfolioName = (model: ServedModelPortfolioEntry) =>
  model.name?.trim() || model.apiModel;

const candidateFacts = (evidence?: ModelCandidateEvidence | null) => {
  if (!evidence) return [];
  const facts: string[] = [];
  if (evidence.contextWindowTokens) {
    facts.push(`컨텍스트 ${formatInteger(evidence.contextWindowTokens)}`);
  }
  if (evidence.maxOutputTokens) {
    facts.push(`공급자 최대 출력 ${formatInteger(evidence.maxOutputTokens)}`);
  }
  if (evidence.supportsImage === true) facts.push("이미지 입력");
  if (evidence.supportsImage === false) facts.push("텍스트 전용");
  if (evidence.supportsNativePdf === true) facts.push("네이티브 PDF");
  if (evidence.longContextThreshold) {
    facts.push(`장문 가격 경계 ${formatInteger(evidence.longContextThreshold)}`);
  }
  if (
    evidence.observedInputUsdPerMillionTokens != null &&
    evidence.observedOutputUsdPerMillionTokens != null
  ) {
    const source =
      evidence.priceEvidenceSource === "provider_docs"
        ? "공식 문서 관측 가격"
        : evidence.priceEvidenceSource === "mixed"
          ? "공급자 근거 관측 가격"
          : "API 관측 가격";
    facts.push(
      `${source} 입력 $${formatUsd(evidence.observedInputUsdPerMillionTokens)}/출력 $${formatUsd(evidence.observedOutputUsdPerMillionTokens)}`
    );
  }
  return facts;
};

const providerAliasNote = (evidence?: ModelCandidateEvidence | null) => {
  const equivalents = Array.from(
    new Set(evidence?.equivalentApiModels?.filter(Boolean) ?? [])
  ).sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (equivalents.length < 2 || !evidence?.canonicalApiModel) return "";
  const preferred = equivalents.find(
    (apiModel) =>
      apiModel !== evidence.canonicalApiModel &&
      !isMovingModelAlias(apiModel) &&
      !isDatedModelSnapshot(apiModel)
  );
  return (
    ` 공급자 API가 ${equivalents.map((item) => `'${item}'`).join("·")}를 canonical '${evidence.canonicalApiModel}'의 동일 모델 alias로 연결합니다.` +
    (preferred
      ? ` Tomverse 후보는 기본 alias '${preferred}' 한 개면 충분하며, canonical revision은 재현성 고정이 필요할 때만 대신 선택해야 합니다.`
      : " 중복 채택하지 말고 자동 업데이트 또는 재현성 중 한 정책만 선택해야 합니다.")
  );
};

const capabilityDeltas = (
  evidence: ModelCandidateEvidence | null | undefined,
  baseline: ServedModelPortfolioEntry | undefined
) => {
  if (!evidence || !baseline) {
    return {
      gains: [] as string[],
      losses: [] as string[],
      tradeoffs: [] as string[],
    };
  }
  const gains: string[] = [];
  const losses: string[] = [];
  const tradeoffs: string[] = [];
  if (evidence.contextWindowTokens && baseline.contextWindowTokens) {
    if (evidence.contextWindowTokens > baseline.contextWindowTokens) {
      gains.push(
        `컨텍스트가 ${portfolioName(baseline)}의 ${formatInteger(baseline.contextWindowTokens)}보다 큼`
      );
    } else if (evidence.contextWindowTokens < baseline.contextWindowTokens) {
      losses.push(
        `컨텍스트가 ${portfolioName(baseline)}의 ${formatInteger(baseline.contextWindowTokens)}보다 작음`
      );
    }
  }
  if (evidence.maxOutputTokens && baseline.maxOutputTokens) {
    if (evidence.maxOutputTokens > baseline.maxOutputTokens) {
      gains.push(`최대 출력이 ${portfolioName(baseline)}보다 큼`);
    } else if (evidence.maxOutputTokens < baseline.maxOutputTokens) {
      losses.push(`최대 출력이 ${portfolioName(baseline)}보다 작음`);
    }
  }
  if (evidence.supportsImage === true && baseline.supportsImage === false) {
    gains.push(`${portfolioName(baseline)}에 없는 이미지 입력`);
  } else if (evidence.supportsImage === false && baseline.supportsImage === true) {
    losses.push(`${portfolioName(baseline)}과 달리 이미지 입력 없음`);
  }
  if (
    evidence.supportsNativePdf === true &&
    baseline.supportsNativePdf === false
  ) {
    gains.push(`${portfolioName(baseline)}에 없는 네이티브 PDF 입력`);
  } else if (
    evidence.supportsNativePdf === false &&
    baseline.supportsNativePdf === true
  ) {
    losses.push(`${portfolioName(baseline)}과 달리 네이티브 PDF 입력 없음`);
  }
  const candidateInput = evidence.observedInputUsdPerMillionTokens;
  const candidateOutput = evidence.observedOutputUsdPerMillionTokens;
  const baselineInput = baseline.inputUsdPerMillionTokens;
  const baselineOutput = baseline.outputUsdPerMillionTokens;
  if (
    candidateInput != null &&
    candidateOutput != null &&
    baselineInput != null &&
    baselineOutput != null
  ) {
    const candidatePrice = `$${formatUsd(candidateInput)}/$${formatUsd(candidateOutput)}`;
    const baselinePrice = `$${formatUsd(baselineInput)}/$${formatUsd(baselineOutput)}`;
    if (
      candidateInput <= baselineInput &&
      candidateOutput <= baselineOutput &&
      (candidateInput < baselineInput || candidateOutput < baselineOutput)
    ) {
      gains.push(
        `입력/출력 단가 ${candidatePrice}가 ${portfolioName(baseline)}의 ${baselinePrice}보다 낮음`
      );
    } else if (
      candidateInput >= baselineInput &&
      candidateOutput >= baselineOutput &&
      (candidateInput > baselineInput || candidateOutput > baselineOutput)
    ) {
      losses.push(
        `입력/출력 단가 ${candidatePrice}가 ${portfolioName(baseline)}의 ${baselinePrice}보다 높음`
      );
    } else if (
      candidateInput !== baselineInput ||
      candidateOutput !== baselineOutput
    ) {
      tradeoffs.push(
        `입력/출력 단가가 후보 ${candidatePrice}, ${portfolioName(baseline)} ${baselinePrice}로 엇갈림`
      );
    }
  }
  return { gains, losses, tradeoffs };
};

/**
 * The fields an operator would have to fetch before this row can be decided.
 *
 * Named rather than implied. "Check the official positioning and price" was
 * the closing sentence on every row, including rows where the price was
 * already known and the only open question was the context window.
 */
const MISSING_FIELD_LABELS = {
  contextWindowTokens: "컨텍스트 창",
  maxOutputTokens: "최대 출력",
  prices: "입력/출력 단가",
  modalities: "이미지 입력 지원 여부",
} as const;
type MissingField = keyof typeof MISSING_FIELD_LABELS;

const missingEvidenceFields = (
  evidence?: ModelCandidateEvidence | null
): MissingField[] => {
  const missing: MissingField[] = [];
  if (!evidence?.contextWindowTokens) missing.push("contextWindowTokens");
  if (!evidence?.maxOutputTokens) missing.push("maxOutputTokens");
  if (
    evidence?.observedInputUsdPerMillionTokens == null ||
    evidence?.observedOutputUsdPerMillionTokens == null
  ) {
    missing.push("prices");
  }
  if (evidence?.supportsImage == null) missing.push("modalities");
  return missing;
};

/**
 * What the rest of this provider's release wave, sitting in the same queue,
 * says about the row being read.
 *
 * A provider ships a generation as a set -- a base model, a cheap one, a fast
 * one -- and the queue was deciding each of them as if it were alone. That is
 * how the row that is the next generation of the served flagship ended up
 * reading exactly like the small variant beside it. The order matters too: the
 * base model of a wave is the decision the others depend on.
 *
 * Only the ids are compared, and the copy says so. Whether `flashx` is a faster
 * SKU of `flash` or a different model is the provider's to state; naming can
 * raise the question and must not answer it.
 */
/**
 * The same-wave siblings of one id: same maker, same family, same generation.
 *
 * The maker is part of it. `nvidia/aurora-9-mini` and `microsoft/aurora-9`
 * share a family name and nothing else, and without this the first would call
 * the second "the base model of its own wave".
 */
const sameWaveSiblings = (apiModel: string, wave: readonly string[]) => {
  const self = modelGenerationFamily(apiModel);
  if (!self.version || !self.family) return [];
  return wave
    .filter((candidate) => candidate !== apiModel)
    // Sorted here as well as in the query: the analysis text names these in
    // order, and a caller that reads them from anywhere else must not be able
    // to change what the same item says about itself.
    .slice()
    .sort((left, right) => left.localeCompare(right))
    .map((candidate) => ({ apiModel: candidate, ...modelGenerationFamily(candidate) }))
    .filter(
      (sibling) =>
        sibling.owner === self.owner &&
        sibling.owner !== "unknown" &&
        sibling.family === self.family &&
        sibling.version &&
        compareModelVersions(sibling.version, self.version!) === 0 &&
        !isPreviewModel(sibling.apiModel)
    );
};

const siblingWavePoints = (input: {
  apiModel: string;
  siblingApiModels: readonly string[];
}) => {
  const self = modelGenerationFamily(input.apiModel);
  const siblings = sameWaveSiblings(input.apiModel, input.siblingApiModels);
  if (siblings.length === 0) return [];

  const points: string[] = [];
  const base = siblings.find(
    (sibling) => sibling.tier.word === null && !isPreviewModel(sibling.apiModel)
  );
  if (self.tier.word && base) {
    points.push(
      `같은 세대의 기본형 '${base.apiModel}'도 같은 대기열에 있습니다. 기본형을 먼저 결정하면 이 파생형의 자리는 그 결정에 따라 정해집니다.`
    );
  } else if (!self.tier.word && siblings.some((sibling) => sibling.tier.word)) {
    points.push(
      `같은 세대의 파생형 ${siblings
        .filter((sibling) => sibling.tier.word)
        .map((sibling) => `'${sibling.apiModel}'`)
        .join("·")}도 함께 올라와 있어, 한 세대를 tier별로 몇 개까지 노출할지 같이 정해야 합니다.`
    );
  }

  // `flash` and `flashx`: one name is the other plus a letter, and the
  // extra letter does not cross a hyphen. `flash` / `flash-lite` is a
  // different seat, not a one-letter speed SKU.
  const tierWordsAreNear = (left: string, right: string) => {
    if (left === right) return false;
    const [shorter, longer] =
      left.length <= right.length ? [left, right] : [right, left];
    return (
      longer.length === shorter.length + 1 &&
      longer.startsWith(shorter) &&
      longer.charAt(shorter.length) !== "-"
    );
  };
  const selfWord = self.tier.word;
  const nearName = selfWord
    ? siblings.find(
        (sibling) =>
          sibling.tier.word &&
          sibling.tier.word !== selfWord &&
          tierWordsAreNear(selfWord, sibling.tier.word)
      )
    : undefined;
  if (nearName) {
    points.push(
      `'${nearName.apiModel}'와 tier 표기가 한 글자 차이라, 같은 모델의 속도·가격 SKU일 수 있습니다. 두 ID가 같은 가중치인지 공급자 문서에서 확인하고, 같다면 별도 모델 대신 속도 옵션으로 묶는 편이 목록을 단순하게 만듭니다.`
    );
  }
  return points;
};

/**
 * Which of the missing values this provider's documents fill in by themselves,
 * and which stay a person's job.
 *
 * Per field rather than per provider. Anthropic's pricing page carries prices
 * and nothing about context windows, so "the next collection will fill these
 * in" would be false for three of the four fields on every Claude candidate.
 * The provider's own page is named either way, because the operator who has to
 * do it by hand should not also have to find it.
 */
const missingEvidenceSourceKo = (
  providers: readonly string[],
  missing: readonly MissingField[]
) => {
  const collected = new Set<MissingField>();
  for (const provider of providers) {
    const fields = docCollectableFields(provider);
    for (const field of missing) {
      if (fields[field]) collected.add(field);
    }
  }
  const byHand = missing.filter((field) => !collected.has(field));
  const humanUrl =
    providers.map((provider) => providerDocHumanUrl(provider)).find(Boolean) ??
    null;
  const label = (fields: readonly MissingField[]) =>
    fields.map((field) => MISSING_FIELD_LABELS[field]).join(" · ");

  if (collected.size === 0) {
    return `이 공급자는 기계가 읽는 공식 문서를 내지 않아, 전부 사람이 확인해야 합니다${
      humanUrl ? ` (${humanUrl})` : ""
    }.`;
  }
  if (byHand.length === 0) {
    return "이 값들은 공식 문서 자동 수집 대상이라, 다음 수집이 성공하면 스스로 채워집니다.";
  }
  return `이 중 ${label([...collected])}는 공식 문서 자동 수집 대상이고, ${label(
    byHand
  )}는 사람이 확인해야 합니다${humanUrl ? ` (${humanUrl})` : ""}.`;
};

/** What a tier word claims about the seat, in the copy's own words. */
const tierPhrase = (tier: ModelTierReading) => {
  switch (tier.kind) {
    case "economy":
      return "경량·저가 파생형";
    case "speed":
      return "속도 지향 파생형";
    case "flagship":
      return "상위 tier";
    case "standard":
      return "기본 tier";
    default:
      return null;
  }
};

const smartChatAssessment = (input: {
  apiModel: string;
  provider: string;
  providers: readonly string[];
  candidateEvidence?: ModelCandidateEvidence | null;
  servedModels?: readonly ServedModelPortfolioEntry[];
  siblingApiModels?: readonly string[];
  googleBraveSearchNote: string;
}): ModelTriageAssessment => {
  const candidateRole = chatRole(input.apiModel, input.candidateEvidence);
  const owner = modelOwner(input.apiModel);
  const ownerModels = (input.servedModels ?? [])
    .filter(
      (model) =>
        (model.product ?? modelProductSurface(model.apiModel)) === "chat" &&
        owner !== "unknown" &&
        modelOwner(model.apiModel) === owner
    )
    .sort(
      (a, b) =>
        (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
          (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
        portfolioName(a).localeCompare(portfolioName(b))
    );
  const ownerModelsWithRole = ownerModels.map((model) => ({
    model,
    role: chatRole(model.apiModel, null, model),
  }));
  const sameRole = ownerModelsWithRole
    .filter((entry) => entry.role === candidateRole)
    .map((entry) => entry.model);
  const comparisonScore = (model: ServedModelPortfolioEntry) => {
    const evidence = input.candidateEvidence;
    if (!evidence) return 0;
    return [
      evidence.contextWindowTokens && model.contextWindowTokens,
      evidence.maxOutputTokens && model.maxOutputTokens,
      evidence.supportsImage != null && model.supportsImage != null,
      evidence.supportsNativePdf != null && model.supportsNativePdf != null,
      evidence.observedInputUsdPerMillionTokens != null &&
        model.inputUsdPerMillionTokens != null,
      evidence.observedOutputUsdPerMillionTokens != null &&
        model.outputUsdPerMillionTokens != null,
    ].filter(Boolean).length;
  };
  const comparisonPool = sameRole.length ? sameRole : ownerModels;
  const baseline = [...comparisonPool].sort(
    (a, b) =>
      comparisonScore(b) - comparisonScore(a) ||
      (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
        (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
  )[0];
  // `general` means the catalogue did not establish a role. Absence of a
  // matching current role is not a gap when the candidate's own role is the
  // missing fact -- Claude Fable is the concrete failure this distinction
  // prevents.
  const candidateRoleIsKnown = candidateRole !== "general";
  const roleGap =
    candidateRoleIsKnown &&
    ownerModels.length > 0 &&
    sameRole.length === 0 &&
    ownerModelsWithRole.every((entry) => entry.role !== "general");
  const overlapsRole = candidateRoleIsKnown && sameRole.length > 0;
  const facts = candidateFacts(input.candidateEvidence);
  const deltas = capabilityDeltas(input.candidateEvidence, baseline);
  const missing = missingEvidenceFields(input.candidateEvidence);
  const aliasNote = providerAliasNote(input.candidateEvidence).trim();

  // Where the candidate sits in its maker's own release wave. This is the
  // first thing worth saying when it is readable, because it is the one fact
  // that separates five ids arriving on the same morning.
  const relation = modelPortfolioRelation(input.apiModel, ownerModels);
  const against = relation.against ? portfolioName(relation.against) : null;
  const candidateTierPhrase = tierPhrase(relation.candidateTier);
  const waveBaseIsQueued =
    modelGenerationFamily(input.apiModel).tier.word !== null &&
    sameWaveSiblings(input.apiModel, input.siblingApiModels ?? []).some(
      (sibling) => sibling.tier.word === null && !isPreviewModel(sibling.apiModel)
    );

  const lineupPoint =
    owner === "unknown"
      ? "후보 ID만으로 제작사를 식별하지 못해 현재 라인업과 안전하게 연결할 수 없습니다."
      : ownerModels.length
        ? `현재 Tomverse의 같은 제작사 모델은 ${ownerModels
            .slice(0, 3)
            .map((model) => `'${portfolioName(model)}'`)
            .join("·")}입니다.`
        : "현재 Tomverse에는 같은 제작사의 활성 모델이 없습니다.";
  const rolePoint = roleGap
    ? `후보 ID와 공급자 근거상 ${roleLabel(candidateRole)}으로, 현재 라인업에 없는 역할을 채웁니다.`
    : overlapsRole
      ? `후보 ID와 공급자 근거상 ${roleLabel(candidateRole)}이라 '${portfolioName(baseline!)}'과 역할이 겹칩니다.`
      : candidateRoleIsKnown
        ? `후보 ID와 공급자 근거상 ${roleLabel(candidateRole)}으로 보입니다.`
        : "공급자 근거가 후보의 제품 역할을 분류할 만큼 충분하지 않습니다.";
  const evidencePoint = facts.length
    ? `공급자 근거로 확인된 후보 특성은 ${facts.join(" · ")}입니다.`
    : `${input.provider}의 모델 목록은 이 후보의 컨텍스트·출력·모달리티·가격을 담고 있지 않습니다.`;
  const deltaPoints = [
    deltas.gains.length ? `확인된 이점은 ${deltas.gains.join(" · ")}입니다.` : null,
    deltas.losses.length ? `확인된 열위는 ${deltas.losses.join(" · ")}입니다.` : null,
    deltas.tradeoffs.length ? `가격 절충점은 ${deltas.tradeoffs.join(" · ")}입니다.` : null,
  ];
  const checkList = missing.length
    ? `확인할 값은 ${missing
        .map((field) => MISSING_FIELD_LABELS[field])
        .join(" · ")}입니다. ${missingEvidenceSourceKo(input.providers, missing)}`
    : "";
  const points = [
    lineupPoint,
    rolePoint,
    evidencePoint,
    ...deltaPoints,
    ...siblingWavePoints({
      apiModel: input.apiModel,
      siblingApiModels: input.siblingApiModels ?? [],
    }),
    aliasNote,
    input.googleBraveSearchNote.trim(),
  ];

  // A generation the id states outranks every other reading of it: an older
  // generation of a served family is decided, and a newer one of the exact
  // family in the catalogue is the upgrade an operator came here to find.
  if (relation.kind === "older_generation" && against) {
    const tierNote =
      candidateTierPhrase && !relation.sameTier
        ? `이고, ID 표기상 ${candidateTierPhrase}입니다`
        : "입니다";
    return triaged({
      priority: "low",
      kind: "general_chat",
      product: "chat",
      verdictKo: `서비스 중인 '${against}'는 ${relation.servedGeneration} 세대인데 이 후보는 ${relation.candidateGeneration} 세대${tierNote}.`,
      pointsKo: points,
      nextStepKo:
        "상위 세대를 이미 서비스하므로 편입 근거가 없습니다. 가격이나 지연시간에서 뒤집을 실측 근거가 없다면 제외가 맞습니다.",
    });
  }

  if (relation.kind === "same_generation" && against) {
    if (relation.sameTier) {
      return triaged({
        priority: "low",
        kind: "general_chat",
        product: "chat",
        verdictKo: `서비스 중인 '${against}'와 세대(${relation.candidateGeneration})도 tier도 같아, 같은 자리를 놓고 겹칩니다.`,
        pointsKo: points,
        nextStepKo:
          "새 모델로 추가하기보다 기존 항목의 공급자·별칭 정보로 관리하는 편이 맞습니다.",
      });
    }
    return triaged({
      priority: waveBaseIsQueued ? "review" : roleGap ? "recommended" : "review",
      kind: "general_chat",
      product: "chat",
      verdictKo: `서비스 중인 '${against}'와 같은 ${relation.candidateGeneration} 세대의 ${candidateTierPhrase ?? "다른 tier"}입니다.`,
      pointsKo: points,
      nextStepKo:
        (relation.candidateTier.kind === "economy" ||
        relation.candidateTier.kind === "speed"
          ? "저가·고속 슬롯을 만들 계획이 있을 때만 편입 가치가 있습니다. 그 결정은 품질이 아니라 가격과 지연시간으로 내려야 합니다. "
          : "같은 세대의 상위 tier라면 품질·가격 차이가 편입 근거입니다. ") + checkList,
    });
  }

  if (relation.kind === "family_seat_mismatch" && against) {
    const lowerSeat =
      tierRank(relation.servedTier.kind) < tierRank(relation.candidateTier.kind);
    return triaged({
      priority: waveBaseIsQueued ? "review" : roleGap ? "recommended" : "review",
      kind: "general_chat",
      product: "chat",
      verdictKo: lowerSeat
        ? `이 후보는 ${relation.candidateGeneration} 세대이지만, 서비스 중인 '${against}'(${relation.servedGeneration})는 더 낮은 자리라 세대 비교의 기준이 되지 않습니다.`
        : `이 후보는 ${relation.candidateGeneration} 세대이지만, 서비스 중인 '${against}'(${relation.servedGeneration})는 다른 자리라 세대 비교의 기준이 되지 않습니다.`,
      pointsKo: points,
      nextStepKo:
        "자리별로 따로 봐야 합니다. 공식 가격과 컨텍스트를 확인한 뒤 이 자리의 채택을 결정하면 됩니다.",
    });
  }

  if (relation.kind === "newer_generation" && against) {
    if (relation.sameTier) {
      return triaged({
        priority: "recommended",
        kind: "general_chat",
        product: "chat",
        verdictKo: `서비스 중인 '${against}'(${relation.servedGeneration} 세대)의 상위 세대 ${relation.candidateGeneration}이라, 같은 자리를 대체할 후보입니다.`,
        pointsKo: points,
        nextStepKo: `${checkList ? `${checkList} ` : ""}공식 가격과 컨텍스트가 확인되면 교체 채택을 결정할 수 있습니다.`,
      });
    }
    return triaged({
      priority: waveBaseIsQueued ? "review" : roleGap ? "recommended" : "review",
      kind: "general_chat",
      product: "chat",
      verdictKo: `서비스 중인 '${against}'(${relation.servedGeneration} 세대)보다 높은 ${relation.candidateGeneration} 세대이지만, ID 표기상 ${candidateTierPhrase ?? "다른 tier"}입니다.`,
      pointsKo: points,
      nextStepKo:
        (relation.candidateTier.kind === "economy" ||
        relation.candidateTier.kind === "speed"
          ? `같은 세대의 기본형을 먼저 결정하고, 이 후보는 저가·고속 슬롯을 만들 때 가격으로 판단하면 됩니다. `
          : `상위 tier이므로 기존 모델을 대체할지 병행할지부터 정해야 합니다. `) + checkList,
    });
  }

  if (roleGap) {
    return triaged({
      priority: waveBaseIsQueued ? "review" : "recommended",
      kind: "general_chat",
      product: "chat",
      verdictKo: `현재 라인업에 없는 ${roleLabel(candidateRole)} 역할을 채울 수 있는 후보입니다.`,
      pointsKo: points,
      nextStepKo: `역할 보완 후보로 우선 검토하되, ${checkList ? `${checkList} ` : ""}공식 가격과 실제 지연시간을 확인한 뒤 채택해야 합니다.`,
    });
  }

  if (overlapsRole) {
    return triaged({
      priority: deltas.gains.length
        ? "recommended"
        : facts.length
          ? "review"
          : "needs_evidence",
      kind: "general_chat",
      product: "chat",
      verdictKo: `'${portfolioName(baseline!)}'과 같은 역할을 놓고 겹치는 후보입니다.`,
      pointsKo: points,
      nextStepKo:
        "품질은 모델 목록에서 알 수 없으므로, 공식 벤치마크·가격·지연시간 중 명확한 우위가 없으면 병행 추가보다 기존 모델 유지 또는 교체 검토가 적절합니다. " +
        checkList,
    });
  }

  return triaged({
    priority:
      owner === "unknown" || ownerModels.length > 0 ? "needs_evidence" : "review",
    kind: "general_chat",
    product: "chat",
    verdictKo:
      owner === "unknown"
        ? "제작사를 식별하지 못해 현재 라인업과 비교할 수 없는 후보입니다."
        : ownerModels.length
          ? "같은 제작사 모델은 있지만, 세대도 역할도 확정되지 않아 무엇을 보완·대체하는지 말할 수 없는 후보입니다."
          : "같은 제작사의 활성 모델이 없어 공급자 다양성 관점에서만 의미가 있는 후보입니다.",
    pointsKo: points,
    nextStepKo: `${checkList ? `${checkList} ` : ""}공급자 공식 포지셔닝과 가격, 실제 지연시간을 먼저 확인해야 결정할 수 있습니다.`,
  });
};

export const assessModelLifecycleItem = (input: {
  action: string;
  apiModel: string;
  providers: readonly string[];
  availability: ModelAvailability;
  lifecycle: string | null;
  servedByTomverse: boolean;
  /**
   * The served model that is a later generation of this candidate's own line,
   * from `supersedingServedModel`. Named rather than flagged: an operator has
   * to be able to check the claim.
   */
  supersededBy?: string | null;
  /** Facts observed in the provider response for this candidate family. */
  candidateEvidence?: ModelCandidateEvidence | null;
  /** Active, user-visible Tomverse models; comparison is narrowed by owner. */
  servedModels?: readonly ServedModelPortfolioEntry[];
  /**
   * The other candidates open in the same queue. A provider ships a generation
   * as a set, and the row cannot be judged well without them.
   */
  siblingApiModels?: readonly string[];
}): ModelTriageAssessment => {
  const provider = providerLabel(input.providers);
  const product = modelProductSurface(input.apiModel);
  const googleBraveSearchNote = input.providers.includes("google")
    ? " Google 모델의 웹검색은 별도 검색 모델이 아니라 function tool 지원을 확인한 뒤 Tomverse의 Brave app-managed 경로에 등록해야 합니다."
    : "";

  if (input.action === "retire") {
    return triaged({
      priority: "recommended",
      kind: "retirement",
      product,
      verdictKo: `${provider} 카탈로그에서 더 이상 확인되지 않는 Tomverse 제공 모델입니다.`,
      nextStepKo:
        "대체 모델을 먼저 정하고, 이 모델을 기본값이나 대화에 저장해 둔 사용자가 있는지 확인해야 합니다.",
    });
  }
  if (input.lifecycle) {
    return triaged({
      priority: "no_action",
      kind: product === "image_generation" ? "image_generation" : "general_chat",
      product,
      verdictKo: `${provider}가 '${input.lifecycle}' 수명주기를 명시한 모델이라 편입 대상이 아닙니다.`,
      nextStepKo:
        "제외해도 됩니다. 이 라인을 계속 쓸 생각이면 공급자가 안내한 대체 모델만 확인하면 됩니다.",
    });
  }
  if (input.availability === "stale") {
    return triaged({
      priority: "no_action",
      kind: product === "image_generation" ? "image_generation" : "general_chat",
      product,
      verdictKo: `${provider}의 최신 성공 스캔 응답에 더 이상 없는 ID입니다.`,
      nextStepKo:
        "지금 제공되지 않으므로 편입 대상이 아닙니다. 공급자가 다시 내보내면 이 대기열에 다시 올라옵니다.",
    });
  }
  if (product === "unsupported") {
    if (isMultiAgentModel(input.apiModel)) {
      return triaged({
        priority: "no_action",
        kind: "specialized_non_chat",
        product,
        verdictKo:
          "멀티에이전트 연구 오케스트레이션 모델이라 지금 Tomverse 채팅 모델로 등록하면 동작하지 않습니다.",
        pointsKo: [
          "일반 Chat Completions가 아니라 별도 Responses API와 연구 도구 실행 경로를 요구합니다.",
        ],
        nextStepKo:
          "여기서는 제외하고, Deep Research와의 제품 역할·비용·비동기 실행 정책을 정한 뒤 별도 통합 과제로 다뤄야 합니다.",
      });
    }
    if (isSearchSpecializedModel(input.apiModel)) {
      return triaged({
        priority: "no_action",
        kind: "specialized_non_chat",
        product,
        verdictKo: "검색 전용 모델 또는 엔드포인트로 보여 채팅 카탈로그에 넣을 대상이 아닙니다.",
        pointsKo: [
          "Tomverse의 Google 웹검색은 일반 Gemini 모델이 Brave API function tool을 호출하는 app-managed 경로입니다.",
        ],
        nextStepKo:
          "이 ID를 추가하는 대신 일반 채팅 모델의 도구 호출 호환성과 웹검색 capability 등록을 검토해야 합니다.",
      });
    }
    return triaged({
      priority: "no_action",
      kind: "specialized_non_chat",
      product,
      verdictKo:
        "음성·검색 등 현재 Tomverse 제품 범위 밖 엔드포인트용 모델로 보입니다.",
      nextStepKo:
        "지원 제품이 정해지기 전에는 편입 대상이 아닙니다. 제품 결정이 선행 조건입니다.",
    });
  }
  // Ahead of the product branches because it is the same answer for both, and
  // ahead of `servedByTomverse` because it is the case that check cannot see:
  // Opus 4.6 is not the family Tomverse serves, it is the generation before it.
  if (input.supersededBy) {
    return triaged({
      priority: "no_action",
      kind: "superseded_version",
      product,
      verdictKo: `같은 라인의 상위 버전 '${input.supersededBy}'을(를) Tomverse가 이미 서비스합니다.`,
      nextStepKo:
        "하위 버전을 따로 둘 근거가 없습니다. 제외해도 잃는 정보가 없습니다.",
    });
  }
  if (product === "image_generation") {
    if (input.servedByTomverse) {
      return triaged({
        priority: "no_action",
        kind: "image_generation",
        product,
        verdictKo: "같은 이미지 모델 패밀리가 이미 Tomverse 이미지 생성 원장에 있습니다.",
        nextStepKo:
          "새 모델로 추가하지 말고 기존 프로필의 공급자·가격·활성 상태를 갱신하면 됩니다.",
      });
    }
    if (input.availability === "unknown") {
      return triaged({
        priority: "needs_evidence",
        kind: "image_generation",
        product,
        verdictKo: `${provider}의 최근 스캔이 실패했거나 실행 이력이 없어 제공 여부를 모릅니다.`,
        nextStepKo:
          "스캔이 한 번 성공한 뒤에 판단해야 합니다. 그 전에는 이미지 후보로도 결정할 수 없습니다.",
      });
    }
    if (isPreviewModel(input.apiModel)) {
      return triaged({
        priority: "no_action",
        kind: "image_generation",
        product,
        verdictKo: `${provider}의 미리보기·실험 단계 이미지 생성 모델입니다.`,
        nextStepKo:
          "안정 버전만 검토하는 정책에 따라 지금은 제외합니다. 정식 출시되면 새 후보로 올라옵니다.",
      });
    }
    const imageOwner = modelOwner(input.apiModel);
    const imagePortfolio = (input.servedModels ?? []).filter(
      (model) =>
        (model.product ?? modelProductSurface(model.apiModel)) ===
          "image_generation" &&
        imageOwner !== "unknown" &&
        modelOwner(model.apiModel) === imageOwner
    );
    const facts = candidateFacts(input.candidateEvidence);
    const aliasNote = providerAliasNote(input.candidateEvidence).trim();
    return triaged({
      priority:
        imageOwner === "unknown"
          ? "needs_evidence"
          : imagePortfolio.length === 0
            ? "recommended"
            : "review",
      kind: "image_generation",
      product,
      verdictKo:
        imageOwner === "unknown"
          ? "후보 ID만으로 이미지 모델 제작사를 식별하지 못해 Studio의 기존 모델과 연결할 수 없습니다."
          : imagePortfolio.length
            ? `Tomverse Studio가 같은 제작사의 '${portfolioName(imagePortfolio[0])}'을(를) 이미 제공합니다.`
            : "Tomverse Studio에 같은 제작사의 활성 이미지 모델이 없어 공급자 다양성을 보완할 수 있는 후보입니다.",
      pointsKo: [
        facts.length
          ? `공급자 근거로 확인된 후보 특성은 ${facts.join(" · ")}입니다.`
          : `${provider} 모델 목록은 해상도·편집·지연시간·이미지당 가격을 담고 있지 않습니다.`,
        aliasNote,
      ],
      nextStepKo:
        "Studio 채택 전에 기존 모델과 동일 프롬프트 품질, 편집 지원, 지원 해상도, 실제 지연시간, 이미지당 최악 비용을 대조해야 합니다.",
    });
  }
  if (input.servedByTomverse) {
    return triaged({
      priority: "no_action",
      kind: "general_chat",
      product,
      verdictKo: "같은 모델 패밀리가 이미 Tomverse 카탈로그에 있습니다.",
      nextStepKo:
        "새 모델로 추가하지 말고 기존 항목의 공급자·별칭 정보로 관리하면 됩니다.",
    });
  }
  if (input.availability === "unknown") {
    return triaged({
      priority: "needs_evidence",
      kind: "general_chat",
      product,
      verdictKo: `${provider}의 최근 스캔이 실패했거나 실행 이력이 없어 제공 여부를 모릅니다.`,
      nextStepKo:
        "스캔이 한 번 성공한 뒤에 판단해야 합니다. 지금 채택하면 제공되지 않는 모델을 등록할 수 있습니다.",
    });
  }
  if (isMovingModelAlias(input.apiModel)) {
    const portfolio = smartChatAssessment({
      apiModel: input.apiModel,
      provider,
      providers: input.providers,
      candidateEvidence: input.candidateEvidence,
      servedModels: input.servedModels,
      siblingApiModels: input.siblingApiModels,
      googleBraveSearchNote,
    });
    return triaged({
      priority: "review",
      kind: "moving_alias",
      product,
      verdictKo: portfolio.verdictKo,
      pointsKo: [
        `${provider}의 이동형 별칭이라 어느 날 가리키는 버전이 바뀔 수 있습니다.`,
        ...portfolio.pointsKo,
      ],
      nextStepKo: portfolio.nextStepKo,
    });
  }
  if (isDatedModelSnapshot(input.apiModel)) {
    const portfolio = smartChatAssessment({
      apiModel: input.apiModel,
      provider,
      providers: input.providers,
      candidateEvidence: input.candidateEvidence,
      servedModels: input.servedModels,
      siblingApiModels: input.siblingApiModels,
      googleBraveSearchNote,
    });
    return triaged({
      priority: "review",
      kind: "dated_snapshot",
      product,
      verdictKo: portfolio.verdictKo,
      pointsKo: [
        `${provider}의 날짜·리비전 고정 스냅샷이라, 재현성 고정이 필요할 때만 기본 alias 대신 고를 값입니다.`,
        ...portfolio.pointsKo,
      ],
      nextStepKo: portfolio.nextStepKo,
    });
  }
  if (isPreviewModel(input.apiModel)) {
    return triaged({
      priority: "no_action",
      kind: "preview",
      product,
      verdictKo: `${provider}에서 확인되지만 미리보기·실험 단계입니다.`,
      pointsKo: [googleBraveSearchNote.trim()],
      nextStepKo:
        "안정 버전만 검토하는 정책에 따라 지금은 제외합니다. 정식 출시되면 새 후보로 다시 올라옵니다.",
    });
  }
  if (isCodeSpecializedModel(input.apiModel)) {
    return triaged({
      priority: "low",
      kind: "specialized_code",
      product,
      verdictKo: `${provider}의 코드 작업 특화 모델입니다.`,
      nextStepKo:
        "Chat의 일반 대화 수요로는 편입 근거가 약합니다. 코딩 제품 범위가 정해질 때 다시 보는 것이 맞습니다.",
    });
  }
  return smartChatAssessment({
    apiModel: input.apiModel,
    provider,
    providers: input.providers,
    candidateEvidence: input.candidateEvidence,
    servedModels: input.servedModels,
    siblingApiModels: input.siblingApiModels,
    googleBraveSearchNote,
  });
};
