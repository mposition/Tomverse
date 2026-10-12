import {
  canUseModelWithPlan,
  DEFAULT_MODEL_ID,
  getModel,
  getModelUsageProfile,
  isEnabledModelId,
  type AiModel,
} from "@/lib/models";

// Kept in step with DEFAULT_MODEL_ID so a guest's leading model is the same
// model a signed-in account gets by default. It was gemini-2-5-flash while
// the app default was gpt-5-4-mini; both moved to gpt-5-6-luna on 2026-08-01,
// and to gpt-6-luna on 2026-10-12.
// Operational deployments may still hold an older guestDefaultModelId in
// AppSetting -- prisma/migrations/20260801200000_default_model_gpt_5_6_luna
// and 20261012090000_default_model_gpt_6_luna realign that exact key rather
// than relying on this constant alone.
const GUEST_DEFAULT_MODEL_ID = "gpt-6-luna";

// The three most recognizable frontier brands, shown for every guest so
// their first chat immediately demonstrates Tomverse's core comparison
// value. This trio is always guaranteed regardless of the admin-configured
// guestDefaultModelId (AppSetting) below — that setting only controls which
// of these three leads (see getGuestDefaultSelectedModels); it has no effect
// if it names a model outside the trio.
//
// The OpenAI slot moved from gpt-5-4-mini to gpt-5-6-luna with the default
// switch. Both are Guest-tier Standard models at 1 credit, so the trio still
// costs a guest exactly 3 credits per comparison.
//
// The Gemini slot moved from gemini-2-5-flash to gemini-flash-lite-latest on
// 2026-09-28. The old id stays in the catalogue; this only changes which
// Google model a new guest comparison opens with.
//
// On 2026-10-12 the OpenAI slot moved to gpt-6-luna with the default switch,
// and the Anthropic slot from claude-haiku-4-5 to claude-haiku-5-5 --
// production had already disabled Haiku 4.5 with 5.5 as its replacement, so
// that slot was being backfilled from the fallback list. All three are still
// Guest-tier Standard models at 1 credit: a comparison still costs a guest
// exactly 3 credits. The lead is gpt-6-luna unless an administrator reorders
// the trio.
export const GUEST_BRAND_TRIO_MODEL_IDS = ["gpt-6-luna", "claude-haiku-5-5", "gemini-flash-lite-latest"];

// Backstops used only if one of the brand trio above is itself disabled or
// ineligible, so the guest default still comes out to 3 distinct models
// instead of silently collapsing via Set dedup.
export const GUEST_FALLBACK_MODEL_IDS = ["deepseek-v4-flash", "mistral-small-4", "qwen3.6-flash"];

/** Resolves a model id against whichever catalogue the caller is holding. */
export type ModelLookup = (modelId: string) => AiModel | undefined;

// The single definition of "a guest may select this model". Parameterised by
// the catalogue lookup so the static import-time catalogue (below) and the
// runtime, DB-backed one (components/ModelCatalogProvider) apply exactly the
// same rule -- the guest default must never come out differently depending
// on which catalogue happened to answer.
export const createGuestEligibilityCheck =
  (lookup: ModelLookup) => (modelId: string) => {
    const model = lookup(modelId);
    return Boolean(
      model?.enabled &&
        !model.catalogDeleted &&
        canUseModelWithPlan("Guest", model) &&
        getModelUsageProfile(model).category === "Standard"
    );
  };

/** The same bound as lib/models.ts `resolveSelectableModelId`. */
const REPLACEMENT_CHAIN_MAX_HOPS = 8;

/**
 * Whether a model may be a default-lineup member or a member's successor:
 * exactly what lib/models.ts `resolveSelectableModelId` calls selectable --
 * enabled, status "enabled", listed, not deleted. The chat client's clamp maps
 * every default through that function, so a laxer rule here (a "limited"
 * model, say) would let a model lead for guests and then be dropped from a new
 * account's first comparison. Save-time lineup validation uses it too.
 */
export const isDefaultLineupServable = (
  model: Pick<AiModel, "enabled" | "status" | "publiclyListed" | "catalogDeleted">
) =>
  model.enabled &&
  model.status === "enabled" &&
  model.publiclyListed !== false &&
  !model.catalogDeleted;

