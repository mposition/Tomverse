export const dynamic = "force-dynamic";
export const maxDuration = 120;
import {
  isProductResearchRouteAuthorized,
  isProductResearchRouteEnabled,
  productResearchInternalError,
  productResearchJson,
  productResearchNotFound,
  productResearchUnauthorized,
} from "@/lib/productResearchObservationRouteAuth";
import {
  PRODUCT_RESEARCH_SCOUT_SECRET_ENV,
  PRODUCT_RESEARCH_SCOUT_SWITCH_ENV,
} from "@/lib/productResearchScoutCore";
import { MEMORY_PROBE_LOCALES } from "@/lib/productResearchScoutMemoryCases";
import {
  memoryScoutEnabled,
  sampleMemoryQuality,
  proposeMemoryImprovements,
} from "@/lib/productResearchScoutMemory";

import { ARM_NAMES } from "@/lib/scoutMemoryExperiment";
import {
  comparisonEnabled,
  sampleMemoryTrial,
} from "@/lib/scoutMemoryExperimentRunner";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ target: string }> },
) {
  if (
    !isProductResearchRouteEnabled(
      process.env,
      PRODUCT_RESEARCH_SCOUT_SWITCH_ENV,
    ) ||
    !memoryScoutEnabled()
  )
    return productResearchNotFound();
  if (
    !isProductResearchRouteAuthorized(
      req,
      process.env,
      PRODUCT_RESEARCH_SCOUT_SECRET_ENV,
    )
  )
    return productResearchUnauthorized();
  const { target } = await ctx.params;
  if (target.startsWith("compare.")) {
    if (!comparisonEnabled()) return productResearchNotFound();
    const [, day, language, armName, ...extra] = target.split(".");
    const locale = MEMORY_PROBE_LOCALES.find((l) => l === language),
      arm = ARM_NAMES.find((a) => a === armName);
    if (
      extra.length ||
      !locale ||
      !arm ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")
    )
      return productResearchNotFound();
    if (day !== new Date().toISOString().slice(0, 10))
      return productResearchJson({ judged: false, reason: "day_changed" }, 200);
    try {
      return productResearchJson(
        await sampleMemoryTrial(locale, arm, day),
        200,
      );
    } catch (err) {
      return productResearchInternalError(
        "product_research_memory_comparison",
        err,
      );
    }
  }
  const locale = MEMORY_PROBE_LOCALES.find((l) => l === target);
  if (!locale && target !== "ideas") return productResearchNotFound();
  try {
    const result = locale
      ? await sampleMemoryQuality(locale)
      : await proposeMemoryImprovements();
    return productResearchJson(
      result,
      !result.judged && result.reason === "model_failed" ? 502 : 200,
    );
  } catch (err) {
    return productResearchInternalError("product_research_scout_memory", err);
  }
}
