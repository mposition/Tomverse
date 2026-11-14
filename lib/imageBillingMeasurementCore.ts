// Measuring an image model's billing from the admin console (image-generation
// policy section 12.1): the plan an operator approves, what each sample may
// cost before it is sent, what it did cost from the usage the provider
// reported, and what the samples support. Pure: no database, no environment,
// no provider call. The server (lib/imageBillingMeasurement.ts) sends the
// requests; an operator decides whether the proposed terms are confirmed.
//
// A verdict proposes terms; it never confirms them. Confirmation is the
// operator's action, with official sources, and writes its own audit row.

import { z } from "zod";

import { IMAGE_PROMPT_BUDGET_MICRO_USD } from "@/lib/imageGenerationPricing";
import { GOOGLE_IMAGE_OUTPUT_LIMIT_MARGIN, type ConfirmedImageBillingTerms } from "@/lib/imageModelRegistry";

const imageQualityEnum = z.enum(["low", "medium", "high"]);
const imageSizeEnum = z.enum(["1024x1024", "1536x1024", "1024x1536"]);

/**
 * Billing terms an operator confirmed from a measurement, as stored in
 * ImageModelBillingTerms.terms (policy section 12.1). Bounded so a stored row
 * cannot describe a cap no request could hold. Client-safe, like this module.
 */
export const confirmedImageBillingTermsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("per_image_no_thinking") }).strict(),
  z
    .object({
      kind: z.literal("measured_output_limit"),
      maxOutputTokens: z.number().int().min(256).max(65_536),
      textOutputUsdPerMTok: z.number().positive().max(1_000),
      imageTokensPerImage: z.number().int().positive().max(100_000),
      imageOutputUsdPerMTok: z.number().positive().max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tokens_per_image"),
      imageOutputUsdPerMTok: z.number().positive().max(1_000),
      tokens: z
        .array(z.object({ quality: imageQualityEnum, size: imageSizeEnum, tokens: z.number().int().positive().max(200_000) }).strict())
        .min(1)
        .max(9)
        .refine((rows) => new Set(rows.map((row) => `${row.quality}|${row.size}`)).size === rows.length, "each option once"),
    })
    .strict(),
]);

/** Default off: a measurement is a paid provider call (owner decision required to turn it on). */
export const IMAGE_BILLING_MEASUREMENT_ENV = "IMAGE_BILLING_MEASUREMENT_ENABLED";

export const imageBillingMeasurementEnabled = (env: Readonly<Record<string, string | undefined>>) =>
  ["1", "true"].includes((env[IMAGE_BILLING_MEASUREMENT_ENV] ?? "").trim().toLowerCase());

/** The most one measurement may be approved to spend, micro-USD ($10). */
export const MEASUREMENT_MAX_COST_MICRO_USD = 10_000_000;

/**
 * How long one run may take, and the slowest one sample can be (a Qwen
 * generation and its download, 150 s each). A sample is sent only while the
 * time so far plus that worst case fits; the route's maxDuration (2,400 s)
 * is above it. The slowest plan -- 12 samples of 150 s, or 6 Qwen samples of
 * 300 s -- is 1,800 s.
 */
export const MEASUREMENT_RUN_BUDGET_MS = 2_100_000;
export const MEASUREMENT_SAMPLE_WORST_MS = 300_000;

/** The most samples one plan may send. */
export const MEASUREMENT_MAX_SAMPLES = 12;

/**
 * A running measurement older than this is reported as interrupted (its spend
 * unknown) and no longer blocks a new one. Longer than the slowest possible
 * run -- 12 samples at three 150 s attempts each is about 91 minutes -- so a
 * live run is never taken for a dead one.
 */
export const MEASUREMENT_STALE_MS = 2 * 60 * 60 * 1000;

/** One fixed, neutral prompt: the measurement is of billing, not of the picture. */
export const MEASUREMENT_PROMPT =
  "A white ceramic teapot on a wooden kitchen table beside a window, soft morning daylight, photorealistic.";

/** Image tokens two 1K Google images could bill (1,120 each, measured), with slack. */
const GOOGLE_SAMPLE_IMAGE_TOKEN_CEILING = 2_500;
/** Output tokens one OpenAI image sample is assumed to stay under before it is sent. */
const OPENAI_SAMPLE_OUTPUT_TOKEN_CEILING = 16_384;