/**
 * `isEligible` narrowed to what a default may name (isDefaultLineupServable).
 * `isEligible` is the caller's own plan rule: the guest check everywhere,
 * except a new account's first comparison, which checks "Free".
 * Every place that computes a default selection -- the guest default, a new
 * account's first comparison, the lead facts, the console and
 * check:default-models -- passes this as the resolver's `isEligible`, so a
 * lineup member that is later limited or unlisted is succeeded in its slot
 * rather than kept for guests and dropped by a new account's clamp. A guest's
 * own selection keeps the plain guest check: a limited model is still
 * runnable when someone picks it.
 */
export const createDefaultLineupEligibilityCheck =
  (lookup: ModelLookup, isEligible: (modelId: string) => boolean) =>
  (modelId: string) => {
    const model = lookup(modelId);
    return Boolean(model && isDefaultLineupServable(model) && isEligible(modelId));
  };

/**
 * Who takes a retired model's default slot. `accept` is the caller's own rule
 * for the slot -- the guest resolver passes its `isEligible`.
 */
export type ReplacementResolver = (
  modelId: string,
  accept?: (modelId: string) => boolean
) => string | undefined;

/**
 * Where a default slot goes when its model is retired: along the model's
 * bounded, cycle-safe `replacementModelId` chain, against the same catalogue
 * the caller holds, to the first model that is publicly selectable *and*
 * passes `accept`. A hop that is servable but fails `accept` (a Pro-only
 * successor, say) is walked past rather than ending the search, so a later
 * guest-qualified hop still keeps the slot. Undefined when the chain ends
 * without one.
 *
 * An administrator retires a model by disabling it with a replacement. Before
 * this, the guest trio ignored that and backfilled the slot from
 * GUEST_FALLBACK_MODEL_IDS until a code change named the successor -- which is
 * how claude-haiku-4-5's slot showed a DeepSeek model in production.
 */
export const createReplacementResolver =
  (lookup: ModelLookup): ReplacementResolver =>
  (modelId, accept = () => true) => {
    const visited = new Set<string>([modelId]);
    let candidateId = lookup(modelId)?.replacementModelId;
    for (let hop = 0; candidateId && hop < REPLACEMENT_CHAIN_MAX_HOPS; hop += 1) {
      if (visited.has(candidateId)) return undefined;
      visited.add(candidateId);
      const model = lookup(candidateId);
      if (!model) return undefined;
      if (isDefaultLineupServable(model) && accept(candidateId)) return candidateId;
      candidateId = model.replacementModelId;
    }
    return undefined;
  };

const isGuestEligibleModel = createGuestEligibilityCheck(getModel);
const resolveStaticReplacement = createReplacementResolver(getModel);

if (!isEnabledModelId(GUEST_DEFAULT_MODEL_ID) || !isGuestEligibleModel(GUEST_DEFAULT_MODEL_ID)) {
  throw new Error("Guest default model must be an enabled guest-accessible Standard model.");
}

for (const modelId of GUEST_BRAND_TRIO_MODEL_IDS) {
  if (!isEnabledModelId(modelId) || !isGuestEligibleModel(modelId)) {
    throw new Error(`Guest brand-trio model must be an enabled guest-accessible Standard model: ${modelId}`);
  }
}

for (const modelId of GUEST_FALLBACK_MODEL_IDS) {
  if (!isEnabledModelId(modelId) || !isGuestEligibleModel(modelId)) {
    throw new Error(`Guest fallback model must be an enabled guest-accessible Standard model: ${modelId}`);
  }
}

export const APP_DEFAULTS = {
  defaultModelId: DEFAULT_MODEL_ID,
  guestDefaultModelId: GUEST_DEFAULT_MODEL_ID,
  defaultTheme: "dark",
  defaultLanguage: "en",

  maxSelectedModels: 3,
  maxGuestSelectedModels: 3,
  // The guest daily and monthly credit allowances, raised from 20/100 on
  // 2026-09-29 alongside search-on-by-default: a searching three-model
  // comparison reserves 3 + 8 x 3 = 27 credits, so the old 20 refused a
  // guest's very first turn. `lib/chatSecurity.ts` enforces these as its
  // defaults (`CHAT_GUEST_PER_DAY` / `CHAT_GUEST_PER_MONTH` still override).
  maxGuestMessages: 50,
  maxGuestMonthlyCredits: 300,

  // The mode a *new* conversation starts in, for guests and signed-in
  // accounts alike: search on, for answer quality (approved 2026-09-29).
  // Only a starting position -- the switch stays one click away, a stored
  // conversation keeps its own mode, and a stored "auto" or an unreadable
  // value still reads as off (see `normalizeWebSearchMode`).
  defaultWebSearchMode: "always",
} as const;

