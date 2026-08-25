"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  Crown,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { useLanguage } from "@/components/LanguageProvider";
import { notifyUserUsageChanged } from "@/components/chat/useUserUsage";
import { estimatePromptTokens } from "@/lib/chatTokenEstimate";
import { useIsMobileShell } from "@/components/chat/useIsMobileShell";
import {
  getChatEnterKeyAction,
  isComposingKeydown,
} from "@/lib/chatKeyboardPolicy";
import type { ImageComposerRestore } from "@/lib/imageComposerRestore";
import { mergeImageTimelineRow } from "@/lib/imageTimelineMerge";
import {
  getImageGenerationPricing,
  IMAGE_PROMPT_MAX_TOKENS,
  IMAGE_QUALITY_BY_PRESET,
  type ImagePreset,
  type ImageSize,
} from "@/lib/imageGenerationPricing";
import {
  DEFAULT_IMAGE_MODEL_ID,
  getImageModel,
  getImageModelPrice,
  imageModelChipLabel,
  imageComposerModelLayout,
  listEnabledImageModels,
  type ImageModelProfile,
} from "@/lib/imageModelRegistry";
import {
  limitImageModelSelection,
  reportedImageModelLimit,
  toggleImageModelSelection,
} from "@/lib/imageModelSelection";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { saveResponseAsFile } from "@/lib/browserDownload";
import { imageDownloadFilename } from "@/lib/imageAssetDownload";
import {
  IMAGE_ASSET_URL_TTL_MINUTES,
  isImageAssetUrlExpired,
} from "@/lib/imageAssetPayload";
import { dispatchAppToast } from "@/lib/appToast";

// The image conversation surface: prompt composer, option pickers and the
// generation timeline. Self-contained on purpose -- ChatInput, ChatApp and the
// comparison rail are chat-only surfaces and an image conversation must never
// mount them (docs/policy/image-generation.md §1). Rendering follows the
// mobile composer contract's shape all the same: the textarea owns a
// dedicated full-width row and controls live in their own rows below it.
//
// Signed asset URLs expire in ~5 minutes and are never persisted; an <img>
// that fails after expiry re-reads the generation once to mint fresh URLs.

const IMAGE_SIZES: Array<{ size: ImageSize; labelKey: string }> = [
  { size: "1024x1024", labelKey: "chat.imageGenerationSizeSquare" },
  { size: "1536x1024", labelKey: "chat.imageGenerationSizeLandscape" },
  { size: "1024x1536", labelKey: "chat.imageGenerationSizePortrait" },
];

const IMAGE_PRESETS: Array<{
  preset: ImagePreset;
  labelKey: string;
  hintKey: string;
}> = [
  {
    preset: "draft",
    labelKey: "chat.imageGenerationPresetDraft",
    hintKey: "chat.imageGenerationPresetDraftHint",
  },
  {
    preset: "standard",
    labelKey: "chat.imageGenerationPresetStandard",
    hintKey: "chat.imageGenerationPresetStandardHint",
  },
  {
    preset: "final",
    labelKey: "chat.imageGenerationPresetFinal",
    hintKey: "chat.imageGenerationPresetFinalHint",
  },
];

const POLL_INTERVAL_MS = 5_000;

/**
 * One id, referenced by every chip the limit currently blocks.
 *
 * A single shared description rather than one per chip: the reason is the same
 * sentence for all of them, and duplicating it would make a screen reader read
 * the limit once per unselectable model.
 */
const MODEL_LIMIT_NOTICE_ID = "image-model-limit-notice";

type GenerationAsset = {
  role: string;
  mimeType: string;
  url: string;
  // Optional only for a payload minted before the field existed -- a tab left
  // open across the deploy. `isImageAssetUrlExpired()` reads absence as "not
  // known to be dead" rather than as expired.
  urlExpiresAt?: string;
};

type GenerationView = {
  generationId: string;
  conversationId: string;
  status: string;
  prompt: string;
  preset: string;
  size: string;
  reservedCredits: number | null;
  refunded: boolean;
  publicErrorCode: string | null;
  createdAt: string;
  assets: GenerationAsset[];
  // v2 identity: which comparison slot and model this attempt belongs to.
  provider?: string;
  modelId?: string;
  outputWidth?: number | null;
  outputHeight?: number | null;
  groupId?: string;
  targetId?: string;
  attemptNumber?: number;
};

/**
 * One comparison group as the timeline renders it: the prompt once, then the
 * latest attempt of each target. Derived from the attempts, never stored --
 * the same rule the server follows (policy §11).
 */
type GroupView = {
  groupId: string;
  prompt: string;
  createdAt: string;
  targets: GenerationView[];
};

const groupAttempts = (generations: GenerationView[]): GroupView[] => {
  const groups = new Map<string, Map<string, GenerationView>>();
  const order: string[] = [];
  for (const generation of generations) {
    const groupId = generation.groupId ?? generation.generationId;
    const targetId = generation.targetId ?? generation.generationId;
    if (!groups.has(groupId)) {
      groups.set(groupId, new Map());
      order.push(groupId);
    }
    const targets = groups.get(groupId)!;
    const existing = targets.get(targetId);
    // Only the newest attempt of a target is the current state; older ones
    // stay in the payload as audit history and must not render as extra
    // cards.
    if (
      !existing ||
      (generation.attemptNumber ?? 1) >= (existing.attemptNumber ?? 1)
    ) {
      targets.set(targetId, generation);
    }
  }
  return order.map((groupId) => {
    const targets = [...groups.get(groupId)!.values()].sort((a, b) =>
      (a.modelId ?? "").localeCompare(b.modelId ?? "")
    );
    return {
      groupId,
      prompt: targets[0]?.prompt ?? "",
      createdAt: targets[0]?.createdAt ?? "",
      targets,
    };
  });
};

// The whole registry, not just the enabled models: a card whose model was
// held after it produced its image, and a restore notice naming the model it
// had to drop, both need the name of something that is no longer selectable.
// Falling back to the raw id there showed `gemini-3.1-flash-image` to a user.
const imageModelName = (modelId: string | undefined) =>
  (modelId && getImageModel(modelId)?.name) || modelId || "";

const isTerminal = (status: string) =>
  status === "succeeded" || status === "failed";

const interpolateCopy = (
  template: string,
  values: Record<string, string | number>
) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );

