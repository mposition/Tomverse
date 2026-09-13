"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Archive,
  CheckCircle2,
  Copy,
  Database,
  FilterX,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { adminIntlLocale } from "@/lib/adminLocale";
import { adminModelRegistryMessages } from "@/lib/adminMessages/modelRegistry";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { blankTokenFieldValues, isCreditFloor, suggestCreditFloor } from "@/lib/modelAdoptionDraft";
import { PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER } from "@/lib/modelPricing";
import type { AiModel, AiProvider, ModelMinimumPlan, ModelStatus, ModelUsageClass } from "@/lib/models";
import {
  DEFAULT_MODEL_LIFECYCLE_FILTER,
  MODEL_LIFECYCLE_FILTERS,
  countModelsInLifecycleView,
  filterRegistryModels,
  modelLifecycleState,
  normalizeModelLifecycleFilter,
  type ModelLifecycleFilter,
} from "@/lib/adminModelRegistryFilters";
import { AI_PROVIDERS, PROVIDER_API_CONFIGURATION } from "@/lib/modelRegistryShared";
import { ModelLogo } from "@/components/chat/ModelLogo";

type EnvironmentStatus = {
  compatible: boolean;
  protocol: "native" | "openai-compatible";
  apiKeyEnvName: string;
  apiKeyConfigured: boolean;
  warnings: string[];
};

type AdminModel = AiModel & { environment: EnvironmentStatus };

type RegistrySecurityFinding = {
  id: string;
  provider: string;
  issue: "unsupported_provider" | "api_base_url_mismatch" | "api_key_env_mismatch";
  configuredValue: string;
  expectedValue: string | null;
};

type FormState = {
  id: string;
  name: string;
  apiModel: string;
  provider: AiProvider;
  icon: string;
  bestFor: string;
  minimumPlan: ModelMinimumPlan;
  usageClass: ModelUsageClass;
  creditWeight: number;
  publiclyListed: boolean;
  status: ModelStatus;
  operationalReason: string;
  userVisibleNote: string;
  replacementModelId: string;
  reasoning: "none" | "low" | "medium" | "high";
  contextWindowTokens: number | null;
  supportsImage: boolean;
  supportsNativePdf: boolean;
  maxImages: number | null;
  maxBase64ImagePayloadBytes: number | null;
  maxOutputTokens: number | null;
  reservationOutputTokens: number | null;
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  cachedInputPriceMultiplier: number | null;
  sortOrder: number;
};

const emptyForm = (): FormState => ({
  id: "",
  name: "",
  apiModel: "",
  provider: "openai",
  icon: "",
  bestFor: "",
  minimumPlan: "Guest",
  usageClass: "standard",
  creditWeight: 1,
  publiclyListed: true,
  status: "disabled",
  operationalReason: "",
  userVisibleNote: "",
  replacementModelId: "",
  reasoning: "none",
  contextWindowTokens: null,
  supportsImage: false,
  supportsNativePdf: false,
  maxImages: null,
  maxBase64ImagePayloadBytes: null,
  maxOutputTokens: 2048,
  reservationOutputTokens: 1024,
  inputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 0,
  cachedInputPriceMultiplier: 1,
  sortOrder: 0,
});

const formFromModel = (model: AdminModel): FormState => ({
  id: model.id,
  name: model.name,
  apiModel: model.apiModel,
  provider: model.provider,
  icon: model.icon,
  bestFor: model.bestFor,
  minimumPlan: model.minimumPlan,
  usageClass: model.usageClass,
  creditWeight: model.creditWeight || 1,
  publiclyListed: model.publiclyListed !== false,
  status: model.status,
  operationalReason: model.operationalReason || "",
  userVisibleNote: model.userVisibleNote || "",
  replacementModelId: model.replacementModelId || "",
  reasoning: model.reasoning || "none",
  contextWindowTokens: model.contextWindowTokens || null,
  supportsImage: model.inputCapabilities?.image === true,
  supportsNativePdf: model.inputCapabilities?.nativePdf === true,
  maxImages: model.inputCapabilities?.maxImages || null,
  maxBase64ImagePayloadBytes: model.inputCapabilities?.maxBase64ImagePayloadBytes || null,
  maxOutputTokens: model.maxOutputTokens || null,
  reservationOutputTokens: model.reservationOutputTokens || null,
  inputUsdPerMillionTokens: model.inputUsdPerMillionTokens ?? null,
  outputUsdPerMillionTokens: model.outputUsdPerMillionTokens ?? null,
  cachedInputPriceMultiplier: model.cachedInputPriceMultiplier ?? null,
  sortOrder: model.sortOrder || 0,
});

const inputClass =
  "w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10";
const labelClass = "grid gap-1.5 text-xs font-bold uppercase tracking-[0.12em] text-zinc-400";

const numericValue = (value: string) => (value === "" ? null : Number(value));

/**
 * The adoption draft endpoint, named rather than spelled inline.
 *
 * Both callers build their query with `URLSearchParams`, which encodes each
 * value and keeps the `?` next to a `$` -- the encoding check reads a lone `?`
 * between letters as a character that used to be something else, and
 * `adoption-draft?workItemId` is long enough that the nearest `/` or `=` falls
 * outside the window it looks in.
 */
const ADOPTION_DRAFT_PATH = "/api/admin/model-lifecycle/adoption-draft";

/**
 * The prefilled fields that depend on the registry id through its pricing
 * profile: the output cap, and the three price columns. Each is copied only
 * when no profile covers the id, and each would override a profile if it
 * stayed once the id became one that has one.
 */
const DRAFT_FOLLOWED_FIELDS = [
  "maxOutputTokens",
  "inputUsdPerMillionTokens",
  "outputUsdPerMillionTokens",
  "cachedInputPriceMultiplier",
  // Provider-dependent too: read from one pair's observation and evidence. A
  // context window or an image flag copied for one provider pair is not a fact
  // about another.
  "contextWindowTokens",
  "supportsImage",
  "supportsNativePdf",
  "reasoning",
] as const;
type DraftFollowedField = (typeof DRAFT_FOLLOWED_FIELDS)[number];

/** The three price columns: confirmed together, because they are read from one price table. */
const PRICE_FIELDS = ["inputUsdPerMillionTokens", "outputUsdPerMillionTokens", "cachedInputPriceMultiplier"] as const;
const priceFieldsTouched = (touched: ReadonlySet<string>) =>
  PRICE_FIELDS.some((field) => touched.has(field));

/** What a followed field holds when no pair has proposed anything for it. */
const DRAFT_FIELD_BLANK: { [Field in DraftFollowedField]: FormState[Field] } = {
  maxOutputTokens: null,
  inputUsdPerMillionTokens: null,
  outputUsdPerMillionTokens: null,
  cachedInputPriceMultiplier: null,
  contextWindowTokens: null,
  supportsImage: false,
  supportsNativePdf: false,
  reasoning: "none",
};

/** The provider-dependent half of the key: which model, regardless of the id it is saved under. */
const adoptionPairKey = (provider: string | undefined, apiModel: string | undefined) =>
  JSON.stringify([provider ?? "", (apiModel ?? "").trim()]);

/** One lookup's identity: the trimmed registry id and the exact provider pair. */
const adoptionLookupKey = (
  id: string | undefined,
  provider: string | undefined,
  apiModel: string | undefined
) => JSON.stringify([(id ?? "").trim(), provider ?? "", (apiModel ?? "").trim()]);

