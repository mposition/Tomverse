import type { AiModel } from "@/lib/models";

/**
 * The rows the explicit list offers: the live catalogue, then every stored id
 * the catalogue no longer offers.
 *
 * The catalogue rather than the static bootstrap list, because the server
 * resolves a published id against the catalogue. The static list still offered
 * `claude-sonnet-5` after production retired it for `claude-sonnet-5-5`, so
 * a stored `claude-sonnet-5-5` had no checkbox and could not be unticked
 * (2026-11-03). A stored id is always shown, so what the screen saves is what
 * it shows.
 */
export function modelSelectorOptions(
    catalog: {
        publicModels: readonly Pick<AiModel, "id" | "name">[];
        getModel: (modelId: string) => Pick<AiModel, "name"> | undefined;
    },
    selected: readonly string[]
): { id: string; name: string; unavailable: boolean }[] {
    const offered = catalog.publicModels.map((model) => ({
        id: model.id,
        name: model.name,
        unavailable: false,
    }));
    const offeredIds = new Set(offered.map((model) => model.id));
    const stored = selected
        .filter((id) => !offeredIds.has(id))
        .map((id) => ({
            id,
            name: catalog.getModel(id)?.name ?? id,
            unavailable: true,
        }));
    return [...offered, ...stored];
}