// Per-conversation, not per-message -- see components/chat/ChatInput.tsx's
// tools sheet.
//
// The *stored* vocabulary still has three members; the *offered* one has two.
// "auto" is a retired state: it used to mean "offer a search before running
// one", and the composer's binary switch no longer has a position that means
// that. It stays in the enum because rows and request bodies written before
// the switch existed still carry the string, and rejecting it would turn old
// conversations into errors rather than into a decided state.
export const WEB_SEARCH_MODES = ["off", "auto", "always"] as const;
export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number];
export const isWebSearchMode = (value: unknown): value is WebSearchMode =>
  typeof value === "string" && (WEB_SEARCH_MODES as readonly string[]).includes(value);

/** The two states the switch can be in -- what a user can actually choose. */
export const WEB_SEARCH_TOGGLE_MODES = ["off", "always"] as const;
export type WebSearchToggleMode = (typeof WEB_SEARCH_TOGGLE_MODES)[number];

/**
 * What a stored value means now that the choice is binary.
 *
 * Read-time only: nothing rewrites the row, so a conversation saved as "auto"
 * keeps saying "auto" in the database until its owner touches the switch.
 *
 * "always" is the only value that survives, and that asymmetry is the point.
 * "always" was already an unconditional instruction to search, so reading it
 * as on takes nothing back. "auto" was the opposite -- the account had asked
 * to be *asked* -- so reading it as on would turn a request for confirmation
 * into standing permission to search and to spend the surcharge, which is
 * consent nobody gave. Off is the safe reading, and turning the switch on is
 * one click away.
 */
export const normalizeWebSearchMode = (value: unknown): WebSearchToggleMode =>
  value === "always" ? "always" : "off";

/** Whether the switch renders as checked. */
export const isWebSearchEnabled = (value: unknown): boolean =>
  normalizeWebSearchMode(value) === "always";

/** The mode a switch in the given position writes back. */
export const webSearchModeForToggle = (enabled: boolean): WebSearchToggleMode =>
  enabled ? "always" : "off";

export const getDefaultSelectedModels = () => [APP_DEFAULTS.defaultModelId];

export const clampSelectedModels = (models: string[]) =>
  Array.from(new Set(models))
    .filter(isEnabledModelId)
    .slice(0, APP_DEFAULTS.maxSelectedModels);

export const clampGuestSelectedModels = (models: string[]) =>
  clampSelectedModels(models).filter(
    isGuestEligibleModel
  ).slice(0, APP_DEFAULTS.maxGuestSelectedModels);

// THE guest default selection. Always includes the GPT/Claude/Gemini brand
// trio, backfilling from GUEST_FALLBACK_MODEL_IDS if one of them is
// ineligible so the default is still 3 distinct models. leadModelId (the
// admin-configured guestDefaultModelId) only reorders which of the three
// appears first, and is ignored if it names a model outside the trio.
//
// An ineligible trio member first tries its replacement (`resolveReplacement`,
// see createReplacementResolver): a retired model's successor keeps the
// retired model's slot -- and its place in the order, so a retired lead is
// succeeded as the lead -- provided the successor passes the same `isEligible`
// rule. Only when it does not, or is already selected, does the slot fall to
// the fallback list. Omitting `resolveReplacement` keeps the old behaviour.
//
// `trio` is the effective lineup: the administrator's
// AppSetting["guestBrandTrioModelIds"] when it is stored and valid, otherwise
// the compiled GUEST_BRAND_TRIO_MODEL_IDS (lib/appSettings resolves which and
// serves it with the public settings). Omitting it means the compiled trio.
//
// Deliberately pure and catalogue-injected: the server
// (app/(site)/(application)/chat/page.tsx via lib/appSettings) and the client's
// very first render (app/(site)/(application)/chat/ChatPageClient.tsx) both
// call this, so the guest model count -- and therefore the estimated credits
// derived from it -- is identical before and after hydration (STG-F006).
export const resolveGuestDefaultSelectedModels = ({
  isEligible,
  leadModelId = APP_DEFAULTS.guestDefaultModelId,
  maxModels = APP_DEFAULTS.maxGuestSelectedModels,
  resolveReplacement,
  trio: lineup = GUEST_BRAND_TRIO_MODEL_IDS,
}: {
  isEligible: (modelId: string) => boolean;
  leadModelId?: string;
  maxModels?: number;
  resolveReplacement?: ReplacementResolver;
  trio?: readonly string[];
}) => {
  const orderedTrio = lineup.includes(leadModelId)
    ? [leadModelId, ...lineup.filter((id) => id !== leadModelId)]
    : lineup;
  const slots = orderedTrio.map((modelId) =>
    isEligible(modelId) ? modelId : (resolveReplacement?.(modelId, isEligible) ?? modelId)
  );

  const trio: string[] = [];
  for (const modelId of [...slots, ...GUEST_FALLBACK_MODEL_IDS]) {
    if (trio.includes(modelId) || !isEligible(modelId)) continue;
    trio.push(modelId);
    if (trio.length >= maxModels) break;
  }
  return trio;
};

