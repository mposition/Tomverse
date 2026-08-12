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
  listEnabledImageModels,
} from "@/lib/imageModelRegistry";

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

type GenerationAsset = { role: string; mimeType: string; url: string };

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
  /** Present only when there is a chat draft to go back to. */
  onCancelDraft?: () => void;
};

export function ImageGenerationWorkspace({
  conversationId,
  onConversationCreated,
  flagEnabled,
  planAllowsImageGeneration,
  initialPrompt = "",
  initialModelIds,
  onCancelDraft,
}: ImageGenerationWorkspaceProps) {
  const { t } = useLanguage();
  const isMobileShell = useIsMobileShell();
  const [generations, setGenerations] = useState<GenerationView[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [preset, setPreset] = useState<ImagePreset>("standard");
  const [size, setSize] = useState<ImageSize>("1024x1024");
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(() => {
    const enabled = new Set(listEnabledImageModels().map((model) => model.id));
    const seeded = (initialModelIds ?? []).filter((modelId) =>
      enabled.has(modelId)
    );
    return seeded.length > 0 ? [...new Set(seeded)] : [DEFAULT_IMAGE_MODEL_ID];
  });
  // Set the moment the user touches a model, quality or size. A restore
  // answer that arrives after that is discarded: the read describes the last
  // comparison, and the user's newer choice is the one that should win a race
  // with the network.
  const composerTouchedRef = useRef(false);
  // The restore's *outcome*, not its copy: rendering the sentences here would
  // pull `t` into the history-load effect and re-run the fetch on a language
  // change. Stored structurally, the notice simply follows the language.
  const [restoreOutcome, setRestoreOutcome] = useState<{
    excludedModelIds: string[];
    optionsConsistent: boolean;
  } | null>(null);
  const [retryingTargetIds, setRetryingTargetIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // The poll loop's wall clock, read at render time in place of Date.now().
  const [pollClockMs, setPollClockMs] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const refreshedAssetIds = useRef(new Set<string>());
  // The id may arrive mid-flight via onConversationCreated; the ref keeps the
  // poll loop reading the current value without re-arming the effect.
  const conversationIdRef = useRef<string | null>(conversationId);

  const quality = IMAGE_QUALITY_BY_PRESET[preset];
  const pricing = getImageGenerationPricing(quality, size);
  const availableModels = useMemo(() => listEnabledImageModels(), []);
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
        if (!response.ok) throw new Error(`status ${response.status}`);
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
          setSelectedModelIds(restore.modelIds);
          // Options come back only when every target of the last comparison
          // agreed on them. A disagreement is a bug, not a preference, so the
          // composer keeps its safe defaults and says the options were not
          // restored rather than presenting one target's values as the user's.
          if (restore.preset) setPreset(restore.preset);
          if (restore.size) setSize(restore.size);
          setRestoreOutcome({
            excludedModelIds: restore.excludedModelIds,
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
        if (!response.ok) return null;
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
        if (!response.ok) return null;
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

  const restoreNotices = restoreOutcome
    ? [
        restoreOutcome.excludedModelIds.length > 0
          ? interpolateCopy(t("chat.imageGenerationRestoreExcluded"), {
              models: restoreOutcome.excludedModelIds
                .map((modelId) => imageModelName(modelId))
                .join(", "),
            })
          : null,
        restoreOutcome.optionsConsistent
          ? null
          : t("chat.imageGenerationRestoreOptionsUnavailable"),
      ].filter((notice): notice is string => notice !== null)
    : [];

  const toggleModel = (modelId: string) => {
    composerTouchedRef.current = true;
    setRestoreOutcome(null);
    setSelectedModelIds((current) => {
      if (current.includes(modelId)) {
        // Never empty: deselecting the last model would leave a composer that
        // looks ready and refuses on submit.
        return current.length === 1
          ? current
          : current.filter((id) => id !== modelId);
      }
      return [...current, modelId];
    });
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setSubmitError(null);
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
            className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 py-1 font-semibold text-accent-image-700 hover:bg-accent-image-50 dark:text-accent-image-300 dark:hover:bg-accent-image-950/40"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            {t("chat.imageGenerationOpenOriginal")}
          </a>
          <a
            href={original.url}
            download
            className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 py-1 font-semibold text-accent-image-700 hover:bg-accent-image-50 dark:text-accent-image-300 dark:hover:bg-accent-image-950/40"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            {t("chat.imageGenerationDownload")}
          </a>
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
          {(submitError || gateNotice) && (
            <p
              role="alert"
              data-testid="image-generation-error"
              className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
            >
              {submitError ?? gateNotice}
            </p>
          )}
          {/*
            Why the composer did not come back exactly as the last comparison
            left it. Stated rather than silently applied: a selection that
            quietly differs from the one the user last made is the failure this
            whole restore path exists to end.
          */}
          {restoreNotices.length > 0 && (
            <p
              data-testid="image-generation-restore-notice"
              className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300"
            >
              {restoreNotices.join(" ")}
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
            {availableModels.map((model) => {
              const selected = selectedModelIds.includes(model.id);
              const price = getImageModelPrice(model.id, quality, size);
              return (
                <button
                  key={model.id}
                  type="button"
                  aria-pressed={selected}
                  data-testid={`image-model-${model.id}`}
                  onClick={() => toggleModel(model.id)}
                  className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                    selected
                      ? "border-accent-image-400 bg-accent-image-50 text-accent-image-800 dark:border-accent-image-700 dark:bg-accent-image-950/30 dark:text-accent-image-200"
                      : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  }`}
                >
                  {/*
                    The chip shows the short label and the accessible name
                    keeps the full one: abbreviating the visual label must not
                    abbreviate the model's identity.
                  */}
                  <span aria-hidden>{imageModelChipLabel(model)}</span>
                  <span className="sr-only">{model.name}</span>
                  {price && (
                    <CreditCostBadge credits={price.credits} size="xs" tone="plain" />
                  )}
                </button>
              );
            })}
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
              // only by accident, because a Korean composition-confirming
              // Enter carries no modifier. Enter submitting makes that
              // accident load-bearing, so it stops being an accident.
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