const quality = z.enum(["low", "medium", "high"]);
const size = z.enum(["1024x1024", "1536x1024", "1024x1536"]);
const apiModelId = z.string().trim().min(1).max(120);
const maxCostMicroUsd = z.number().int().positive().max(MEASUREMENT_MAX_COST_MICRO_USD);
const rate = z.number().positive().max(1_000);

export const measurementPlanSchema = z.discriminatedUnion("method", [
  // Google direct: does the sent output limit hold text and thinking, and is an image still delivered?
  z
    .object({
      method: z.literal("output_limit"),
      provider: z.literal("google"),
      apiModelId,
      maxOutputTokens: z.number().int().min(256).max(65_536),
      samples: z.number().int().min(1).max(12),
      textOutputUsdPerMTok: rate,
      imageOutputUsdPerMTok: rate,
      maxCostMicroUsd,
    })
    .strict(),
  // OpenAI: how many image output tokens one image of each quality and size bills.
  z
    .object({
      method: z.literal("tokens_per_image"),
      provider: z.literal("openai"),
      apiModelId,
      options: z
        .array(z.object({ quality, size }).strict())
        .min(1)
        .max(9)
        .refine((rows) => new Set(rows.map((row) => `${row.quality}|${row.size}`)).size === rows.length, "each option once"),
      samplesPerOption: z.number().int().min(1).max(3),
      imageOutputUsdPerMTok: rate,
      maxCostMicroUsd,
    })
    .strict()
    .refine((plan) => plan.options.length * plan.samplesPerOption <= MEASUREMENT_MAX_SAMPLES, "at most 12 samples"),
  // Qwen: is it billed per image, with no token or thinking usage, on the request the adapter sends?
  z
    .object({
      method: z.literal("per_image"),
      provider: z.literal("qwen"),
      apiModelId,
      samples: z.number().int().min(1).max(6),
      perImageUsd: z.number().positive().max(5),
      maxCostMicroUsd,
    })
    .strict(),
]);
export type MeasurementPlan = z.infer<typeof measurementPlanSchema>;
export type MeasurementMethod = MeasurementPlan["method"];

/** The method a provider's billing is measured by, or null where none applies. */
export const measurementMethodFor = (provider: string): MeasurementMethod | null =>
  provider === "google" ? "output_limit" : provider === "openai" ? "tokens_per_image" : provider === "qwen" ? "per_image" : null;

export type SampleRequest = { quality: "low" | "medium" | "high"; size: "1024x1024" | "1536x1024" | "1024x1536" };

/** The requests a plan sends, in order. */
export const sampleRequests = (plan: MeasurementPlan): SampleRequest[] => {
  if (plan.method === "tokens_per_image") {
    return plan.options.flatMap((option) => Array.from({ length: plan.samplesPerOption }, () => ({ ...option })));
  }
  // Google and Qwen price by resolution tier, not quality; 1K square is what both requests map.
  return Array.from({ length: plan.samples }, () => ({ quality: "medium" as const, size: "1024x1024" as const }));
};

/**
 * What one sample is allowed to cost before it is sent. Not a guarantee --
 * an unmeasured model is unbounded by definition -- so a sample that bills
 * more stops the run, and the next one is sent only while the spend so far
 * plus this ceiling stays within the approved maximum.
 */
export const sampleCeilingMicroUsd = (plan: MeasurementPlan): number => {
  if (plan.method === "output_limit") {
    return (
      Math.ceil(
        GOOGLE_IMAGE_OUTPUT_LIMIT_MARGIN * plan.maxOutputTokens * plan.textOutputUsdPerMTok +
          GOOGLE_SAMPLE_IMAGE_TOKEN_CEILING * plan.imageOutputUsdPerMTok
      ) + IMAGE_PROMPT_BUDGET_MICRO_USD
    );
  }
  if (plan.method === "tokens_per_image") {
    return Math.ceil(OPENAI_SAMPLE_OUTPUT_TOKEN_CEILING * plan.imageOutputUsdPerMTok) + IMAGE_PROMPT_BUDGET_MICRO_USD;
  }
  return Math.ceil(2 * plan.perImageUsd * 1_000_000);
};