const duplicateRegistryId = (sourceId: string, models: AdminModel[]) => {
  const base = `${sourceId}-copy`;
  const existing = new Set(models.map((model) => model.id));
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
};

export function AdminModelRegistryPanel() {
  const m = useAdminMessages(adminModelRegistryMessages);
  const { locale } = useAdminLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedProvider = searchParams.get("provider");
  const [models, setModels] = useState<AdminModel[]>([]);
  const [securityFindings, setSecurityFindings] = useState<RegistrySecurityFinding[]>([]);
  const [query, setQuery] = useState(() => searchParams.get("q") || "");
  const [provider, setProvider] = useState<"all" | AiProvider>(() =>
    requestedProvider && AI_PROVIDERS.includes(requestedProvider as AiProvider)
      ? (requestedProvider as AiProvider)
      : "all"
  );
  // An unknown or stale ?lifecycle= value fails safe to the default view
  // rather than erroring or rendering an empty registry.
  const [lifecycle, setLifecycle] = useState<ModelLifecycleFilter>(() =>
    normalizeModelLifecycleFilter(searchParams.get("lifecycle"))
  );
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [copySourceId, setCopySourceId] = useState<string | null>(null);
  // The discovery queue item this form is answering, from `?adopt=`. Held in
  // state rather than read on each render because the save has to name it, and
  // the parameter is dropped from the URL once the draft is in hand so a
  // refresh cannot reopen a form for a model that has since been created.
  const [adoptWorkItemId, setAdoptWorkItemId] = useState<string | null>(null);
  const [adoptUnknowns, setAdoptUnknowns] = useState<string[]>([]);
  const [adoptNotes, setAdoptNotes] = useState<string[]>([]);
  // Set when the price re-resolution could not be reached. The panel then stops
  // being the gate: the save resolves the profile server-side anyway, and a
  // failed lookup must not be a locked screen with no way forward.
  // Which id a lookup failed for. Scoped to the id rather than a flag, because
  // a failure is a fact about one lookup: an operator who moves to an id that
  // failed and back to one already priced is looking at a known profile, and a
  // leftover flag would hide its hints and skip its floor check.
  const [profileLookupFailedForKey, setProfileLookupFailedForKey] = useState<string | null>(null);
  const [adoptReason, setAdoptReason] = useState("");
  // Whether the operator has actually chosen a sale class while adopting.
  // `usageClass` and `creditWeight` cannot hold "undecided" -- they are
  // non-nullable columns -- so an untouched form would save `standard` and 1,
  // a sale decision nobody made, under a banner calling it undecided.
  const [adoptClassChosen, setAdoptClassChosen] = useState(false);
  const [worstCaseInputTokens, setWorstCaseInputTokens] = useState<number | null>(null);
  // What this model bills at with its price columns left null, when a pricing
  // profile already covers it. Without it the floor reads empty price fields as
  // "no price" and the panel refuses a save the server would accept.
  const [profilePrice, setProfilePrice] = useState<{
    modelId: string;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    maxOutputTokens: number | null;
  } | null>(null);
  // A reasoning value the draft proposed rather than read, and whether the
  // operator has confirmed it. Gated like the sale class: a proposal the save
  // could skip would be the draft choosing how hard a model thinks.
  const [adoptReasoningSuggested, setAdoptReasoningSuggested] = useState(false);
  const [adoptReasoningConfirmed, setAdoptReasoningConfirmed] = useState(false);
  // Prices the draft copied from provider documentation, and whether the
  // operator has checked them against the source. Required before the save:
  // temporary pricing is only sometimes recognisable by its wording, and a
  // price nobody looked at becomes an override that bills every request.
  const [adoptPriceSuggested, setAdoptPriceSuggested] = useState(false);
  const [adoptPriceConfirmed, setAdoptPriceConfirmed] = useState(false);
  // What the two token columns resolve to when left empty, per sale class, for
  // one registry id. Shown greyed in the empty fields so an operator sees the
  // number a blank saves as -- a blank here is not "no limit", it is a policy
  // default, and an empty box read as nothing is how a model ships at 8,192.
  const [effectiveTokenLimits, setEffectiveTokenLimits] = useState<{
    modelId: string;
    byClass: Partial<Record<ModelUsageClass, { maxOutputTokens: number; reservationBeforeCap: number }>>;
  } | null>(null);
  // Which of the id-dependent prefilled fields the operator has typed in since
  // the draft arrived. An explicit record, set in each input's own handler,
  // rather than a comparison with the prefilled number: typing 64,000 and then
  // 128,000 again is the operator's value even though it equals the prefill,
  // and a comparison would hand it back to the draft. Set synchronously, so a
  // lookup answering between a keystroke and the next render cannot overwrite
  // it either.
  const touchedDraftFieldsRef = useRef(new Set<DraftFollowedField>());
  // The registry id those prefilled fields were proposed for. A copied cap and
  // a copied price are facts about one id -- written because *that* id has no
  // pricing profile -- so once the id moves they are no longer proposals for
  // anything and must not ride along into a save while the new id is still
  // being looked up, or after that lookup fails. On a profiled id each of them
  // would be a permanent override flattening the profile.
  const draftProposedForKeyRef = useRef<string | null>(null);
  // The (provider, api model) pair the form's provider-dependent values were
  // proposed for. Kept apart from the key because a pair change resets more
  // than an id change: even values the operator typed were typed about the
  // previous model, and a reasoning level confirmed for it is not confirmed
  // for this one.
  const draftPairRef = useRef<string | null>(null);
  // The lookup key the notes, unknowns and profile proposal on screen were
  // written for. Anything written for another key is hidden at once, not
  // after the debounce: a proposal for the model the operator just moved away
  // from is one click from being copied into a pull request.
  const [guidanceKey, setGuidanceKey] = useState<string | null>(null);
  // A lib/modelPricing.ts entry written from the provider's documentation, for
  // a model whose price the override columns cannot hold. Shown to copy into a
  // pull request; nothing in this panel applies it.
  const [pricingProfileProposal, setPricingProfileProposal] = useState<string | null>(null);
  // The last id a profile lookup settled for, success or failure. Until the id
  // in the form has settled, nothing about its profile is known: the save
  // waits, and the blank fields make no claim.
  const [lookupSettledForKey, setLookupSettledForKey] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validation, setValidation] = useState<EnvironmentStatus | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/models", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as {
        models?: AdminModel[];
        securityFindings?: RegistrySecurityFinding[];
        error?: string;
      } | null;
      if (!response.ok || !data?.models) throw new Error(data?.error || m.toast.loadFailed);
      setModels(data.models);
      setSecurityFindings(data.securityFindings || []);
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : m.toast.loadFailed, "error");
    } finally {
      setLoading(false);
    }
  }, [m]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  // `?adopt=<work item>` arrives from the discovery queue. The draft is the
  // scan's own answer to the fields it can answer -- identifier, display name,
  // context window, output ceiling, image input -- and the rest of the form
  // stays at its defaults with `unknowns` naming what a person still has to
  // decide. Nothing is saved here: this only opens the form somebody then
  // fills in and submits.
  const adoptParam = searchParams.get("adopt");
  useEffect(() => {
    if (!adoptParam) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `${ADOPTION_DRAFT_PATH}?${new URLSearchParams({ workItemId: adoptParam })}`,
          { cache: "no-store" }
        );
        const data = (await response.json().catch(() => null)) as {
          fields?: Partial<FormState>;
          unknowns?: string[];
          notes?: string[];
          suggestions?: { reasoning?: string | null; price?: boolean };
          pricingProfileProposal?: string | null;
          effectiveTokenLimits?: typeof effectiveTokenLimits;
          worstCaseInputTokens?: number;
          profilePrice?: {
            modelId: string;
            inputUsdPerMillionTokens: number;
            outputUsdPerMillionTokens: number;
            maxOutputTokens: number | null;
          } | null;
          error?: string;
        } | null;
        if (!response.ok || !data?.fields) {
          throw new Error(data?.error || m.toast.adoptionDraftFailed);
        }
        if (cancelled) return;
        setForm({ ...emptyForm(), ...data.fields });
        setAdoptUnknowns(data.unknowns || []);
        setAdoptNotes(data.notes || []);
        setProfileLookupFailedForKey(null);
        setAdoptWorkItemId(adoptParam);
        setAdoptReason("");
        setAdoptClassChosen(false);
        setAdoptReasoningSuggested(Boolean(data.suggestions?.reasoning));
        setAdoptPriceSuggested(Boolean(data.suggestions?.price));
        setAdoptPriceConfirmed(false);
        setPricingProfileProposal(data.pricingProfileProposal ?? null);
        setAdoptReasoningConfirmed(false);
        setEffectiveTokenLimits(data.effectiveTokenLimits ?? null);
        touchedDraftFieldsRef.current = new Set();
        {
          const loadedKey = adoptionLookupKey(data.fields.id, data.fields.provider, data.fields.apiModel);
          draftProposedForKeyRef.current = loadedKey;
          draftPairRef.current = adoptionPairKey(data.fields.provider, data.fields.apiModel);
          setGuidanceKey(loadedKey);
          setLookupSettledForKey(loadedKey);
        }
        setWorstCaseInputTokens(data.worstCaseInputTokens ?? null);
        setProfilePrice(data.profilePrice ?? null);
        setCopySourceId(null);
        setValidation(null);
        setEditingId("new");
      } catch (error) {
        if (cancelled) return;
        dispatchAppToast(
          error instanceof Error ? error.message : m.toast.adoptionDraftFailed,
          "error"
        );
      } finally {
        if (cancelled) return;
        // Dropped with replace, never a pushed entry: the browser's Back
        // button belongs to the operator, and a reload must not reopen a form
        // for a model that has since been created.
        const params = new URLSearchParams(searchParams.toString());
        params.delete("adopt");
        const suffix = params.toString();
        router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the parameter alone. Re-running when the router
    // objects change would refetch the draft and overwrite edits already typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adoptParam]);

  // Display only. `models` stays the complete registry, so editing,
  // duplicating, archiving and the replacement-model selector keep seeing
  // every row whatever the list is currently showing.
  const filtered = useMemo(
    () => filterRegistryModels(models, { lifecycle, provider, query }),
    [models, lifecycle, provider, query]
  );
  const hiddenByLifecycle = useMemo(
    () => models.length - countModelsInLifecycleView(models, lifecycle),
    [models, lifecycle]
  );
  const lifecycleLabels = m.lifecycle.labels;
  const hiddenNote =
    lifecycle === "all" || hiddenByLifecycle <= 0
      ? null
      : m.lifecycle.hiddenNote(hiddenByLifecycle, lifecycleLabels[lifecycle]);

  // Recomputed as the prices are typed, so the class an operator is about to
  // save is measured against the model's own cost before the save rather than
  // in a report afterwards. A floor, not a recommendation -- what Tomverse
  // charges sits at or above it and is nobody's arithmetic but a person's.
  // The inherited price belongs to one registry id. The id is editable, so a
  // price resolved for the proposed id must not keep standing in for a
  // different one -- the server resolves the profile from whatever id is saved,
  // and the two disagreeing is the floor the operator sees not being the floor
  // the save is judged by.
  // Trimmed, because the draft endpoint and the save schema both trim the id:
  // a profile resolved for "claude-x" is the profile for " claude-x ", and a
  // raw comparison left that form showing no price and a save that never
  // unlocked.
  const inheritedPrice = profilePrice?.modelId === form.id.trim() ? profilePrice : null;

  // ...and when the id moves, the price is resolved again for the new one.
  //
  // The proposed id is built from the provider's identifier, so a model whose
  // profile is registered under a canonical id -- `claude-haiku-4-5` for an api
  // model of `claude-haiku-4-5-20251001` -- only matches after the operator
  // corrects it. Keeping the first answer told them to type a price they were
  // actually inheriting, and refused to save the inheritance.
  const adoptedModelId = adoptWorkItemId ? form.id.trim() : null;
  // What the provider-dependent prefills are a fact about: the registry id
  // (through its pricing profile) *and* the exact provider and api model
  // (through the scan's observation and the documentation evidence). A price
  // read for one pair is not a price for another, so changing either half of
  // the pair is a new lookup exactly like changing the id.
  const lookupKey =
    adoptWorkItemId && adoptedModelId
      ? adoptionLookupKey(adoptedModelId, form.provider, form.apiModel)
      : null;
  const profileLookupFailed = Boolean(lookupKey) && profileLookupFailedForKey === lookupKey;
  useEffect(() => {
    if (!adoptWorkItemId || !adoptedModelId || !lookupKey) return;
    // Already answered for this key -- by the draft itself on load, or by an
    // earlier lookup. Asking again could only turn a known answer into a
    // failure. A failed key is asked again once, and so is one whose untouched
    // prefills were cleared by a detour: leaving A for B clears A's, and coming
    // back to A before B answers must bring them back, not skip on A's old answer.
    if (
      lookupSettledForKey === lookupKey &&
      profileLookupFailedForKey !== lookupKey &&
      (draftProposedForKeyRef.current === lookupKey ||
        DRAFT_FOLLOWED_FIELDS.every((field) => touchedDraftFieldsRef.current.has(field)))
    ) {
      return;
    }
    let cancelled = false;
    // Debounced: the id is typed, and a request per keystroke would be one per
    // character of a name the operator has not finished writing.
    const timer = setTimeout(() => {
      // Prefills for a different key stop being proposals now, not when the
      // answer arrives. If the lookup then fails, the save carries none of them:
      // the server accepts that for an id a profile covers and refuses it for
      // one that is not, and neither outcome is an override nobody chose.
      const requestedPair = adoptionPairKey(form.provider, form.apiModel);
      // A pair change already cleared everything in its own handler
      // (`startNewPair`), at the moment of the change -- so a value typed for
      // the new pair while this timer waited is the operator's and is kept.
      // What is left here is the id-only case.
      if (draftProposedForKeyRef.current !== lookupKey) {
        // Same model, corrected id. What the operator typed still describes
        // this model and stays; only the untouched prefills follow the id.
        draftProposedForKeyRef.current = null;
        const untouched = DRAFT_FOLLOWED_FIELDS.filter(
          (field) => !touchedDraftFieldsRef.current.has(field)
        );
        if (untouched.length) {
          setForm((current) => ({
            ...current,
            ...Object.fromEntries(untouched.map((field) => [field, DRAFT_FIELD_BLANK[field]])),
          }));
        }
        if (!touchedDraftFieldsRef.current.has("reasoning")) {
          setAdoptReasoningSuggested(false);
          setAdoptReasoningConfirmed(false);
        }
        if (!priceFieldsTouched(touchedDraftFieldsRef.current)) {
          setAdoptPriceSuggested(false);
          setAdoptPriceConfirmed(false);
        }
      }
      const settleFailed = () => {
        setProfileLookupFailedForKey(lookupKey);
        setLookupSettledForKey(lookupKey);
      };
      void (async () => {
        try {
          const response = await fetch(
            `${ADOPTION_DRAFT_PATH}?${new URLSearchParams({
              workItemId: adoptWorkItemId,
              modelId: adoptedModelId,
              provider: form.provider,
              apiModel: form.apiModel.trim(),
            })}`,
            // Bounded, so a request that never answers still settles as a
            // failure: the save waits on this key's lookup, and an unbounded
            // wait is a Save button that never comes back.
            { cache: "no-store", signal: AbortSignal.timeout(10_000) }
          );
          if (!response.ok) {
            await discardResponseBody(response);
            // Guarded, like every other write here. A refusal for a key the
            // operator has already moved on from would otherwise arrive late
            // and turn the current key's success back into a failure.
            if (!cancelled) settleFailed();
            return;
          }
          const data = (await response.json().catch(() => null)) as {
            profilePrice?: typeof profilePrice;
            unknowns?: string[];
            notes?: string[];
            fields?: Partial<FormState>;
            effectiveTokenLimits?: typeof effectiveTokenLimits;
            pricingProfileProposal?: string | null;
            suggestions?: { reasoning?: string | null; price?: boolean };
          } | null;
          if (cancelled) return;
          if (!data) {
            // A 200 whose body will not parse is a lookup that did not happen.
            // Treating it as silence left the operator with a Save button that
            // would never enable.
            settleFailed();
            return;
          }
          setProfilePrice(data.profilePrice ?? null);
          setProfileLookupFailedForKey(null);
          setEffectiveTokenLimits(data.effectiveTokenLimits ?? null);
          // Only an untouched prefill follows the key. A number the operator
          // typed is theirs and stays.
          if (data.fields) {
            const fields = data.fields;
            const untouched = DRAFT_FOLLOWED_FIELDS.filter(
              (field) => !touchedDraftFieldsRef.current.has(field)
            );
            draftProposedForKeyRef.current = lookupKey;
            draftPairRef.current = requestedPair;
            setForm((current) => ({
              ...current,
              ...Object.fromEntries(
                untouched.map((field) => [field, fields[field] ?? DRAFT_FIELD_BLANK[field]])
              ),
            }));
            if (!touchedDraftFieldsRef.current.has("reasoning")) {
              setAdoptReasoningSuggested(Boolean(data.suggestions?.reasoning));
              setAdoptReasoningConfirmed(false);
            }
            // Asked again whenever this response writes a documented price into
            // any price field -- not only when none was touched. Typing one
            // price and then having the draft fill the other two from the
            // documentation is exactly the order in which an unchecked price
            // would otherwise reach the save.
            const priceFilledFromDocs =
              Boolean(data.suggestions?.price) &&
              PRICE_FIELDS.some(
                (field) =>
                  !touchedDraftFieldsRef.current.has(field) &&
                  typeof fields[field] === "number"
              );
            if (priceFilledFromDocs) {
              setAdoptPriceSuggested(true);
              setAdoptPriceConfirmed(false);
            } else if (!priceFieldsTouched(touchedDraftFieldsRef.current)) {
              setAdoptPriceSuggested(false);
              setAdoptPriceConfirmed(false);
            }
          }
          setPricingProfileProposal(data.pricingProfileProposal ?? null);
          setGuidanceKey(lookupKey);
          setLookupSettledForKey(lookupKey);
          if (data.unknowns) setAdoptUnknowns(data.unknowns);
          if (data.notes) setAdoptNotes(data.notes);
        } catch {
          // A failed re-resolution must not leave the operator stuck. The save is
          // judged by the server, which resolves the profile itself, so the
          // panel stops gating rather than locking the screen.
          if (!cancelled) settleFailed();
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `form.provider` and `form.apiModel` reach this effect through `lookupKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adoptWorkItemId, adoptedModelId, lookupKey, lookupSettledForKey, profileLookupFailedForKey]);
  // The values an empty token field saves as, for the class currently chosen
  // and the id currently in the form. Absent for any other id: a default
  // resolved for the proposed id says nothing about a corrected one.
  const effectiveLimits =
    adoptWorkItemId && effectiveTokenLimits?.modelId === form.id.trim()
      ? effectiveTokenLimits.byClass[form.usageClass] ?? null
      : null;
  // What each blank token field saves as; see `blankTokenFieldValues` for why
  // a blank cap is "required" without a profile and how the reservation is
  // clamped. Only computed while adopting: a plain create has no draft.
  // Settled for the id in the form, or already priced for it. Derived rather
  // than stored so no effect has to flip it back, and so an id typed after a
  // lookup started is pending again the moment it changes.
  const profileLookupPending = Boolean(lookupKey && lookupSettledForKey !== lookupKey);
  // Not current without a key: an emptied id is not the id the guidance was
  // written for, and showing it would put the previous proposal back on screen.
  const guidanceIsCurrent = !adoptWorkItemId || (lookupKey !== null && guidanceKey === lookupKey);
  const blankTokens = adoptWorkItemId
    ? blankTokenFieldValues({
        // Unknown while the lookup is pending or has failed: whether a blank
        // cap is acceptable depends on a profile nobody has confirmed either way.
        hasPricingProfile:
          profileLookupPending || profileLookupFailed ? null : Boolean(inheritedPrice),
        formMaxOutputTokens: form.maxOutputTokens,
        effective: effectiveLimits,
      })
    : null;
  const blankSavesAs = (value: number | "required" | null | undefined) =>
    value === "required"
      ? m.tokens.blankRequired
      : typeof value === "number"
        ? m.tokens.blankSavesAs(value.toLocaleString(adminIntlLocale(locale)))
        : undefined;

  const creditFloor = useMemo(
    () =>
      suggestCreditFloor({
        inputUsdPerMillionTokens:
          form.inputUsdPerMillionTokens ?? inheritedPrice?.inputUsdPerMillionTokens ?? null,
        outputUsdPerMillionTokens:
          form.outputUsdPerMillionTokens ?? inheritedPrice?.outputUsdPerMillionTokens ?? null,
        maxOutputTokens: form.maxOutputTokens ?? inheritedPrice?.maxOutputTokens ?? null,
        // Anthropic first-party requests write a five-minute prompt cache at a
        // premium on the input price, so the costliest input token on that
        // provider is not the list price. Left at 1 elsewhere.
        inputPriceMultiplier:
          form.provider === "anthropic" ? PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER : 1,
        // The limit this deployment enforces, from the server. Absent on a
        // plain create, where the module's own default applies.
        ...(worstCaseInputTokens ? { worstCaseInputTokens } : {}),
      }),
    [
      form.inputUsdPerMillionTokens,
      form.outputUsdPerMillionTokens,
      form.maxOutputTokens,
      form.provider,
      worstCaseInputTokens,
      inheritedPrice,
    ]
  );

  const updateLocation = (
    nextQuery: string,
    nextProvider: typeof provider,
    nextLifecycle: ModelLifecycleFilter
  ) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextQuery.trim()) params.set("q", nextQuery);
    else params.delete("q");
    if (nextProvider === "all") params.delete("provider");
    else params.set("provider", nextProvider);
    // The default view is the absent value, so a plain /admin/models link and
    // an explicit ?lifecycle=operational mean the same thing.
    if (nextLifecycle === DEFAULT_MODEL_LIFECYCLE_FILTER) params.delete("lifecycle");
    else params.set("lifecycle", nextLifecycle);
    const suffix = params.toString();
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
  };

  const clearFilters = () => {
    setQuery("");
    setProvider("all");
    setLifecycle(DEFAULT_MODEL_LIFECYCLE_FILTER);
    updateLocation("", "all", DEFAULT_MODEL_LIFECYCLE_FILTER);
  };

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setValidation(null);
  };

  // A different model, at the moment the operator picks it. Everything the
  // previous pair proposed or the operator typed about it goes, and so do the
  // reasoning and price confirmations: the server checks that the pair was
  // observed, not that these numbers describe it. Done here rather than in the
  // lookup's debounce, so a value typed for the new pair while the lookup
  // waits is not wiped when it fires.
  // Called only when the pair the lookup key is built from actually changes --
  // the same trimmed comparison the key makes -- so a stray space does not wipe
  // the form without the lookup that would refill it.
  function startNewPair() {
    draftPairRef.current = null;
    draftProposedForKeyRef.current = null;
    touchedDraftFieldsRef.current = new Set();
    setForm((current) => ({ ...current, ...DRAFT_FIELD_BLANK }));
    setAdoptReasoningSuggested(false);
    setAdoptReasoningConfirmed(false);
    setAdoptPriceSuggested(false);
    setAdoptPriceConfirmed(false);
  }

  const selectProvider = (nextProvider: AiProvider) => {
    if (adoptWorkItemId && nextProvider !== form.provider) startNewPair();
    setForm((current) => ({
      ...current,
      provider: nextProvider,
    }));
    setValidation(null);
  };

  const validate = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = (await response.json().catch(() => null)) as { validation?: EnvironmentStatus; error?: string } | null;
      if (!response.ok || !data?.validation) throw new Error(data?.error || m.toast.validationFailed);
      setValidation(data.validation);
      dispatchAppToast(m.toast.validationPassed, "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : m.toast.validationFailed, "error");
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const isNew = editingId === "new";
      const updatePayload: Partial<FormState> = { ...form };
      delete updatePayload.id;
      // Adopting: the create and the queue transition are one act on the
      // server, so the work item travels with the request rather than being
      // moved by a second call that can fail on its own.
      const createUrl =
        isNew && adoptWorkItemId
          ? `/api/admin/models?workItemId=${encodeURIComponent(
              adoptWorkItemId
            )}&reason=${encodeURIComponent(adoptReason.trim())}`
          : "/api/admin/models";
      const response = await fetch(
        isNew ? createUrl : `/api/admin/models/${encodeURIComponent(form.id)}`,
        {
          method: isNew ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(isNew ? form : updatePayload),
        }
      );
      const data = (await response.json().catch(() => null)) as { model?: AdminModel; error?: string } | null;
      if (!response.ok || !data?.model) throw new Error(data?.error || m.toast.saveFailed);
      setModels((current) => {
        const next = current.filter((model) => model.id !== data.model!.id);
        return [...next, data.model!].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      });
      setEditingId(null);
      setCopySourceId(null);
      setValidation(null);
      const adopted = isNew && Boolean(adoptWorkItemId);
      setAdoptWorkItemId(null);
      setAdoptUnknowns([]);
      setAdoptReason("");
      window.dispatchEvent(new Event("tomverse:model-registry-updated"));
      dispatchAppToast(
        adopted
          ? m.toast.addedAndAdopted
          : isNew
            ? m.toast.added
            : m.toast.updated,
        "success"
      );
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : m.toast.saveFailed, "error");
    } finally {
      setSaving(false);
    }
  };

  const archive = async (model: AdminModel) => {
    if (!window.confirm(m.toast.archiveConfirm(model.name))) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/models/${encodeURIComponent(model.id)}`, { method: "DELETE" });
      const data = (await response.json().catch(() => null)) as { model?: AdminModel; error?: string } | null;
      if (!response.ok || !data?.model) throw new Error(data?.error || m.toast.archiveFailed);
      await load();
      setEditingId(null);
      setCopySourceId(null);
      window.dispatchEvent(new Event("tomverse:model-registry-updated"));
      dispatchAppToast(m.toast.archived, "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : m.toast.archiveFailed, "error");
    } finally {
      setSaving(false);
    }
  };

  const beginCreate = () => {
    setForm(emptyForm());
    setEditingId("new");
    setCopySourceId(null);
    setValidation(null);
  };

  const beginDuplicate = (model: AdminModel) => {
    setForm({
      ...formFromModel(model),
      id: duplicateRegistryId(model.id, models),
      name: `${model.name} Copy`,
      status: "disabled",
      publiclyListed: false,
      operationalReason: `Copied from ${model.id}; review before enabling.`,
      userVisibleNote: "",
      replacementModelId: "",
    });
    setEditingId("new");
    setCopySourceId(model.id);
    setValidation(null);
  };

  const beginEdit = (model: AdminModel) => {
    setForm(formFromModel(model));
    setEditingId(model.id);
    setCopySourceId(null);
    setValidation(model.environment);
  };

  return (
    <section className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/80" data-testid="model-registry-panel">
      <div className="flex flex-col gap-4 border-b border-zinc-800 bg-zinc-900/50 p-5 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-300">{m.header.eyebrow}</p>
          <h2 className="mt-2 text-2xl font-black text-white">{m.header.title}</h2>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-zinc-400">
            {m.header.description}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load()} disabled={loading || saving} className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {m.header.reload}
          </button>
          <button type="button" onClick={beginCreate} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-500">
            <Plus className="h-4 w-4" /> {m.header.addModel}
          </button>
        </div>
      </div>

      {securityFindings.length > 0 ? (
        <div className="border-b border-red-900/60 bg-red-950/40 p-4 text-sm text-red-100" role="alert">
          <p className="font-black">{m.security.title}</p>
          <p className="mt-1 text-red-200/80">
            {m.security.detail(securityFindings.length)}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-xs">
            {securityFindings.slice(0, 8).map((finding) => (
              <li key={`${finding.id}:${finding.issue}`}>
                {finding.id}: {finding.issue} ({finding.configuredValue})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid items-end gap-3 border-b border-zinc-800 p-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_220px_220px]">
        <label className="relative md:col-span-2 xl:col-span-1">
          <span className="sr-only">{m.filters.searchLabel}</span>
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(event) => {
              const value = event.target.value;
              setQuery(value);
              updateLocation(value, provider, lifecycle);
            }}
            placeholder={m.filters.searchPlaceholder}
            className={`${inputClass} pl-10`}
          />
        </label>
        <label className={labelClass}>
          {m.filters.provider}
          <select
            value={provider}
            onChange={(event) => {
              const value = event.target.value as "all" | AiProvider;
              setProvider(value);
              updateLocation(query, value, lifecycle);
            }}
            className={inputClass}
            data-testid="model-registry-provider-filter"
          >
            <option value="all">{m.filters.allProviders}</option>
            {AI_PROVIDERS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className={labelClass}>
          {m.filters.lifecycle}
          <select
            value={lifecycle}
            onChange={(event) => {
              const value = normalizeModelLifecycleFilter(event.target.value);
              setLifecycle(value);
              updateLocation(query, provider, value);
            }}
            className={inputClass}
            data-testid="model-registry-lifecycle-filter"
          >
            {MODEL_LIFECYCLE_FILTERS.map((item) => (
              <option key={item} value={item}>{lifecycleLabels[item]}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <p className="text-xs text-zinc-400" role="status" data-testid="model-registry-result-summary">
          <span className="font-bold text-zinc-300">{m.lifecycle.resultSummary(filtered.length, models.length)}</span>
          {hiddenNote ? <span className="ml-2 text-zinc-500">{hiddenNote}</span> : null}
        </p>
        <button
          type="button"
          onClick={clearFilters}
          className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-3 py-1.5 text-xs font-bold text-zinc-200 hover:bg-zinc-900"
        >
          <FilterX className="h-3.5 w-3.5" /> {m.filters.clear}
        </button>
      </div>

      <div className="grid gap-3 p-4 xl:grid-cols-2">
        {filtered.map((model) => {
          // Same classification the filter uses, so the badge can never say
          // "disabled" about a row the Retired view just returned.
          const state = modelLifecycleState(model);
          return (
            <article key={model.id} className={`rounded-2xl border p-4 ${model.catalogDeleted ? "border-zinc-800 bg-zinc-950/40 opacity-70" : "border-zinc-800 bg-zinc-900/50"}`}>
              <div className="flex items-start gap-3">
                <ModelLogo provider={model.provider} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-black text-white">{model.name}</h3>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${state === "limited" ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : state === "active" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-zinc-700 bg-zinc-950 text-zinc-400"}`} data-testid={`model-registry-lifecycle-badge-${model.id}`}>
                      {lifecycleLabels[state]}
                    </span>
                    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-200">{m.card.credits(model.creditWeight || 1)}</span>
                  </div>
                  <p className="mt-1 break-all font-mono text-xs text-zinc-500">{model.id} → {model.apiModel}</p>
                  <p className="mt-2 truncate text-xs text-zinc-400">{model.apiBaseUrl}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-bold">
                    <span className="rounded-lg bg-zinc-950 px-2 py-1 text-zinc-300">{model.provider}</span>
                    <span className="rounded-lg bg-zinc-950 px-2 py-1 text-zinc-300">{model.minimumPlan}+</span>
                    <span className="rounded-lg bg-zinc-950 px-2 py-1 text-zinc-300">{model.usageClass}</span>
                    <span className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 ${model.environment.apiKeyConfigured ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>
                      <KeyRound className="h-3 w-3" /> {model.environment.apiKeyEnvName}
                    </span>
                  </div>
                  {model.operationalReason ? (
                    <p className="mt-3 line-clamp-2 text-xs text-amber-200/80">
                      {m.card.internalPrefix}{model.operationalReason}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" onClick={() => beginDuplicate(model)} className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 p-2 text-zinc-300 hover:bg-zinc-800" aria-label={m.card.duplicateLabel(model.name)} title={m.card.duplicateTitle}>
                    <Copy className="h-4 w-4" />
                    <span className="hidden text-xs font-bold 2xl:inline">{m.card.copy}</span>
                  </button>
                  <button type="button" onClick={() => beginEdit(model)} className="rounded-xl border border-zinc-700 p-2 text-zinc-300 hover:bg-zinc-800" aria-label={m.card.editLabel(model.name)}>
                    <Pencil className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {editingId ? (
        <div className="fixed inset-0 z-[120] flex items-start justify-center overflow-y-auto bg-black/75 p-3 backdrop-blur-sm md:p-8" role="dialog" aria-modal="true" aria-label={editingId === "new" ? m.dialog.addModel : m.dialog.editModel(form.name)}>
          <div className="my-auto w-full max-w-5xl overflow-hidden rounded-3xl border border-zinc-700 bg-zinc-950 shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-950/95 p-5 backdrop-blur">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">{adoptWorkItemId ? m.dialog.eyebrowAdopt : copySourceId ? m.dialog.eyebrowDuplicate : editingId === "new" ? m.dialog.eyebrowNew : m.dialog.eyebrowEdit}</p>
                <h3 className="mt-1 text-xl font-black text-white">{form.name || m.dialog.untitled}</h3>
                {copySourceId ? (
                  <p className="mt-1 text-xs text-amber-200">
                    {m.dialog.copiedFrom(copySourceId)}
                  </p>
                ) : null}
                {adoptWorkItemId ? (
                  <p className="mt-1 text-xs text-zinc-300">
                    {m.dialog.adoptPrefilled}
                  </p>
                ) : null}
              </div>
              <button type="button" onClick={() => { setEditingId(null); setCopySourceId(null); setAdoptWorkItemId(null); setAdoptUnknowns([]); }} className="rounded-xl border border-zinc-700 p-2 text-zinc-300 hover:bg-zinc-800"><X className="h-5 w-5" /></button>
            </div>

            <div className="grid gap-6 p-5">
              {adoptWorkItemId ? (
                <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4">
                  <p className="text-xs font-bold uppercase tracking-[0.12em] text-amber-200">
                    {m.adopt.unknownsTitle}
                  </p>
                  <ul className="mt-2 grid gap-1 text-xs text-zinc-300">
                    {guidanceIsCurrent ? (
                      adoptUnknowns.map((item) => <li key={item}>· {item}</li>)
                    ) : !lookupKey ? (
                      <li>· {m.adopt.draftNeedsId}</li>
                    ) : profileLookupFailed ? (
                      <li>· {m.adopt.draftFailed}</li>
                    ) : (
                      <li>· {m.adopt.draftReloading}</li>
                    )}
                  </ul>
                  {guidanceIsCurrent && adoptNotes.length ? (
                    <>
                      <p className="mt-4 text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">
                        {m.adopt.notesTitle}
                      </p>
                      <ul className="mt-2 grid gap-1 text-xs text-zinc-400">
                        {adoptNotes.map((item) => (
                          <li key={item}>· {item}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {guidanceIsCurrent && pricingProfileProposal ? (
                    <div className="mt-4">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">
                          {m.adopt.profileProposalTitle}
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard
                              ?.writeText(pricingProfileProposal)
                              .then(
                                () => dispatchAppToast(m.adopt.proposalCopied, "success"),
                                () => dispatchAppToast(m.adopt.proposalCopyFailed, "error")
                              );
                          }}
                          className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] font-bold text-zinc-200 hover:bg-zinc-800"
                        >
                          {m.adopt.copyProposal}
                        </button>
                      </div>
                      <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                        {pricingProfileProposal}
                      </pre>
                    </div>
                  ) : null}
                  {profileLookupFailed ? (
                    <p className="mt-3 text-xs text-amber-200">
                      {m.adopt.profileLookupFailed}
                    </p>
                  ) : null}
                  <label className={`${labelClass} mt-4`}>
                    {m.adopt.reason}
                    <input
                      value={adoptReason}
                      onChange={(e) => setAdoptReason(e.target.value)}
                      className={inputClass}
                      placeholder={m.adopt.reasonPlaceholder}
                    />
                  </label>
                </div>
              ) : null}
              {editingId === "new" ? (
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">
                    {m.floor.title}
                  </p>
                  {isCreditFloor(creditFloor) ? (
                    <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                      {m.floor.worstTurn(
                        creditFloor.inputTokens.toLocaleString(adminIntlLocale(locale)),
                        creditFloor.outputTokens.toLocaleString(adminIntlLocale(locale))
                      )}{" "}
                      <span className="font-mono text-white">
                        US${(creditFloor.worstCaseMicroUsd / 1_000_000).toFixed(3)}
                      </span>
                      {creditFloor.inputMultiplier > 0 && form.provider === "anthropic"
                        ? m.floor.cacheWritePremium
                        : ""}
                      {m.floor.cheapestClass}{" "}
                      <span className="font-bold text-white">{creditFloor.usageClass}</span>{m.floor.classCreditsJoin}{" "}
                      <span className="font-bold text-white">{creditFloor.credits}</span>{m.floor.creditsLowerBound}{" "}
                      {inheritedPrice
                        ? m.floor.inheritedProfile
                        : m.floor.notIncluded}
                    </p>
                  ) : creditFloor.reason === "above_every_class" ? (
                    <p className="mt-2 text-xs leading-relaxed text-red-300">
                      {m.floor.noClassBefore}{" "}
                      <span className="font-mono">
                        US${((creditFloor.worstCaseMicroUsd ?? 0) / 1_000_000).toFixed(3)}
                      </span>
                      {m.floor.noClassAfter}
                    </p>
                  ) : (
                    <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                      {creditFloor.reason === "output_cap_unknown"
                        ? m.floor.outputCapUnknown
                        : m.floor.pricesUnknown}
                    </p>
                  )}
                </div>
              ) : null}
              <fieldset className="grid gap-4 rounded-2xl border border-zinc-800 p-4 md:grid-cols-2">
                <legend className="px-2 text-sm font-bold text-white">{m.identity.legend}</legend>
                <label className={labelClass}>{m.identity.registryId}<input disabled={editingId !== "new"} value={form.id} onChange={(e) => setField("id", e.target.value)} className={`${inputClass} disabled:opacity-60`} placeholder="provider/model-name" /></label>
                <label className={labelClass}>{m.identity.displayName}<input value={form.name} onChange={(e) => setField("name", e.target.value)} className={inputClass} /></label>
                <label className={labelClass}>{m.identity.provider}<select value={form.provider} onChange={(e) => selectProvider(e.target.value as AiProvider)} className={inputClass}>{AI_PROVIDERS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
                <label className={labelClass}>{m.identity.apiModel}<input value={form.apiModel} onChange={(e) => { if (adoptWorkItemId && e.target.value.trim() !== form.apiModel.trim()) startNewPair(); setField("apiModel", e.target.value); }} className={inputClass} placeholder={m.identity.apiModelPlaceholder} /></label>
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 md:col-span-2">
                  <p className="text-xs font-bold uppercase tracking-[0.12em] text-emerald-200">{m.identity.connectionTitle}</p>
                  <p className="mt-2 break-all font-mono text-xs text-zinc-300">{PROVIDER_API_CONFIGURATION[form.provider].baseUrl}</p>
                  <p className="mt-1 font-mono text-xs text-zinc-400">{PROVIDER_API_CONFIGURATION[form.provider].apiKeyEnvName}</p>
                  <p className="mt-2 text-xs leading-5 text-zinc-400">{m.identity.connectionNote}</p>
                </div>
                <label className={labelClass}>{m.identity.icon}<input value={form.icon} onChange={(e) => setField("icon", e.target.value)} className={inputClass} /></label>
                <label className={`${labelClass} md:col-span-2`}>{m.identity.purpose}<input value={form.bestFor} onChange={(e) => setField("bestFor", e.target.value)} className={inputClass} placeholder={m.identity.purposePlaceholder} /></label>
              </fieldset>

              <fieldset className="grid gap-4 rounded-2xl border border-zinc-800 p-4 md:grid-cols-4">
                <legend className="px-2 text-sm font-bold text-white">{m.catalogue.legend}</legend>
                <label className={labelClass}>{m.catalogue.minimumPlan}<select value={form.minimumPlan} onChange={(e) => setField("minimumPlan", e.target.value as ModelMinimumPlan)} className={inputClass}><option>Guest</option><option>Free</option><option>Pro</option></select></label>
                <label className={labelClass}>{m.catalogue.usageClass}<select value={form.usageClass} onChange={(e) => { setField("usageClass", e.target.value as ModelUsageClass); setAdoptClassChosen(true); }} className={inputClass}>{["standard","advanced","premium","reasoning","premium-reasoning","research","deep-research"].map((item) => <option key={item}>{item}</option>)}</select>{adoptWorkItemId && !adoptClassChosen ? <span className="text-[11px] font-normal normal-case tracking-normal text-amber-200">{m.adopt.classRequired}</span> : null}</label>
                <label className={labelClass}>{m.catalogue.creditWeight}<input type="number" min={1} max={1000} value={form.creditWeight} onChange={(e) => setField("creditWeight", Number(e.target.value))} className={inputClass} /></label>
                <label className={labelClass}>{m.catalogue.runtimeStatus}<select value={form.status} onChange={(e) => setField("status", e.target.value as ModelStatus)} className={inputClass}><option value="enabled">{m.catalogue.status.enabled}</option><option value="limited">{m.catalogue.status.limited}</option><option value="disabled">{m.catalogue.status.disabled}</option><option value="coming-soon">{m.catalogue.status.comingSoon}</option></select></label>
                <label className="flex items-center gap-2 text-sm font-bold text-zinc-300"><input type="checkbox" checked={form.publiclyListed} onChange={(e) => setField("publiclyListed", e.target.checked)} className="h-4 w-4" /> {m.catalogue.publiclyListed}</label>
                <label className={`${labelClass} md:col-span-2`}>{m.catalogue.replacementModel}<select value={form.replacementModelId} onChange={(e) => setField("replacementModelId", e.target.value)} className={inputClass}><option value="">{m.catalogue.none}</option>{models.filter((model) => model.id !== form.id && !model.catalogDeleted).map((model) => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}</select></label>
                <label className={labelClass}>{m.catalogue.sortOrder}<input type="number" value={form.sortOrder} onChange={(e) => setField("sortOrder", Number(e.target.value))} className={inputClass} /></label>
                <label className={`${labelClass} md:col-span-2`}>{m.catalogue.operationalReason}<textarea rows={3} value={form.operationalReason} onChange={(e) => setField("operationalReason", e.target.value)} className={inputClass} placeholder={m.catalogue.operationalReasonPlaceholder} /></label>
                <label className={`${labelClass} md:col-span-2`}>{m.catalogue.userVisibleNote}<textarea rows={3} value={form.userVisibleNote} onChange={(e) => setField("userVisibleNote", e.target.value)} className={inputClass} placeholder={m.catalogue.userVisibleNotePlaceholder} /></label>
              </fieldset>

              <fieldset className="grid gap-4 rounded-2xl border border-zinc-800 p-4 md:grid-cols-4">
                <legend className="px-2 text-sm font-bold text-white">{m.capabilities.legend}</legend>
                <label className="flex items-center gap-2 text-sm font-bold text-zinc-300"><input type="checkbox" checked={form.supportsImage} onChange={(e) => { touchedDraftFieldsRef.current.add("supportsImage"); setField("supportsImage", e.target.checked); }} /> {m.capabilities.imageInput}</label>
                <label className="flex items-center gap-2 text-sm font-bold text-zinc-300"><input type="checkbox" checked={form.supportsNativePdf} onChange={(e) => { touchedDraftFieldsRef.current.add("supportsNativePdf"); setField("supportsNativePdf", e.target.checked); }} /> {m.capabilities.nativePdf}</label>
                <label className={labelClass}>{m.capabilities.reasoning}<select value={form.reasoning} onChange={(e) => { touchedDraftFieldsRef.current.add("reasoning"); setField("reasoning", e.target.value as FormState["reasoning"]); setAdoptReasoningConfirmed(true); }} className={inputClass}><option value="none">{m.capabilities.reasoningLevels.none}</option><option value="low">{m.capabilities.reasoningLevels.low}</option><option value="medium">{m.capabilities.reasoningLevels.medium}</option><option value="high">{m.capabilities.reasoningLevels.high}</option></select>{adoptWorkItemId && adoptReasoningSuggested && !adoptReasoningConfirmed ? <span className="flex flex-wrap items-center gap-2 text-[11px] font-normal normal-case tracking-normal text-amber-200">{m.adopt.reasoningSuggested}<button type="button" onClick={() => setAdoptReasoningConfirmed(true)} className="rounded-md border border-amber-300/40 px-2 py-0.5 font-bold text-amber-100 hover:bg-amber-300/10">{m.adopt.reasoningConfirm}</button></span> : null}</label>
                <label className={labelClass}>{m.capabilities.contextWindow}<input type="number" value={form.contextWindowTokens ?? ""} onChange={(e) => { touchedDraftFieldsRef.current.add("contextWindowTokens"); setField("contextWindowTokens", numericValue(e.target.value)); }} className={inputClass} /></label>
                <label className={labelClass}>{m.capabilities.maxImages}<input type="number" value={form.maxImages ?? ""} onChange={(e) => setField("maxImages", numericValue(e.target.value))} className={inputClass} /></label>
                <label className={labelClass}>{m.capabilities.maxBase64ImageBytes}<input type="number" value={form.maxBase64ImagePayloadBytes ?? ""} onChange={(e) => setField("maxBase64ImagePayloadBytes", numericValue(e.target.value))} className={inputClass} /></label>
              </fieldset>

              <fieldset className="grid gap-4 rounded-2xl border border-zinc-800 p-4 md:grid-cols-3">
                <legend className="px-2 text-sm font-bold text-white">{m.tokens.legend}</legend>
                <label className={labelClass}>{m.tokens.maxOutputTokens}<input type="number" value={form.maxOutputTokens ?? ""} onChange={(e) => { touchedDraftFieldsRef.current.add("maxOutputTokens"); setField("maxOutputTokens", numericValue(e.target.value)); }} className={inputClass} placeholder={blankSavesAs(blankTokens?.maxOutputTokens)} /></label>
                <label className={labelClass}>{m.tokens.reservationOutputTokens}<input type="number" value={form.reservationOutputTokens ?? ""} onChange={(e) => setField("reservationOutputTokens", numericValue(e.target.value))} className={inputClass} placeholder={blankSavesAs(blankTokens?.reservationOutputTokens)} /></label>
                <label className={labelClass}>{m.tokens.cachedInputMultiplier}<input type="number" min={0} max={1} step="0.01" value={form.cachedInputPriceMultiplier ?? ""} onChange={(e) => { touchedDraftFieldsRef.current.add("cachedInputPriceMultiplier"); setAdoptPriceConfirmed(true); setField("cachedInputPriceMultiplier", numericValue(e.target.value)); }} className={inputClass} /></label>
                {adoptWorkItemId && adoptPriceSuggested && !adoptPriceConfirmed ? (
                  <div className="md:col-span-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
                    {m.adopt.priceFromDocs}
                    <button type="button" onClick={() => setAdoptPriceConfirmed(true)} className="rounded-md border border-amber-300/40 px-2 py-0.5 font-bold text-amber-100 hover:bg-amber-300/10">{m.adopt.confirmPrice}</button>
                  </div>
                ) : null}
                <label className={labelClass}>{m.tokens.inputUsd}<input type="number" min={0} step="0.000001" value={form.inputUsdPerMillionTokens ?? ""} onChange={(e) => { touchedDraftFieldsRef.current.add("inputUsdPerMillionTokens"); setAdoptPriceConfirmed(true); setField("inputUsdPerMillionTokens", numericValue(e.target.value)); }} className={inputClass} /></label>
                <label className={labelClass}>{m.tokens.outputUsd}<input type="number" min={0} step="0.000001" value={form.outputUsdPerMillionTokens ?? ""} onChange={(e) => { touchedDraftFieldsRef.current.add("outputUsdPerMillionTokens"); setAdoptPriceConfirmed(true); setField("outputUsdPerMillionTokens", numericValue(e.target.value)); }} className={inputClass} /></label>
              </fieldset>

              {validation ? (
                <div className={`rounded-2xl border p-4 ${validation.compatible && validation.apiKeyConfigured ? "border-emerald-500/30 bg-emerald-500/10" : "border-amber-500/30 bg-amber-500/10"}`}>
                  <p className="flex items-center gap-2 font-black text-white"><ShieldCheck className="h-4 w-4" /> {m.validation.title}</p>
                  <p className="mt-2 text-sm text-zinc-300">{m.validation.summary(validation.protocol, validation.apiKeyEnvName, validation.apiKeyConfigured ? m.validation.configured : m.validation.missing)}</p>
                  {validation.warnings.map((warning) => <p key={warning} className="mt-1 text-xs text-amber-200">• {warning}</p>)}
                </div>
              ) : null}
            </div>

            <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950/95 p-4 backdrop-blur">
              <div>
                {editingId !== "new" ? (
                  <button type="button" onClick={() => void archive(models.find((model) => model.id === editingId)!)} disabled={saving} className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 px-4 py-2 text-sm font-bold text-red-200 hover:bg-red-500/10 disabled:opacity-50"><Archive className="h-4 w-4" /> {m.actions.removeFromCatalogue}</button>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void validate()} disabled={saving} className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"><CheckCircle2 className="h-4 w-4" /> {m.actions.validate}</button>
                <button type="button" onClick={() => void save()} disabled={saving || (Boolean(adoptWorkItemId) && (adoptReason.trim().length < 4 || !adoptClassChosen || profileLookupPending || (adoptReasoningSuggested && !adoptReasoningConfirmed) || (adoptPriceSuggested && !adoptPriceConfirmed) || (!profileLookupFailed && (!isCreditFloor(creditFloor) || form.creditWeight < creditFloor.credits))))} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2 text-sm font-bold text-white hover:bg-blue-500 disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {form.id && models.find((model) => model.id === form.id)?.catalogDeleted ? m.actions.restoreAndSave : m.actions.saveModel}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {!loading && filtered.length === 0 ? (
        <div className="p-10 text-center text-sm text-zinc-500" data-testid="model-registry-empty-state"><Database className="mx-auto mb-3 h-6 w-6" />{lifecycle === "all" ? m.lifecycle.emptyAll : m.lifecycle.emptyInView(lifecycleLabels[lifecycle])}</div>
      ) : null}
    </section>
  );
}
