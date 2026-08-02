import type { AiModel } from "@/lib/models";

/**
 * The public shape of a catalogue model.
 *
 * Built as an explicit allowlist, not by deleting fields off the registry
 * object. The route used to do the latter -- `{...model}` then three
 * `delete`s -- which meant every field added to AiModel or to
 * ModelRegistryEntry afterwards became public by default, and nobody adding
 * one had any reason to look at this endpoint. That is how
 * `inputUsdPerMillionTokens`, `outputUsdPerMillionTokens`,
 * `cachedInputPriceMultiplier` and `reservationOutputTokens` ended up served
 * unauthenticated for all 41 models: Tomverse's own cost basis, published
 * from a route whose blacklist predated those fields existing.
 *
 * `docs/policy/credit-and-cost-limits.md` is explicit that raw internal USD
 * never reaches a user-facing response. Credits are the user-facing unit, so
 * `creditWeight` is what the UI needs and gets.
 *
 * The endpoint stays unauthenticated on purpose. Guests choose models before
 * signing in, and a shared conversation is read by people with no account at
 * all -- both need to resolve a model id to a name and icon. Minimising the
 * body is what makes that safe; adding a session check would break those two
 * surfaces without fixing the disclosure for signed-in users, who are not
 * the ones who should see a cost basis either.
 *
 * Administrators get the complete registry row -- pricing, reservation
 * sizing, endpoint configuration and `operationalReason` -- from
 * `/api/admin/models`, behind the admin session. One endpoint returning
 * different schemas depending on who asks is worse than two endpoints with
 * one schema each.
 */
export type PublicCatalogModel = {
    id: string;
    name: string;
    provider: string;
    icon: string;
    bestFor: string;
    minimumPlan: AiModel["minimumPlan"];
    usageClass: AiModel["usageClass"];
    /** The user-facing price unit. Never the USD rates behind it. */
    creditWeight?: number;
    /**
     * Lifecycle, carried in full because the client is what filters on it:
     * ModelCatalogProvider keeps every row so a stored conversation can still
     * resolve a retired id to a name, and derives the picker's list with
     * isPubliclySelectableModel.
     */
    publiclyListed?: boolean;
    enabled: boolean;
    status: AiModel["status"];
    catalogDeleted?: boolean;
    replacementModelId?: string;
    /** Deliberately included; `operationalReason` deliberately is not. */
    userVisibleNote?: string;
    reasoning?: AiModel["reasoning"];
    contextWindowTokens?: number;
    inputCapabilities?: AiModel["inputCapabilities"];
};

/**
 * Fields that must never appear in the public body, named so a test can
 * assert their absence by name rather than by re-listing the allowlist.
 *
 * `apiModel` is here for a different reason than the rest: it is not a
 * secret -- providers publish their model ids -- but no client reads it, and
 * the mapping from a Tomverse id to the exact upstream string is operational
 * detail with no user-facing purpose.
 */
export const NON_PUBLIC_MODEL_FIELDS = [
    "apiModel",
    "apiBaseUrl",
    "apiKeyEnvName",
    "operationalReason",
    "inputUsdPerMillionTokens",
    "outputUsdPerMillionTokens",
    "cachedInputPriceMultiplier",
    "maxOutputTokens",
    "reservationOutputTokens",
    "sortOrder",
] as const;

/**
 * Ordering is preserved by the array itself -- getRuntimeModels sorts by
 * sortOrder -- so dropping the field costs the client nothing.
 *
 * Optional fields are omitted rather than sent as undefined, so the JSON body
 * carries only what a model actually has.
 */
export const toPublicCatalogModel = (model: AiModel): PublicCatalogModel => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    icon: model.icon,
    bestFor: model.bestFor,
    minimumPlan: model.minimumPlan,
    usageClass: model.usageClass,
    enabled: model.enabled,
    status: model.status,
    ...(model.creditWeight !== undefined ? { creditWeight: model.creditWeight } : {}),
    ...(model.publiclyListed !== undefined
        ? { publiclyListed: model.publiclyListed }
        : {}),
    ...(model.catalogDeleted !== undefined
        ? { catalogDeleted: model.catalogDeleted }
        : {}),
    ...(model.replacementModelId
        ? { replacementModelId: model.replacementModelId }
        : {}),
    ...(model.userVisibleNote ? { userVisibleNote: model.userVisibleNote } : {}),
    ...(model.reasoning ? { reasoning: model.reasoning } : {}),
    ...(model.contextWindowTokens
        ? { contextWindowTokens: model.contextWindowTokens }
        : {}),
    ...(model.inputCapabilities
        ? { inputCapabilities: model.inputCapabilities }
        : {}),
});