/** The plan's worst case: every sample at its ceiling. The operator approves at least this. */
export const planWorstCaseMicroUsd = (plan: MeasurementPlan): number =>
  sampleRequests(plan).length * sampleCeilingMicroUsd(plan);

/** Why a plan cannot be started as approved, or null. */
export const planProblem = (plan: MeasurementPlan): string | null =>
  planWorstCaseMicroUsd(plan) > plan.maxCostMicroUsd ? `max_cost_below_worst_case:${planWorstCaseMicroUsd(plan)}` : null;

/** What one sample did, from the provider's response; the image itself is never kept. */
export type MeasurementSample = {
  index: number;
  quality: string;
  size: string;
  delivered: boolean;
  /** The failure phase when no image came back. */
  failure: string | null;
  /**
   * True when the provider accepted and generated, and only fetching or
   * checking the result failed (a Qwen asset download, say): billed, whatever
   * HTTP status the failure carries.
   */
  afterGeneration?: boolean;
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  nonImageBillableTokens: number | null;
  billedImageTokens: number | null;
  /** Numeric usage fields the response reported, flattened ("output_tokens_details.image_tokens"). */
  usage: Record<string, number> | null;
  width: number | null;
  height: number | null;
  providerRequestId: string | null;
  costMicroUsd: number;
  durationMs: number;
};

const known = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * A generation request the provider refused outright (4xx other than rate
 * limit and timeout) did no billable work. A 4xx from fetching a generated
 * result is not that: the image was made and billed.
 */
const refusedBeforeWork = (sample: Pick<MeasurementSample, "delivered" | "httpStatus" | "afterGeneration">) =>
  !sample.delivered &&
  !sample.afterGeneration &&
  sample.httpStatus !== null &&
  sample.httpStatus >= 400 &&
  sample.httpStatus < 500 &&
  sample.httpStatus !== 408 &&
  sample.httpStatus !== 429;

/**
 * What a sample cost, from its reported usage. Where the usage a cost needs
 * is missing, the sample is counted at its ceiling: the spend is unknown, and
 * the budget must not under-count it.
 */
export const sampleCostMicroUsd = (
  plan: MeasurementPlan,
  sample: Pick<
    MeasurementSample,
    "delivered" | "httpStatus" | "afterGeneration" | "outputTokens" | "nonImageBillableTokens" | "billedImageTokens"
  >
): number => {
  const ceiling = sampleCeilingMicroUsd(plan);
  if (plan.method === "output_limit") {
    if (!known(sample.nonImageBillableTokens) || !known(sample.billedImageTokens)) {
      return refusedBeforeWork(sample) ? 0 : ceiling;
    }
    return (
      Math.ceil(sample.nonImageBillableTokens * plan.textOutputUsdPerMTok + sample.billedImageTokens * plan.imageOutputUsdPerMTok) +
      IMAGE_PROMPT_BUDGET_MICRO_USD
    );
  }
  if (plan.method === "tokens_per_image") {
    if (known(sample.outputTokens) && sample.outputTokens > 0) {
      return Math.ceil(sample.outputTokens * plan.imageOutputUsdPerMTok) + IMAGE_PROMPT_BUDGET_MICRO_USD;
    }
    return refusedBeforeWork(sample) ? 0 : ceiling;
  }
  if (sample.delivered) return Math.ceil(plan.perImageUsd * 1_000_000);
  return refusedBeforeWork(sample) ? 0 : ceiling;
};

/** Usage keys that would mean a per-image model also bills tokens it generates. */
const GENERATED_TOKEN_USAGE = /(output|thinking|reasoning|completion)[a-z_.]*tokens?/i;

/**
 * The largest generated-token count a per-image measurement treats as a fixed
 * counter rather than generated work. wan2.7-image reports `output_tokens: 2`
 * on every image (production measurement 2026-11-14, 6 of 6), and its API
 * reference calls those token values "not billed". Thinking or a rewritten
 * prompt would be hundreds of tokens and would move between requests; a
 * counter this small that never moves is neither.
 */
const FIXED_TOKEN_COUNTER_MAX = 8;

