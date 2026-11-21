import { isExternalApiServableModel, isSmartAdaptiveOnlyModel } from "@/lib/externalApiCatalogCore";
import { getModelUsageProfile, type AiModel } from "@/lib/models";

/**
 * The Cursor guide's model table, read from the live model catalogue (the same
 * rows the app loads from /api/models/catalog). A model is listed when the
 * external API serves it on a paid plan (isExternalApiServableModel), so the
 * table and Settings › API keys never disagree on what a key can name. Models
 * only Smart Adaptive routes to are counted, not listed: no client can name them.
 */
export type CursorGuideModelRow = { id: string; name: string; provider: string; credits: number };
export type CursorGuideRename = { from: string; to: string };

/** Provider order on the page; any other provider follows, alphabetically. */
const PROVIDER_ORDER = ["openai", "anthropic", "google", "xai", "deepseek"];
const providerRank = (provider: string) => {
  const rank = PROVIDER_ORDER.indexOf(provider);
  return rank === -1 ? PROVIDER_ORDER.length : rank;
};

const nameable = (model: AiModel) => isExternalApiServableModel(model, "Max");

export const cursorGuideRows = (models: readonly AiModel[]): CursorGuideModelRow[] =>
  models
    .filter(nameable)
    .map((model) => ({ id: model.id, name: model.name, provider: model.provider, credits: getModelUsageProfile(model).credits }))
    .sort((a, b) =>
      providerRank(a.provider) - providerRank(b.provider) ||
      a.provider.localeCompare(b.provider) ||
      a.credits - b.credits ||
      a.name.localeCompare(b.name)
    );

/** How many served models only Smart Adaptive can reach (frontier and apex classes). */
export const smartAdaptiveOnlyCount = (models: readonly AiModel[]) =>
  models.filter((model) => isExternalApiServableModel(model, "Max", { smartAdaptive: true }) && isSmartAdaptiveOnlyModel(model)).length;

/**
 * Retired ids and the listed model that replaces them: the catalogue's
 * replacementModelId chain, followed to its end. Only renames that end on a
 * listed model are shown, so the page never points at an id a key cannot use.
 */
export const cursorGuideRenames = (models: readonly AiModel[]): CursorGuideRename[] => {
  const byId = new Map(models.map((model) => [model.id, model]));
  const listed = new Set(models.filter(nameable).map((model) => model.id));
  const renames: CursorGuideRename[] = [];
  for (const model of models) {
    if (!model.replacementModelId || listed.has(model.id)) continue;
    const seen = new Set([model.id]);
    let target = model.replacementModelId;
    while (!listed.has(target)) {
      const next = byId.get(target)?.replacementModelId;
      if (!next || seen.has(next)) break;
      seen.add(target);
      target = next;
    }
    if (listed.has(target)) renames.push({ from: model.id, to: target });
  }
  return renames.sort((a, b) => a.from.localeCompare(b.from));
};

export const cursorGuideProviders = (rows: readonly CursorGuideModelRow[]) => {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.provider, (counts.get(row.provider) ?? 0) + 1);
  return [...counts.entries()].map(([provider, count]) => ({ provider, count }));
};

export const filterCursorGuideRows = (rows: readonly CursorGuideModelRow[], query: string, provider: string | null) => {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) =>
    (provider === null || row.provider === provider) &&
    (!needle || row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle))
  );
};