/**
 * Why a model may not be stored as `AppSetting["guestDefaultModelId"]`, or
 * `null` when it may. Pure, so the rule can be checked without a database.
 *
 * The last clause is the one that matters and the one that used to be
 * missing. This setting does exactly one thing -- reorder the brand trio --
 * so a model outside the trio is dropped by `resolveGuestDefaultSelectedModels`
 * above. Storing one succeeded, read back, and served through
 * `/api/app-settings` while changing nothing a guest ever saw: an
 * administrator had no way to tell a setting that works from a setting that
 * silently does not. `trio` is the effective lineup the lead is checked
 * against; changing the lineup itself is `guestBrandTrioRejection` below.
 */
export const guestDefaultLeadRejection = ({
  modelId,
  exists,
  guestEligible,
  usageCategory,
  trio = GUEST_BRAND_TRIO_MODEL_IDS,
}: {
  modelId: string;
  exists: boolean;
  guestEligible: boolean;
  usageCategory: string | null;
  trio?: readonly string[];
}): string | null => {
  if (!exists) return `"${modelId}" is not an enabled model.`;
  if (!guestEligible) return `"${modelId}" is not available to guests.`;
  if (usageCategory !== "Standard") {
    return `"${modelId}" is priced as ${usageCategory ?? "unknown"}, not Standard, so a guest could not pay for it.`;
  }
  if (!trio.includes(modelId)) {
    return (
      `"${modelId}" is not one of the guest brand trio (${trio.join(", ")}), ` +
      "so it would be stored but never applied: this setting only chooses which of those three leads."
    );
  }
  return null;
};

/**
 * The lead the chat client is handed for a lineup.
 *
 * A stored lead that is a member of the lineup passes through even when that
 * model is retired: the resolver then succeeds it in its own slot, which keeps
 * it the lead -- what readGuestLeadFacts reports and the console shows.
 * Swapping it for the compiled default before the resolver runs is how a
 * retired lead used to lose its place. Anything outside the lineup is not a
 * lead and gives way to the compiled default. lib/appSettings serves this;
 * check:default-models audits with it.
 */
export const guestLeadForLineup = (
  stored: string | null | undefined,
  lineup: readonly string[]
): string =>
  stored && lineup.includes(stored) ? stored : APP_DEFAULTS.guestDefaultModelId;

/**
 * The model a stored lead should put first: the stored id itself, or -- when
 * it is a lineup member that is no longer eligible -- the successor the
 * resolver puts in its slot. A stored lead is applied when the guest
 * selection leads with this; the console and check:default-models both judge
 * it this way, so a retired lead that was succeeded does not read as ignored.
 */
export const expectedLeadForStored = ({
  stored,
  lineup,
  isEligible,
  resolveReplacement,
}: {
  stored: string;
  lineup: readonly string[];
  isEligible: (modelId: string) => boolean;
  resolveReplacement?: ReplacementResolver;
}): string =>
  lineup.includes(stored) && !isEligible(stored)
    ? (resolveReplacement?.(stored, isEligible) ?? stored)
    : stored;

/**
 * Reads a stored AppSetting["guestBrandTrioModelIds"]: a JSON array of exactly
 * APP_DEFAULTS.maxGuestSelectedModels distinct ids. Anything else -- including
 * a missing row -- is `null`, which every reader treats as "use the compiled
 * trio". Pure; whether each id is still servable is the caller's catalogue
 * check, because a model can be retired after the lineup was saved.
 */
export const parseGuestBrandTrio = (value: unknown): string[] | null => {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  const ids = parsed.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (ids.length !== APP_DEFAULTS.maxGuestSelectedModels) return null;
  if (ids.some((id) => id.length === 0 || id.length > 120)) return null;
  if (new Set(ids).size !== ids.length) return null;
  return ids;
};

/**
 * The providers a default lineup holds, one model each. Platform strategy,
 * operator decision 2026-10-12: a guest always gets one OpenAI, one Anthropic
 * and one Gemini model (docs/policy/credit-and-cost-limits.md).
 */