type ImageGenerationWorkspaceProps = {
  /** Null while this is a client-side draft: no server row exists yet. */
  conversationId: string | null;
  /**
   * Called when the first generation request atomically created the image
   * conversation server-side, so the page can adopt it into the sidebar.
   */
  onConversationCreated: (conversation: { id: string; title: string }) => void;
  /** The operational opt-in flag, resolved server-side at page load. */
  flagEnabled: boolean;
  /** Mirrors planAllowsImageGeneration; the server re-checks regardless. */
  planAllowsImageGeneration: boolean;
  /** Text carried over from the chat composer when the user switched here. */
  initialPrompt?: string;
  /**
   * Set when the user arrived by picking a model in the catalogue's image tab.
   * Unknown or held ids are dropped rather than trusted: the registry decides
   * what is selectable, not the caller.
   */
  initialModelIds?: readonly string[];
  /**
   * How many models one request may compare, as the running server resolves it
   * (`lib/imageGroupLimits.ts`, read in the chat page's Server Component).
   *
   * Passed in, never derived here, and never written as a literal below: the
   * composer offering three models while admission allows two is what produced
   * this prop -- the request looked valid all the way to submit and came back
   * as a generic "try again" that retrying could not fix.
   */
  maxModels: number;
  /** Present only when there is a chat draft to go back to. */
  onCancelDraft?: () => void;
  /**
   * True for exactly one landing: the user pressed the chat image handoff on a
   * request they had written in words, and this account has chosen to stop
   * being asked. Spent on arrival -- `onAutoGenerateArrivalConsumed` is called
   * whatever the outcome, so a refused submit does not leave a landing armed.
   *
   * Never true for the launcher or the tools menu. Those are someone opening
   * the workspace to compose, and a workspace that generated because it was
   * opened would spend credits on navigation.
   */
  autoGenerateOnArrival?: boolean;
  onAutoGenerateArrivalConsumed?: () => void;
  /**
   * The account's stored choice, and the writer for it. Rendered beside the
   * price, which is the point: the workspace contract's "quoted before
   * submission" survives this feature as "quoted at least once, to the person
   * who chose to stop being asked", and that is only true if the only place
   * the choice can be made is a place the price is on screen.
   */
  autoGeneratePreference?: boolean;
  onAutoGeneratePreferenceChange?: (next: boolean) => void;
};