export type MeasurementVerdict = {
  /** True only when every planned sample ran and the samples support `terms`. */
  confirmable: boolean;
  /** Why the terms cannot be confirmed; empty when confirmable. */
  reasons: string[];
  /** Facts worth reading beside the table (spread, extra usage), not blockers. */
  notes: string[];
  /** The terms the samples support, or null. Never stored until an operator confirms them. */
  terms: ConfirmedImageBillingTerms | null;
};

/** What the samples support. Deterministic, so the same samples always read the same. */
export const measurementVerdict = (plan: MeasurementPlan, samples: readonly MeasurementSample[]): MeasurementVerdict => {
  const planned = sampleRequests(plan).length;
  const reasons: string[] = [];
  const notes: string[] = [];
  if (samples.length < planned) reasons.push(`incomplete:${samples.length}/${planned}`);
  const delivered = samples.filter((sample) => sample.delivered);
  let terms: ConfirmedImageBillingTerms | null = null;

  if (plan.method === "output_limit") {
    if (delivered.length < samples.length) reasons.push(`image_missing:${samples.length - delivered.length}/${samples.length}`);
    const bound = GOOGLE_IMAGE_OUTPUT_LIMIT_MARGIN * plan.maxOutputTokens;
    if (samples.some((sample) => !known(sample.nonImageBillableTokens))) reasons.push("usage_missing");
    const over = samples.filter((sample) => known(sample.nonImageBillableTokens) && sample.nonImageBillableTokens > bound);
    if (over.length > 0) reasons.push(`over_bound:${over.length}/${samples.length}`);
    const nonImage = samples.map((sample) => sample.nonImageBillableTokens).filter(known);
    if (nonImage.length > 0) notes.push(`non_image_tokens:${Math.min(...nonImage)}-${Math.max(...nonImage)}`);
    const imageTokens = delivered.map((sample) => sample.billedImageTokens).filter((value): value is number => known(value) && value > 0);
    if (delivered.length > 0 && imageTokens.length < delivered.length) reasons.push("image_tokens_unreported");
    if (imageTokens.length > 0) {
      terms = {
        kind: "measured_output_limit",
        maxOutputTokens: plan.maxOutputTokens,
        textOutputUsdPerMTok: plan.textOutputUsdPerMTok,
        imageTokensPerImage: Math.max(...imageTokens),
        imageOutputUsdPerMTok: plan.imageOutputUsdPerMTok,
      };
    }
  } else if (plan.method === "tokens_per_image") {
    // Every planned sample has to deliver and report its count: a failed or
    // silent sample beside a good one hides whether the count moves.
    if (delivered.length < samples.length) reasons.push(`image_missing:${samples.length - delivered.length}/${samples.length}`);
    if (delivered.some((sample) => !(known(sample.outputTokens) && sample.outputTokens > 0))) reasons.push("usage_missing");
    const rows: { quality: SampleRequest["quality"]; size: SampleRequest["size"]; tokens: number }[] = [];
    for (const option of plan.options) {
      const counts = delivered
        .filter((sample) => sample.quality === option.quality && sample.size === option.size)
        .map((sample) => sample.outputTokens)
        .filter((value): value is number => known(value) && value > 0);
      if (counts.length === 0) {
        reasons.push(`option_unmeasured:${option.quality}/${option.size}`);
        continue;
      }
      const max = Math.max(...counts);
      const min = Math.min(...counts);
      // A count that moved between identical requests is not a fixed count:
      // the confirmed number is twice the largest seen, the same margin the
      // Google bound carries.
      if (min !== max) notes.push(`tokens_vary:${option.quality}/${option.size}:${min}-${max}`);
      rows.push({ ...option, tokens: min === max ? max : 2 * max });
    }
    if (rows.length > 0) terms = { kind: "tokens_per_image", imageOutputUsdPerMTok: plan.imageOutputUsdPerMTok, tokens: rows };
  } else {
    if (delivered.length < samples.length) reasons.push(`image_missing:${samples.length - delivered.length}/${samples.length}`);
    const tokenValues = new Map<string, number[]>();
    for (const sample of samples) {
      for (const [key, value] of Object.entries(sample.usage ?? {})) {
        if (value > 0 && GENERATED_TOKEN_USAGE.test(key)) tokenValues.set(key, [...(tokenValues.get(key) ?? []), value]);
      }
    }
    for (const [key, values] of tokenValues) {
      // A fixed counter is noted, not refused: the same small value on every
      // delivered sample. Anything that moves, or is larger, is generated work.
      const fixed =
        values.length === delivered.length &&
        values.every((value) => value === values[0]) &&
        values[0] <= FIXED_TOKEN_COUNTER_MAX;
      if (fixed) notes.push(`token_counter_fixed:${key}=${values[0]}`);
      else reasons.push(`token_usage_reported:${key}`);
    }
    if (delivered.length > 0) terms = { kind: "per_image_no_thinking" };
  }

  if (samples.length === 0) reasons.push("no_samples");
  const parsed = terms ? confirmedImageBillingTermsSchema.safeParse(terms) : null;
  if (terms && !parsed?.success) {
    reasons.push("terms_out_of_range");
    terms = null;
  }
  return { confirmable: reasons.length === 0 && terms !== null, reasons, notes, terms };
};