export const GUEST_LINEUP_PROVIDERS = ["openai", "anthropic", "google"] as const;

/**
 * Which provider each editor slot offers, given the saved lineup's providers
 * in slot order.
 *
 * A slot keeps its model's provider when that provider is one of
 * GUEST_LINEUP_PROVIDERS and no other slot holds it. Every other slot -- a
 * duplicate, a provider outside the rule, an unknown model -- is handed one of
 * the providers the lineup is missing, in GUEST_LINEUP_PROVIDERS order. So a
 * lineup that breaks the rule can still be repaired in the editor rather than
 * locked to the providers that break it.
 */
export const lineupSlotProviders = (
  providers: readonly (string | null | undefined)[]
): string[] => {
  const allowed: readonly string[] = GUEST_LINEUP_PROVIDERS;
  const kept = providers.map((provider) =>
    provider &&
    allowed.includes(provider) &&
    providers.filter((candidate) => candidate === provider).length === 1
      ? provider
      : null
  );
  const missing = allowed.filter((provider) => !kept.includes(provider));
  return kept.map((provider) => provider ?? missing.shift() ?? "");
};

/** The GUEST_LINEUP_PROVIDERS these providers do not hold exactly once: missing or doubled. */
export const missingLineupProviders = (
  providers: readonly (string | null | undefined)[]
): string[] =>
  GUEST_LINEUP_PROVIDERS.filter(
    (provider) => providers.filter((candidate) => candidate === provider).length !== 1
  );

/** Whether these providers are exactly one of each of GUEST_LINEUP_PROVIDERS. */
export const isOnePerLineupProvider = (providers: readonly (string | null | undefined)[]) =>
  providers.length === GUEST_LINEUP_PROVIDERS.length &&
  missingLineupProviders(providers).length === 0;

/** What a lineup check needs to know about one model, from the runtime catalogue. */
export type GuestBrandTrioCandidateFacts = {
  /** Enabled, publicly listed, not disabled or coming soon, not deleted. */
  exists: boolean;
  guestEligible: boolean;
  usageCategory: string | null;
  /** Every rate resolves to a verified profile or an administrator's override -- none to the class fallback. */
  priced: boolean;
  provider: string | null;
};

/**
 * Why a lineup may not be stored as AppSetting["guestBrandTrioModelIds"], or
 * `null` when it may. Pure; `facts` comes from the runtime catalogue.
 *
 * Every member must be something the guest screen would actually show -- the
 * same rule as a lead (enabled, guest plan, Standard) -- so a saved lineup is
 * never a setting that stores and then silently backfills. And its price must
 * not be the conservative class fallback: the composer quotes credits from
 * the model and the provider budget reserves from its price, so a default
 * every new conversation opens on must have a price someone verified.
 */
export const guestBrandTrioRejection = ({
  modelIds,
  facts,
}: {
  modelIds: readonly string[];
  facts: (modelId: string) => GuestBrandTrioCandidateFacts;
}): string | null => {
  const expected = APP_DEFAULTS.maxGuestSelectedModels;
  if (modelIds.length !== expected) {
    return `The default lineup needs exactly ${expected} models.`;
  }
  if (new Set(modelIds).size !== modelIds.length) {
    return "The default lineup names the same model twice.";
  }
  for (const modelId of modelIds) {
    const fact = facts(modelId);
    if (!fact.exists) return `"${modelId}" is not an enabled model.`;
    if (!fact.guestEligible) return `"${modelId}" is not available to guests.`;
    if (fact.usageCategory !== "Standard") {
      return `"${modelId}" is priced as ${fact.usageCategory ?? "unknown"}, not Standard, so a guest could not pay for it.`;
    }
    if (!fact.priced) {
      return `"${modelId}" has no verified price yet (it would be costed at the conservative fallback).`;
    }
  }
  const providers = modelIds.map((modelId) => facts(modelId).provider ?? "unknown");
  if (!isOnePerLineupProvider(providers)) {
    return `The default lineup must hold one OpenAI, one Anthropic and one Gemini model; this one is ${providers.join(", ")}.`;
  }
  return null;
};

export const getGuestDefaultSelectedModels = (
  leadModelId: string = APP_DEFAULTS.guestDefaultModelId
) =>
  clampGuestSelectedModels(
    resolveGuestDefaultSelectedModels({
      isEligible: createDefaultLineupEligibilityCheck(getModel, isGuestEligibleModel),
      leadModelId,
      resolveReplacement: resolveStaticReplacement,
    })
  );