export function ImageGenerationWorkspace({
  conversationId,
  onConversationCreated,
  flagEnabled,
  planAllowsImageGeneration,
  initialPrompt = "",
  initialModelIds,
  maxModels,
  onCancelDraft,
  autoGenerateOnArrival = false,
  onAutoGenerateArrivalConsumed,
  autoGeneratePreference = false,
  onAutoGeneratePreferenceChange,
}: ImageGenerationWorkspaceProps) {
  const { t } = useLanguage();
  const isMobileShell = useIsMobileShell();
  const [generations, setGenerations] = useState<GenerationView[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [preset, setPreset] = useState<ImagePreset>("standard");
  const [size, setSize] = useState<ImageSize>("1024x1024");
  // Seed ids come from the catalogue's image tab and are bounded by the same
  // limit as everything else: a deployment can lower it between the catalogue
  // render and this mount, and a seed is not more privileged than a restore.
  const [seedLimitOutcome] = useState(() => {
    const enabled = new Set(listEnabledImageModels().map((model) => model.id));
    const seeded = (initialModelIds ?? []).filter((modelId) =>
      enabled.has(modelId)
    );
    if (seeded.length === 0) {
      return { modelIds: [DEFAULT_IMAGE_MODEL_ID], excludedModelIds: [] };
    }
    return limitImageModelSelection({ modelIds: seeded, maxModels });
  });
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(
    seedLimitOutcome.modelIds
  );
  // Set when a click or key press was refused for the limit. Persistent --
  // cleared by the next successful selection change, not by a timer -- so the
  // reason stays on screen while the user decides which model to drop.
  const [limitNotice, setLimitNotice] = useState(false);
  // Set the moment the user touches a model, quality or size. A restore
  // answer that arrives after that is discarded: the read describes the last
  // comparison, and the user's newer choice is the one that should win a race
  // with the network.
  const composerTouchedRef = useRef(false);
  // Read inside the history effect without joining its dependency list: the
  // effect fetches a conversation's timeline, and re-fetching it because the
  // limit changed would be a request nobody asked for.
  const maxModelsRef = useRef(maxModels);
  useEffect(() => {
    maxModelsRef.current = maxModels;
  }, [maxModels]);
  // The restore's *outcome*, not its copy: rendering the sentences here would
  // pull `t` into the history-load effect and re-run the fetch on a language
  // change. Stored structurally, the notice simply follows the language.
  const [restoreOutcome, setRestoreOutcome] = useState<{
    excludedModelIds: string[];
    limitExcludedModelIds: string[];
    optionsConsistent: boolean;
  } | null>(null);
  const [retryingTargetIds, setRetryingTargetIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [downloadingIds, setDownloadingIds] = useState<string[]>([]);
  // Kept apart from submitError: a download that failed says nothing about the
  // composer, and overwriting a submit refusal with it would lose the reason
  // the user still has to act on.
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // The poll loop's wall clock, read at render time in place of Date.now().
  const [pollClockMs, setPollClockMs] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const refreshedAssetIds = useRef(new Set<string>());
  // Separate from refreshedAssetIds above, which caps the <img> repair at one
  // attempt per generation for good: this one is only an in-flight guard, and
  // clears, because re-opening the original is a repeatable thing to ask for.
  const refreshingLinkIds = useRef(new Set<string>());
  // The id may arrive mid-flight via onConversationCreated; the ref keeps the
  // poll loop reading the current value without re-arming the effect.
  const conversationIdRef = useRef<string | null>(conversationId);
  const [pickerOpen, setPickerOpen] = useState(false);

  const quality = IMAGE_QUALITY_BY_PRESET[preset];
  const pricing = getImageGenerationPricing(quality, size);
  const availableModels = useMemo(() => listEnabledImageModels(), []);
  // Decided by how many models are enabled, and by nothing else -- not the
  // viewport, not the selection, not a measured line count. The rule itself
  // lives in the registry so it can be tested at four and five enabled models,
  // a state this deployment cannot reach until a fourth model is activated.
  const {
    compact: compactPicker,
    inline: inlineModels,
    picker: pickerModels,
  } = imageComposerModelLayout(availableModels, selectedModelIds);
  // Per-model price for the current options, and the total the request will
  // actually charge -- shown before submitting, never after (policy §12).
  const selectedModelPrices = selectedModelIds.map((modelId) => ({
    modelId,
    credits: getImageModelPrice(modelId, quality, size)?.credits ?? null,
  }));
  const totalCredits = selectedModelPrices.reduce(
    (sum, entry) => sum + (entry.credits ?? 0),
    0
  );
  const hasUnpricedSelection = selectedModelPrices.some(
    (entry) => entry.credits === null
  );
  const groups = useMemo(() => groupAttempts(generations), [generations]);
  const estimatedTokens = useMemo(
    () => (prompt.trim() ? estimatePromptTokens(prompt) : 0),
    [prompt]
  );
  const promptTooLong = estimatedTokens > IMAGE_PROMPT_MAX_TOKENS;
  const hasActiveGeneration = generations.some(
    (generation) => !isTerminal(generation.status)
  );
  // How many models the running comparison is waiting on. Counted by target,
  // not by attempt: a retried target is one card still working, not two.
  const activeTargetCount = new Set(
    generations
      .filter((generation) => !isTerminal(generation.status))
      .map((generation) => generation.targetId ?? generation.generationId)
  ).size;

  const mergeGeneration = useCallback(
    (incoming: GenerationView, options?: { refreshAssets?: boolean }) => {
      setGenerations((current) =>
        mergeImageTimelineRow(current, incoming, options)
      );
    },
    []
  );

  // History load. Conversation switches remount this component (the page
  // keys it on the conversation id), so mount state is always fresh and this
  // effect only ever loads the mounted conversation's history.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(
          `/api/conversations/${conversationId}/generations`,
          { cache: "no-store" }
        );
        if (!response.ok) {
          await discardResponseBody(response);
          throw new Error(`status ${response.status}`);
        }
        const payload = (await response.json()) as {
          generations: GenerationView[];
          composerRestore?: ImageComposerRestore | null;
        };
        if (cancelled) return;
        setGenerations(payload.generations);
        // Applied once, on entering an existing conversation, and never over a
        // choice the user has already made.
        const restore = payload.composerRestore;
        if (restore && !composerTouchedRef.current) {
          // A comparison made when the limit was higher restores more models
          // than the composer may now offer. The stored group is left exactly
          // as it is -- it is a record of what ran -- and only what the
          // composer starts with is cut down, with the dropped models named.
          const limited = limitImageModelSelection({
            modelIds: restore.modelIds,
            maxModels: maxModelsRef.current,
          });
          setSelectedModelIds(limited.modelIds);
          // Options come back only when every target of the last comparison
          // agreed on them. A disagreement is a bug, not a preference, so the
          // composer keeps its safe defaults and says the options were not
          // restored rather than presenting one target's values as the user's.
          if (restore.preset) setPreset(restore.preset);
          if (restore.size) setSize(restore.size);
          setRestoreOutcome({
            // Two different reasons a model is missing, kept apart: the
            // registry can no longer offer it, or it did not fit. Merging them
            // would tell a user a model was withdrawn when it is simply the
            // fourth of three.
            excludedModelIds: restore.excludedModelIds,
            limitExcludedModelIds: limited.excludedModelIds,
            optionsConsistent: restore.optionsConsistent,
          });
        }
      } catch {
        if (!cancelled) setHistoryError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Single-card recovery, not polling: re-reads one generation to mint fresh
  // signed asset URLs after the ~5 minute TTL expires. Polling goes through
  // refreshGroup below.
  const refreshGeneration = useCallback(
    async (generationId: string) => {
      try {
        const response = await fetch(
          `/api/images/generations/${generationId}`,
          { cache: "no-store" }
        );
        if (!response.ok) {
          await discardResponseBody(response);
          return null;
        }
        const payload = (await response.json()) as GenerationView;
        // The one caller allowed to replace signed asset URLs: this read exists
        // because they expire.
        mergeGeneration(payload, { refreshAssets: true });
        return payload;
      } catch {
        return null;
      }
    },
    [mergeGeneration]
  );

  // One request per unsettled comparison group, not one per unsettled model
  // (policy §11). Polling per generation made watching a comparison cost
  // proportionally more the more models were being compared -- and because a
  // refused poll reads here as "no update", exhausting the status rate limit
  // would have shown up as a workspace that silently stopped refreshing.
  const refreshGroup = useCallback(
    async (groupId: string) => {
      try {
        const response = await fetch(`/api/images/groups/${groupId}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          await discardResponseBody(response);
          return null;
        }
        const payload = (await response.json()) as {
          status: string;
          generations: GenerationView[];
        };
        for (const generation of payload.generations) mergeGeneration(generation);
        return payload;
      } catch {
        return null;
      }
    },
    [mergeGeneration]
  );

  // Polling continues until every target settles; the server's own stale sweep
  // is what eventually fails a generation whose worker died.
  useEffect(() => {
    if (!hasActiveGeneration) return;
    const timer = setInterval(async () => {
      setPollClockMs(Date.now());
      const activeGroupIds = [
        ...new Set(
          generations
            .filter((generation) => !isTerminal(generation.status))
            // A group id is always present on a server row; the fallback
            // covers the optimistic card written before the POST answered.
            .map((generation) => generation.groupId ?? generation.generationId)
        ),
      ];
      const results = await Promise.all(
        activeGroupIds.map((groupId) => refreshGroup(groupId))
      );
      // One credit refresh per tick that settled something, not one per
      // target: the balance is a single number and N models finishing
      // together do not make it N different numbers.
      if (results.some((result) => result && result.status !== "in_progress")) {
        notifyUserUsageChanged();
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [generations, hasActiveGeneration, refreshGroup]);

  // Keep the newest card in view as the timeline grows or a result lands.
  const lastTimelineKey = `${generations.length}:${generations
    .map((generation) => generation.status)
    .join(",")}`;
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lastTimelineKey]);

  const submitErrorMessage = (code: string | null, details: unknown) => {
    const detailRecord = (details ?? {}) as Record<string, unknown>;
    switch (code) {
      case "CREDIT_BALANCE_INSUFFICIENT":
      case "CREDIT_COST_ALLOWANCE_INSUFFICIENT":
        return interpolateCopy(
          t("chat.imageGenerationErrorInsufficientCredits"),
          {
            required: Number(detailRecord.requiredCredits ?? pricing?.credits ?? 0),
            available: Number(detailRecord.availableCredits ?? 0),
          }
        );
      case "PLAN_DAILY_CREDIT_LIMIT_REACHED":
        return t("chat.imageGenerationErrorDailyLimit");
      case "IMAGE_CONCURRENCY_EXCEEDED":
        return t("chat.imageGenerationErrorConcurrency");
      case "PROVIDER_BUDGET_EXHAUSTED":
        return t("chat.imageGenerationErrorBudget");
      case "CONCURRENT_RESERVATION_CONFLICT":
        return t("chat.imageGenerationErrorConflict");
      case "IMAGE_PROMPT_TOO_LONG":
        return interpolateCopy(t("chat.imageGenerationPromptTooLong"), {
          max: IMAGE_PROMPT_MAX_TOKENS,
        });
      case "IMAGE_GENERATION_DISABLED":
        return t("chat.imageGenerationDisabledNotice");
      case "IMAGE_MODEL_SELECTION_INVALID":
        // Reachable with a selection this composer approved: a tab left open
        // across a deployment that lowered the limit, or a deploy landing
        // between render and submit. The generic "try again" was the defect --
        // retrying re-sends the same selection and fails identically, and the
        // user is never told what to change.
        return interpolateCopy(t("chat.imageGenerationErrorTooManyModels"), {
          max: reportedImageModelLimit(detailRecord.maxModels, maxModels),
        });
      case "PLAN_FEATURE_NOT_INCLUDED":
        return t("chat.imageGenerationPlanGateTitle");
      default:
        return t("chat.imageGenerationErrorGeneric");
    }
  };

  const canSubmit =
    flagEnabled &&
    planAllowsImageGeneration &&
    !isSubmitting &&
    !hasActiveGeneration &&
    !promptTooLong &&
    prompt.trim().length > 0 &&
    selectedModelIds.length > 0 &&
    !hasUnpricedSelection;

  // Seed ids that did not fit are announced the same way a restore's are: the
  // catalogue offered a model, the composer did not start with it, and
  // silently starting from a smaller set would look like the click was lost.
  const seedLimitNotice =
    seedLimitOutcome.excludedModelIds.length > 0
      ? interpolateCopy(t("chat.imageGenerationRestoreLimitExcluded"), {
          models: seedLimitOutcome.excludedModelIds
            .map((modelId) => imageModelName(modelId))
            .join(", "),
          max: maxModels,
        })
      : null;

  const restoreNotices = restoreOutcome
    ? [
        restoreOutcome.excludedModelIds.length > 0
          ? interpolateCopy(t("chat.imageGenerationRestoreExcluded"), {
              models: restoreOutcome.excludedModelIds
                .map((modelId) => imageModelName(modelId))
                .join(", "),
            })
          : null,
        restoreOutcome.limitExcludedModelIds.length > 0
          ? interpolateCopy(t("chat.imageGenerationRestoreLimitExcluded"), {
              models: restoreOutcome.limitExcludedModelIds
                .map((modelId) => imageModelName(modelId))
                .join(", "),
              max: maxModels,
            })
          : null,
        restoreOutcome.optionsConsistent
          ? null
          : t("chat.imageGenerationRestoreOptionsUnavailable"),
      ].filter((notice): notice is string => notice !== null)
    : [];

  // One chip, rendered identically whether it sits inline or inside the
  // picker. The compact mode moves a model between two containers; it must not
  // give it a different affordance, price or accessible name on the way.
  const modelChip = (model: ImageModelProfile) => {
    const selected = selectedModelIds.includes(model.id);
    const price = getImageModelPrice(model.id, quality, size);
    // At the limit, an unselected chip stays visible and focusable -- hiding
    // it or removing it from the tab order would cost the discovery the whole
    // inline row exists for. It is marked `aria-disabled` rather than
    // `disabled`: the element must still receive the activation so the reason
    // can be announced, which a `disabled` button never would.
    const limitReached = !selected && selectedModelIds.length >= maxModels;
    return (
      <button
        key={model.id}
        type="button"
        aria-pressed={selected}
        aria-disabled={limitReached || undefined}
        // The reason travels with the control, so a screen reader user meets
        // it on the chip rather than having to find the notice elsewhere.
        aria-describedby={limitReached ? MODEL_LIMIT_NOTICE_ID : undefined}
        data-testid={`image-model-${model.id}`}
        data-limit-reached={limitReached ? "true" : undefined}
        onClick={() => toggleModel(model.id)}
        className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
          selected
            ? "border-accent-image-400 bg-accent-image-50 text-accent-image-800 dark:border-accent-image-700 dark:bg-accent-image-950/30 dark:text-accent-image-200"
            : limitReached
              ? // Dashed edge and reduced contrast, not colour alone: the state
                // has to survive a monochrome or forced-colours rendering.
                "border-dashed border-zinc-300 bg-white text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-500"
              : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
        }`}
      >
        {/*
          The chip shows the short label and the accessible name keeps the full
          one: abbreviating the visual label must not abbreviate the model's
          identity.
        */}
        <span aria-hidden>{imageModelChipLabel(model)}</span>
        <span className="sr-only">{model.name}</span>
        {price && <CreditCostBadge credits={price.credits} size="xs" tone="plain" />}
      </button>
    );
  };

  const toggleModel = (modelId: string) => {
    const change = toggleImageModelSelection({
      selected: selectedModelIds,
      modelId,
      maxModels,
    });
    if (change.blockedByLimit) {
      // The selection is untouched: no automatic deselection, no silent swap
      // of an older choice. Only the reason appears.
      setLimitNotice(true);
      return;
    }
    composerTouchedRef.current = true;
    setRestoreOutcome(null);
    setLimitNotice(false);
    setSelectedModelIds(change.modelIds);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setSubmitError(null);
    // A download that failed a minute ago is not a fact about this request.
    setDownloadError(null);
    const requestPrompt = prompt.trim();
    try {
      const response = await fetch("/api/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: requestPrompt,
          size,
          quality,
          idempotencyKey: crypto.randomUUID(),
          modelIds: selectedModelIds,
          ...(conversationIdRef.current
            ? { conversationId: conversationIdRef.current }
            : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        generationId?: string;
        groupId?: string;
        conversationId?: string;
        status?: string;
        reservedCredits?: number;
        targets?: Array<{
          targetId: string;
          modelId: string;
          provider: string;
          generationId: string;
          status: string;
          reservedCredits: number;
        }>;
        code?: string;
        details?: unknown;
      } | null;
      if (!response.ok || !payload?.generationId || !payload.conversationId) {
        setSubmitError(submitErrorMessage(payload?.code ?? null, payload?.details));
        return;
      }
      if (!conversationIdRef.current) {
        conversationIdRef.current = payload.conversationId;
        onConversationCreated({
          id: payload.conversationId,
          title:
            requestPrompt.slice(0, 30) || t("chat.imageGenerationTitle"),
        });
      }
      // One optimistic card per target, so a two-model request shows two
      // pending cards immediately rather than one that later splits.
      const createdAt = new Date().toISOString();
      const targets =
        payload.targets && payload.targets.length > 0
          ? payload.targets
          : [
              {
                targetId: payload.generationId,
                modelId: selectedModelIds[0],
                provider: "openai",
                generationId: payload.generationId,
                status: payload.status ?? "pending",
                reservedCredits: payload.reservedCredits ?? 0,
              },
            ];
      for (const target of targets) {
        mergeGeneration({
          generationId: target.generationId,
          conversationId: payload.conversationId,
          status: target.status,
          prompt: requestPrompt,
          preset,
          size,
          reservedCredits: target.reservedCredits,
          refunded: false,
          publicErrorCode: null,
          createdAt,
          assets: [],
          provider: target.provider,
          modelId: target.modelId,
          groupId: payload.groupId ?? target.generationId,
          targetId: target.targetId,
          attemptNumber: 1,
        });
      }
      setPrompt("");
      notifyUserUsageChanged();
    } catch {
      setSubmitError(t("chat.imageGenerationErrorGeneric"));
    } finally {
      setIsSubmitting(false);
    }
  };
  const handleSubmitRef = useRef<(() => Promise<void>) | null>(null);
  // Kept current rather than listed as a dependency of the arrival effect: the
  // function is redefined on every render, and depending on it would re-run
  // the effect continuously. Written in an effect with no dependency array --
  // the "latest ref" idiom -- because a ref must not be assigned during render.
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  });

  /*
    The arrival that generates on its own.

    Everything about this is a guard, because it is the one path in the product
    where credits are spent without a click on the button that spends them.

      * armed by exactly one caller -- the chat handoff, on a request the user
        wrote in words -- and only for an account that turned the preference on
        beside the price;
      * fired at most once per mount, held by a ref rather than by the effect's
        dependencies: `canSubmit` flickers while the catalogue and the price
        resolve, and a dependency-guarded effect would fire again on the
        flicker;
      * conditional on the same `canSubmit` the button is, so a held price, an
        over-long prompt, a viewer without the plan and a request already in
        flight all refuse it exactly as they refuse a press;
      * spent either way. A landing that could not submit is consumed, not left
        armed to fire later when the user has changed the prompt to something
        else entirely.

    `void` rather than awaited: this is a fire-and-report path like the button's
    own handler, and `handleSubmit` reports its own failures on screen.
  */
  const autoGenerateSpentRef = useRef(false);
  useEffect(() => {
    if (!autoGenerateOnArrival || autoGenerateSpentRef.current) return;
    if (isSubmitting || hasActiveGeneration) return;
    // Still resolving. Not spent, because nothing was decided yet.
    if (selectedModelIds.length === 0 && !promptTooLong) return;
    autoGenerateSpentRef.current = true;
    onAutoGenerateArrivalConsumed?.();
    if (!canSubmit) return;
    void handleSubmitRef.current?.();
  }, [
    autoGenerateOnArrival,
    canSubmit,
    hasActiveGeneration,
    isSubmitting,
    promptTooLong,
    selectedModelIds.length,
    onAutoGenerateArrivalConsumed,
  ]);


  const handleRetryTarget = async (generation: GenerationView) => {
    const targetId = generation.targetId;
    if (!targetId || retryingTargetIds.includes(targetId)) return;
    setRetryingTargetIds((current) => [...current, targetId]);
    setSubmitError(null);
    try {
      const response = await fetch(`/api/images/targets/${targetId}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retryIdempotencyKey: crypto.randomUUID() }),
      });
      const payload = (await response.json().catch(() => null)) as {
        targets?: Array<{
          targetId: string;
          modelId: string;
          provider: string;
          generationId: string;
          status: string;
          reservedCredits: number;
        }>;
        groupId?: string;
        conversationId?: string;
        code?: string;
        details?: unknown;
      } | null;
      if (!response.ok || !payload?.targets?.length) {
        setSubmitError(submitErrorMessage(payload?.code ?? null, payload?.details));
        return;
      }
      const target = payload.targets[0];
      // The fresh attempt replaces the failed one in place: same target slot,
      // successes elsewhere in the group untouched (policy §11).
      setGenerations((current) =>
        current.filter((row) => row.targetId !== targetId)
      );
      mergeGeneration({
        generationId: target.generationId,
        conversationId: payload.conversationId ?? generation.conversationId,
        status: target.status,
        prompt: generation.prompt,
        preset: generation.preset,
        size: generation.size,
        reservedCredits: target.reservedCredits,
        refunded: false,
        publicErrorCode: null,
        createdAt: new Date().toISOString(),
        assets: [],
        provider: target.provider,
        modelId: target.modelId,
        groupId: payload.groupId ?? generation.groupId,
        targetId: target.targetId,
        attemptNumber: (generation.attemptNumber ?? 1) + 1,
      });
      notifyUserUsageChanged();
    } catch {
      setSubmitError(t("chat.imageGenerationErrorGeneric"));
    } finally {
      setRetryingTargetIds((current) =>
        current.filter((id) => id !== targetId)
      );
    }
  };

  /**
   * Saves the original as a file.
   *
   * Fetched and handed to the browser as a blob rather than linked, for the
   * reason lib/browserDownload.ts sets out: a link hands the whole outcome to
   * the browser, failures included, and a failure here would arrive as a
   * navigation away from the workspace. The name the server sent is used --
   * the fallback below only covers a response that carried none.
   */
  const handleDownload = async (
    generation: GenerationView,
    asset: { mimeType: string }
  ) => {
    if (downloadingIds.includes(generation.generationId)) return;
    setDownloadingIds((current) => [...current, generation.generationId]);
    setDownloadError(null);
    try {
      const response = await fetch(
        `/api/images/generations/${generation.generationId}/download`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        await discardResponseBody(response);
        setDownloadError(t("chat.imageGenerationDownloadFailed"));
        return;
      }
      await saveResponseAsFile(
        response,
        imageDownloadFilename({
          generationId: generation.generationId,
          modelId: generation.modelId,
          mimeType: asset.mimeType,
        })
      );
    } catch {
      setDownloadError(t("chat.imageGenerationDownloadFailed"));
    } finally {
      setDownloadingIds((current) =>
        current.filter((id) => id !== generation.generationId)
      );
    }
  };

  /**
   * "Full size", when the link behind it has already lapsed.
   *
   * The href stays the signed R2 URL, so the normal path is an ordinary link
   * and this does nothing. What it removes is the one outcome the user can
   * neither predict nor recover from: a signature expires after five minutes,
   * and a click after that navigated the whole workspace to an S3 error
   * document. The `<img>`'s `onError` repair never fired for it, because an
   * image that loaded while the URL was live goes on rendering from cache.
   *
   * So the click is refused, the reason is said out loud, and a fresh URL is
   * fetched. Re-opening is left to the user rather than done here: a
   * `window.open()` after an await is a popup, and browsers block it.
   */
  const handleOpenOriginal = useCallback(
    async (
      event: React.MouseEvent<HTMLAnchorElement>,
      generation: GenerationView,
      asset: GenerationAsset
    ) => {
      // In a useCallback rather than a plain arrow in the body, because
      // `Date.now()` is impure and the compiler cannot see that this only ever
      // runs from a click. The clock is genuinely needed here: pollClockMs
      // advances every 5s and only while something is generating, so a card
      // that finished ten minutes ago would be judged against a frozen time.
      if (!isImageAssetUrlExpired(asset.urlExpiresAt, Date.now())) return;
      event.preventDefault();
      // A dead link invites repeated clicking; one refresh at a time is enough.
      if (refreshingLinkIds.current.has(generation.generationId)) return;
      refreshingLinkIds.current.add(generation.generationId);
      dispatchAppToast(t("chat.imageGenerationOriginalLinkExpired"), "info");
      try {
        const refreshed = await refreshGeneration(generation.generationId);
        if (!refreshed) {
          dispatchAppToast(
            t("chat.imageGenerationOriginalLinkRefreshFailed"),
            "error"
          );
        }
      } finally {
        refreshingLinkIds.current.delete(generation.generationId);
      }
    },
    [refreshGeneration, t]
  );

  const handleAssetError = (generation: GenerationView) => {
    // Signed URLs live ~5 minutes; refresh once per generation, not per retry.
    if (refreshedAssetIds.current.has(generation.generationId)) return;
    refreshedAssetIds.current.add(generation.generationId);
    void refreshGeneration(generation.generationId);
  };

  const renderResult = (generation: GenerationView) => {
    if (generation.status === "failed") {
      const moderation =
        generation.publicErrorCode === "IMAGE_MODERATION_BLOCKED";
      return (
        <div
          data-testid="image-generation-failed"
          data-error-kind={moderation ? "moderation" : "generic"}
          data-refunded={generation.refunded ? "true" : "false"}
          className="flex items-start gap-2.5 rounded-2xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-semibold">
              {moderation
                ? t("chat.imageGenerationModerationBlocked")
                : t("chat.imageGenerationFailed")}
            </p>
            {generation.refunded && (
              <p className="mt-1 text-xs opacity-80">
                {t("chat.imageGenerationRefunded")}
              </p>
            )}
            {generation.targetId && (
              <button
                type="button"
                data-testid="image-generation-retry"
                onClick={() => void handleRetryTarget(generation)}
                disabled={
                  retryingTargetIds.includes(generation.targetId) ||
                  !planAllowsImageGeneration
                }
                className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-red-300 px-3 py-1.5 text-xs font-bold text-red-800 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:text-red-200 dark:hover:bg-red-950/50"
              >
                {retryingTargetIds.includes(generation.targetId) ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {t("chat.imageGenerationRetryModel")}
                {generation.reservedCredits !== null && (
                  <CreditCostBadge
                    credits={generation.reservedCredits}
                    size="xs"
                    tone="plain"
                  />
                )}
              </button>
            )}
          </div>
        </div>
      );
    }
    if (!isTerminal(generation.status)) {
      // Advanced by the 5s poll clock (render purity forbids Date.now()
      // here); past ~2.5 minutes the run has outlived a normal provider
      // round-trip, so say what happens next (the stale sweep fails and
      // fully refunds it) instead of spinning silently for the reclaim
      // window.
      const runningLong =
        pollClockMs > 0 &&
        pollClockMs - new Date(generation.createdAt).getTime() > 150_000;
      return (
        <div
          role="status"
          data-testid="image-generation-progress"
          data-running-long={runningLong ? "true" : "false"}
          className="flex items-center gap-2.5 rounded-2xl border border-accent-image-200 bg-accent-image-50 p-3.5 text-sm text-accent-image-800 dark:border-accent-image-900/60 dark:bg-accent-image-950/30 dark:text-accent-image-200"
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-semibold">{t("chat.imageGenerationGenerating")}</p>
            <p className="mt-0.5 text-xs opacity-80">
              {runningLong
                ? t("chat.imageGenerationTakingLong")
                : t("chat.imageGenerationGeneratingHint")}
            </p>
          </div>
        </div>
      );
    }
    const original = generation.assets.find((asset) => asset.role === "original");
    const thumbnail = generation.assets.find(
      (asset) => asset.role === "thumbnail"
    );
    const display = thumbnail ?? original;
    if (!display || !original) {
      // succeeded but the signed URLs have expired out of this payload --
      // the refresh path re-mints them.
      return (
        <div className="rounded-2xl border border-zinc-200 p-3.5 text-sm text-zinc-500 dark:border-zinc-800">
          {t("chat.imageGenerationHistoryError")}
        </div>
      );
    }
    return (
      <figure
        data-testid="image-generation-result"
        className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="relative bg-zinc-100 dark:bg-zinc-950">
          {/* eslint-disable-next-line @next/next/no-img-element -- signed R2
              URLs are short-lived and cross-origin; next/image optimization
              would proxy and cache them, defeating both. */}
          <img
            src={display.url}
            alt={`${t("chat.imageGenerationAiLabel")}: ${generation.prompt}`}
            className="mx-auto max-h-[26rem] w-auto max-w-full object-contain"
            onError={() => handleAssetError(generation)}
          />
          {/* Provenance label required by policy §9: visual + accessible. */}
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-zinc-950/70 px-2 py-0.5 text-[11px] font-semibold text-white">
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            {t("chat.imageGenerationAiLabel")}
          </span>
        </div>
        <figcaption className="flex flex-wrap items-center gap-2 border-t border-zinc-200 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          {generation.reservedCredits !== null && (
            <CreditCostBadge credits={generation.reservedCredits} size="xs" />
          )}
          {/*
            The pixel size the file actually is, not the one requested. They
            differ across providers for the same resolution tier (policy
            §12.1), so a comparison that showed the request would be showing
            the same number under two different images. Falls back to the
            requested size only for rows written before the header was read.
          */}
          <span data-testid="image-result-dimensions" className="font-mono">
            {generation.outputWidth && generation.outputHeight
              ? `${generation.outputWidth}x${generation.outputHeight}`
              : generation.size}
          </span>
          <span className="min-w-0 flex-1" />
          <a
            href={original.url}
            target="_blank"
            rel="noreferrer"
            data-testid="image-generation-open-original"
            onClick={(event) =>
              void handleOpenOriginal(event, generation, original)
            }
            className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 py-1 font-semibold text-accent-image-700 hover:bg-accent-image-50 dark:text-accent-image-300 dark:hover:bg-accent-image-950/40"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            {t("chat.imageGenerationOpenOriginal")}
          </a>
          {/*
            How long that link lasts, said before it matters rather than after.
            The number is IMAGE_ASSET_URL_TTL_MINUTES, the same constant the
            server signs with, so it cannot drift into a claim nothing backs.
            It is the link that expires, not the image: the card keeps
            rendering and the download button keeps working, which is why this
            sits on the link and not on the figure.
          */}
          <span
            data-testid="image-original-link-expiry"
            className="text-[11px] font-normal text-zinc-400 dark:text-zinc-500"
          >
            {interpolateCopy(t("chat.imageGenerationOriginalLinkExpiry"), {
              minutes: IMAGE_ASSET_URL_TTL_MINUTES,
            })}
          </span>
          {/*
            A button, not `<a href={original.url} download>`. The `download`
            attribute is same-origin-only and these URLs are R2's, so the
            browser ignored it and rendered the image instead of saving it.
            The route below is this application's own origin and answers
            `Content-Disposition: attachment` (docs/policy/image-generation.md
            §9.1); it also outlives the signed URL, which a link on a card left
            open for six minutes would not.
          */}
          <button
            type="button"
            data-testid="image-generation-download"
            onClick={() => void handleDownload(generation, original)}
            disabled={downloadingIds.includes(generation.generationId)}
            className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 py-1 font-semibold text-accent-image-700 transition hover:bg-accent-image-50 disabled:cursor-not-allowed disabled:opacity-60 dark:text-accent-image-300 dark:hover:bg-accent-image-950/40"
          >
            {downloadingIds.includes(generation.generationId) ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {t("chat.imageGenerationDownload")}
          </button>
        </figcaption>
      </figure>
    );
  };

  const gateNotice = !flagEnabled
    ? t("chat.imageGenerationDisabledNotice")
    : null;

  if (!planAllowsImageGeneration) {
    return (
      <div
        data-testid="image-generation-plan-gate"
        className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <span className="flex h-14 w-14 items-center justify-center rounded-3xl bg-accent-image-500/10 text-accent-image-500">
          <Crown className="h-6 w-6" aria-hidden="true" />
        </span>
        <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
          {t("chat.imageGenerationPlanGateTitle")}
        </h2>
        <p className="max-w-sm text-sm leading-6 text-zinc-600 dark:text-zinc-300">
          {t("chat.imageGenerationPlanGateBody")}
        </p>
        <Link
          href="/pricing"
          className="mt-1 rounded-xl bg-accent-image-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-accent-image-500"
        >
          {t("chat.imageGenerationPlanGateCta")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-950">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent-image-500/10 text-accent-image-500">
          <ImageIcon className="h-4 w-4" aria-hidden="true" />
        </span>
        <h1 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
          {t("chat.imageGenerationTitle")}
        </h1>
        {onCancelDraft && (
          <button
            type="button"
            data-testid="image-generation-cancel-draft"
            onClick={onCancelDraft}
            className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            {t("chat.imageGenerationBackToChat")}
          </button>
        )}
        <span
          data-testid="image-generation-model-summary"
          className="rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] font-semibold text-zinc-500 dark:border-zinc-800 dark:text-zinc-400"
        >
          {interpolateCopy(t("chat.imageGenerationModelCount"), {
            count: selectedModelIds.length,
          })}
        </span>
      </header>

      <div
        ref={listRef}
        data-testid="image-generation-timeline"
        className="min-h-0 flex-1 overflow-y-auto bg-zinc-100/80 px-4 py-4 dark:bg-zinc-950"
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          {historyError && (
            <p className="rounded-2xl border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              {t("chat.imageGenerationHistoryError")}
            </p>
          )}
          {generations.length === 0 && !historyError && (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-3xl bg-accent-image-500/10 text-accent-image-500">
                <ImageIcon className="h-5 w-5" aria-hidden="true" />
              </span>
              <h2 className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                {t("chat.imageGenerationIntroTitle")}
              </h2>
              <p className="max-w-sm text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                {t("chat.imageGenerationIntroBody")}
              </p>
            </div>
          )}
          {groups.map((group) => (
            <article
              key={group.groupId}
              data-testid="image-generation-entry"
              data-target-count={group.targets.length}
              className="flex flex-col gap-2"
            >
              <p className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-zinc-900 px-3.5 py-2.5 text-sm text-white dark:bg-zinc-100 dark:text-zinc-950">
                {group.prompt}
              </p>
              {/*
                One column per model on a wide screen, stacked on a narrow
                one. Stacking rather than tabbing keeps every result reachable
                by one vertical scroll and avoids a second navigation model on
                mobile; horizontal overflow is never introduced.
              */}
              <div
                data-testid="image-comparison-grid"
                className={`grid gap-3 ${
                  group.targets.length > 1 ? "sm:grid-cols-2" : "grid-cols-1"
                }`}
              >
                {group.targets.map((generation) => (
                  <section
                    key={generation.targetId ?? generation.generationId}
                    data-testid="image-comparison-card"
                    data-model-id={generation.modelId ?? ""}
                    className="flex min-w-0 flex-col gap-1.5"
                  >
                    {group.targets.length > 1 && (
                      <p className="truncate text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
                        {imageModelName(generation.modelId)}
                      </p>
                    )}
                    {renderResult(generation)}
                  </section>
                ))}
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="shrink-0 border-t border-zinc-200 bg-white px-4 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2.5">
          {(submitError || downloadError || gateNotice) && (
            <p
              role="alert"
              data-testid="image-generation-error"
              className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
            >
              {submitError ?? downloadError ?? gateNotice}
            </p>
          )}
          {/*
            Why the composer did not come back exactly as the last comparison
            left it. Stated rather than silently applied: a selection that
            quietly differs from the one the user last made is the failure this
            whole restore path exists to end.
          */}
          {(restoreNotices.length > 0 || seedLimitNotice) && (
            <p
              data-testid="image-generation-restore-notice"
              className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300"
            >
              {[seedLimitNotice, ...restoreNotices]
                .filter((notice): notice is string => Boolean(notice))
                .join(" ")}
            </p>
          )}
          {/*
            Model selection sits above the textarea so the price the composer
            quotes is decided before the prompt is written. Its own row --
            never sharing the textarea's row (mobile composer contract).
          */}
          <div
            data-testid="image-model-picker"
            role="group"
            aria-label={t("chat.imageGenerationModelLabel")}
            className="flex w-full flex-wrap items-center gap-1.5"
          >
            {inlineModels.map((model) => modelChip(model))}
            {compactPicker && pickerModels.length > 0 && (
              <button
                type="button"
                data-testid="image-model-picker-toggle"
                aria-expanded={pickerOpen}
                aria-controls="image-model-picker-panel"
                onClick={() => setPickerOpen((open) => !open)}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-dashed border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                {pickerOpen
                  ? t("chat.imageGenerationMoreModelsHide")
                  : interpolateCopy(t("chat.imageGenerationMoreModels"), {
                      count: pickerModels.length,
                    })}
              </button>
            )}
            {/*
              How many of how many, always -- not only once the ceiling is hit.
              A count that appears at the limit tells the user about the rule
              at the moment it is already inconvenient; a count that is always
              there is how they knew the rule before choosing.
            */}
            <span
              data-testid="image-model-selection-count"
              className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400"
            >
              {interpolateCopy(t("chat.imageGenerationSelectionCount"), {
                count: selectedModelIds.length,
                max: maxModels,
              })}
            </span>
            {selectedModelIds.length > 1 && (
              <span
                data-testid="image-total-credits"
                className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400"
              >
                {interpolateCopy(t("chat.imageGenerationTotalCredits"), {
                  credits: totalCredits,
                })}
              </span>
            )}
          </div>
          {/*
            Rendered whenever the ceiling is reached, not only after a refused
            click, so it is already on screen as the `aria-describedby` target
            of every chip that cannot be selected. `role="status"` rather than
            `alert`: reaching a documented limit is a state, and an assertive
            interruption on every third selection would be hostile.
          */}
          {(limitNotice || selectedModelIds.length >= maxModels) && (
            <p
              id={MODEL_LIMIT_NOTICE_ID}
              role="status"
              data-testid="image-model-limit-notice"
              className="rounded-xl border border-accent-image-200 bg-accent-image-50 px-3 py-2 text-xs leading-5 font-semibold text-accent-image-800 dark:border-accent-image-800 dark:bg-accent-image-950/30 dark:text-accent-image-200"
            >
              {interpolateCopy(t("chat.imageGenerationModelLimitNotice"), {
                max: maxModels,
              })}
            </p>
          )}
          {/*
            The unselected models, in their own row in normal flow. Never
            absolutely positioned or floated: the mobile composer contract
            forbids any control overlapping the textarea's row, and a panel
            that opens over it would do exactly that.
          */}
          {compactPicker && pickerOpen && pickerModels.length > 0 && (
            <div
              id="image-model-picker-panel"
              data-testid="image-model-picker-panel"
              role="group"
              aria-label={t("chat.imageGenerationOtherModelsLabel")}
              className="flex w-full flex-wrap items-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/60"
            >
              {pickerModels.map((model) => modelChip(model))}
            </div>
          )}
          {/* Composer contract shape: the textarea owns this full-width row. */}
          <div data-testid="image-composer-textarea-row" className="w-full">
            <textarea
              data-testid="image-generation-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              // The same Enter contract as every chat textarea, through the
              // same helper (policy §1 keeps ChatInput itself out of an image
              // conversation, but the keyboard rule is not chat-specific).
              // Desktop Enter submits, Shift+Enter breaks the line, mobile
              // Enter always breaks and only Ctrl/Cmd+Enter submits.
              //
              // Ctrl/Cmd+Enter already submitted here, and still does, so no
              // existing habit breaks -- desktop Enter is the only addition.
              // What is genuinely new is the IME guard: this composer was safe
              // only by accident, because a composition-confirming Enter
              // carries no modifier. Enter submitting makes that accident
              // load-bearing, so it stops being an accident.
              //
              // The case the guard actually defends is a candidate-selection
              // IME -- Pinyin, Japanese -- where the first Enter picks a
              // candidate and must not also send. This comment used to name
              // Korean as the example; a measurement on 2026-08-15 (Windows,
              // Chrome, Microsoft Korean IME) found no guard signal there at
              // all, because `compositionend` fires before the Enter keydown
              // and that keydown reports `isComposing: false, keyCode: 13`.
              // See .github/audits/ime-enter-observation-2026-08-15.md. That
              // is an observation about one environment, not a rule: the
              // invariant in lib/chatKeyboardPolicy.ts is unchanged.
              onKeyDown={(event) => {
                const action = getChatEnterKeyAction(
                  event,
                  isComposingKeydown(event),
                  isMobileShell
                );
                if (action !== "submit") return;
                event.preventDefault();
                void handleSubmit();
              }}
              placeholder={t("chat.imageGenerationPromptPlaceholder")}
              disabled={!flagEnabled}
              rows={2}
              className="max-h-40 min-h-[3.25rem] w-full resize-y rounded-2xl border border-zinc-200 bg-white px-3.5 py-2.5 text-base text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-accent-image-400 focus:ring-2 focus:ring-accent-image-500/20 disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 sm:text-sm"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <div
              role="radiogroup"
              aria-label={t("chat.imageGenerationPresetLabel")}
              className="flex flex-wrap gap-1.5"
            >
              {IMAGE_PRESETS.map((option) => {
                const optionPricing = getImageGenerationPricing(
                  IMAGE_QUALITY_BY_PRESET[option.preset],
                  size
                );
                const selected = preset === option.preset;
                return (
                  <button
                    key={option.preset}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid={`image-preset-${option.preset}`}
                    title={t(option.hintKey)}
                    onClick={() => {
                      composerTouchedRef.current = true;
                      setRestoreOutcome(null);
                      setPreset(option.preset);
                    }}
                    className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                      selected
                        ? "border-accent-image-400 bg-accent-image-50 text-accent-image-800 dark:border-accent-image-700 dark:bg-accent-image-950/30 dark:text-accent-image-200"
                        : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    }`}
                  >
                    {t(option.labelKey)}
                    {optionPricing && (
                      <CreditCostBadge
                        credits={optionPricing.credits}
                        size="xs"
                        tone="plain"
                      />
                    )}
                  </button>
                );
              })}
            </div>
            <span className="mx-1 hidden h-4 w-px bg-zinc-200 dark:bg-zinc-800 sm:block" />
            <div
              role="radiogroup"
              aria-label={t("chat.imageGenerationSizeLabel")}
              className="flex flex-wrap gap-1.5"
            >
              {IMAGE_SIZES.map((option) => {
                const selected = size === option.size;
                return (
                  <button
                    key={option.size}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid={`image-size-${option.size}`}
                    onClick={() => {
                      composerTouchedRef.current = true;
                      setRestoreOutcome(null);
                      setSize(option.size);
                    }}
                    className={`inline-flex min-h-9 items-center rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                      selected
                        ? "border-accent-image-400 bg-accent-image-50 text-accent-image-800 dark:border-accent-image-700 dark:bg-accent-image-950/30 dark:text-accent-image-200"
                        : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
                    }`}
                  >
                    {t(option.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="image-token-estimate"
              data-over-limit={promptTooLong ? "true" : "false"}
              className={`text-[11px] font-medium ${
                promptTooLong
                  ? "font-semibold text-red-600 dark:text-red-400"
                  : "text-zinc-400 dark:text-zinc-500"
              }`}
            >
              {interpolateCopy(t("chat.imageGenerationTokenEstimate"), {
                tokens: estimatedTokens,
                max: IMAGE_PROMPT_MAX_TOKENS,
              })}
            </span>
            {promptTooLong && (
              <span className="text-[11px] font-semibold text-red-600 dark:text-red-400">
                {interpolateCopy(t("chat.imageGenerationPromptTooLong"), {
                  max: IMAGE_PROMPT_MAX_TOKENS,
                })}
              </span>
            )}
            <span className="min-w-0 flex-1" />
            {/*
              "Stop asking me", and the only place it can be set.

              Beside the price on purpose. The workspace contract requires the
              price to be quoted before submission, and this is what keeps that
              true once a press can submit on its own: the choice to stop being
              asked can only be made by someone who is looking at what a
              request costs. Putting it in an account settings page would move
              it away from the number it is a decision about.

              It stays rendered while a generation is running, so the account
              that has just watched a press spend credits can turn it off in
              the same place it turned it on -- and only for a viewer who can
              actually generate, because for anyone else it would be a control
              over something they cannot do.
            */}
            {planAllowsImageGeneration && onAutoGeneratePreferenceChange && (
              <label
                data-testid="image-generation-auto-generate-toggle"
                className="inline-flex cursor-pointer items-center gap-2 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer rounded border-zinc-300 text-accent-image-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-image-500 dark:border-zinc-600"
                  checked={autoGeneratePreference}
                  onChange={(event) =>
                    onAutoGeneratePreferenceChange(event.target.checked)
                  }
                />
                {t("chat.imageGenerationAutoGenerateLabel")}
              </label>
            )}
            {/*
              While a comparison is running the button IS the progress: a
              separate sentence beside a button that still reads "Generate" at
              full contrast said the same thing twice and left it ambiguous
              whether the button could be clicked. The sentence stays in the
              accessibility tree -- the same idiom the comparison action rail
              uses -- because a screen reader gets no signal from a spinner.
            */}
            {hasActiveGeneration && (
              <span
                data-testid="image-generation-busy-status"
                className="sr-only"
                role="status"
              >
                {t("chat.imageGenerationBusy")}
              </span>
            )}
            <button
              type="button"
              data-testid="image-generation-submit"
              data-generating={hasActiveGeneration ? "true" : "false"}
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-accent-image-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-accent-image-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting || hasActiveGeneration ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-4 w-4" aria-hidden="true" />
              )}
              {hasActiveGeneration
                ? interpolateCopy(t("chat.imageGenerationGeneratingModels"), {
                    count: activeTargetCount,
                  })
                : t("chat.imageGenerationGenerate")}
              {/*
                The price belongs to a request the user can still start. While
                one is running it describes nothing on screen.
              */}
              {!hasActiveGeneration && totalCredits > 0 && (
                <CreditCostBadge
                  credits={totalCredits}
                  size="xs"
                  tone="onColor"
                />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