/** The admin form's text fields, before they are a plan. */
export type MeasurementForm = {
  maxOutputTokens: string;
  samples: string;
  samplesPerOption: string;
  textRate: string;
  imageRate: string;
  perImageUsd: string;
  /** "quality|size" keys. */
  options: readonly string[];
  /** Empty means the plan's worst case. */
  maxCostUsd: string;
};

export const emptyMeasurementForm = (): MeasurementForm => ({
  maxOutputTokens: "4096",
  samples: "6",
  samplesPerOption: "1",
  textRate: "",
  imageRate: "",
  perImageUsd: "",
  options: ["low|1024x1024", "medium|1024x1024", "high|1024x1024"],
  maxCostUsd: "",
});

const formNumber = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));

/**
 * The plan the form describes, its worst case, and why it cannot start (or
 * null). The maximum defaults to the worst case rounded up to a cent.
 */
export const measurementPlanFromForm = (
  provider: string,
  apiModelId: string,
  form: MeasurementForm
): { plan: MeasurementPlan | null; worstCaseMicroUsd: number | null; problem: string | null } => {
  const method = measurementMethodFor(provider);
  if (!method) return { plan: null, worstCaseMicroUsd: null, problem: "unsupported" };
  const draft =
    method === "output_limit"
      ? {
          method,
          provider,
          apiModelId,
          maxOutputTokens: formNumber(form.maxOutputTokens),
          samples: formNumber(form.samples),
          textOutputUsdPerMTok: formNumber(form.textRate),
          imageOutputUsdPerMTok: formNumber(form.imageRate),
        }
      : method === "tokens_per_image"
        ? {
            method,
            provider,
            apiModelId,
            options: form.options.map((key) => {
              const [quality, size] = key.split("|");
              return { quality, size };
            }),
            samplesPerOption: formNumber(form.samplesPerOption),
            imageOutputUsdPerMTok: formNumber(form.imageRate),
          }
        : { method, provider, apiModelId, samples: formNumber(form.samples), perImageUsd: formNumber(form.perImageUsd) };
  const probe = measurementPlanSchema.safeParse({ ...draft, maxCostMicroUsd: MEASUREMENT_MAX_COST_MICRO_USD });
  if (!probe.success) return { plan: null, worstCaseMicroUsd: null, problem: "invalid_plan" };
  const worst = planWorstCaseMicroUsd(probe.data);
  const typed = formNumber(form.maxCostUsd);
  const max = Number.isFinite(typed) ? Math.round(typed * 1_000_000) : Math.ceil(worst / 10_000) * 10_000;
  const parsed = measurementPlanSchema.safeParse({ ...draft, maxCostMicroUsd: max });
  if (!parsed.success) return { plan: null, worstCaseMicroUsd: worst, problem: max > MEASUREMENT_MAX_COST_MICRO_USD ? "max_cost_too_high" : "invalid_plan" };
  return { plan: parsed.data, worstCaseMicroUsd: worst, problem: planProblem(parsed.data) };
};

/** Flatten a usage object to its numeric fields, two levels deep. */
export const numericUsage = (usage: unknown): Record<string, number> | null => {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof innerValue === "number" && Number.isFinite(innerValue)) out[`${key}.${inner}`] = innerValue;
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
};
