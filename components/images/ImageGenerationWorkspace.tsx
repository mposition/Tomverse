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
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { useLanguage } from "@/components/LanguageProvider";
import { notifyUserUsageChanged } from "@/components/chat/useUserUsage";
import { estimatePromptTokens } from "@/lib/chatTokenEstimate";
import {
  getImageGenerationPricing,
  IMAGE_GENERATION_MODEL_ID,
  IMAGE_PROMPT_MAX_TOKENS,
  IMAGE_QUALITY_BY_PRESET,
  type ImagePreset,
  type ImageSize,
} from "@/lib/imageGenerationPricing";

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
};

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
};

export function ImageGenerationWorkspace({
  conversationId,
  onConversationCreated,
  flagEnabled,
  planAllowsImageGeneration,
}: ImageGenerationWorkspaceProps) {
  const { t } = useLanguage();
  const [generations, setGenerations] = useState<GenerationView[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [preset, setPreset] = useState<ImagePreset>("standard");
  const [size, setSize] = useState<ImageSize>("1024x1024");
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
  const estimatedTokens = useMemo(
    () => (prompt.trim() ? estimatePromptTokens(prompt) : 0),
    [prompt]
  );
  const promptTooLong = estimatedTokens > IMAGE_PROMPT_MAX_TOKENS;
  const hasActiveGeneration = generations.some(
    (generation) => !isTerminal(generation.status)
  );

  const mergeGeneration = useCallback((incoming: GenerationView) => {
    setGenerations((current) => {
      const index = current.findIndex(
        (generation) => generation.generationId === incoming.generationId
      );
      if (index === -1) return [...current, incoming];
      const next = [...current];
      // A poll answer can race a fresher one; never move a terminal row back.
      if (isTerminal(next[index].status) && !isTerminal(incoming.status)) {
        return current;
      }
      next[index] = { ...next[index], ...incoming };
      return next;
    });
  }, []);

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
        };
        if (cancelled) return;
        setGenerations(payload.generations);
      } catch {
        if (!cancelled) setHistoryError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const refreshGeneration = useCallback(
    async (generationId: string) => {
      try {
        const response = await fetch(
          `/api/images/generations/${generationId}`,
          { cache: "no-store" }
        );
        if (!response.ok) return null;
        const payload = (await response.json()) as GenerationView;
        mergeGeneration(payload);
        return payload;
      } catch {
        return null;
      }
    },
    [mergeGeneration]
  );

  // Poll every active generation until it settles, then refresh the credit
  // displays once. 45 minutes is the server's own stale ceiling; polling
  // simply continues until the reconciliation sweep fails the row.
  useEffect(() => {
    if (!hasActiveGeneration) return;
    const timer = setInterval(async () => {
      setPollClockMs(Date.now());
      const active = generations.filter(
        (generation) => !isTerminal(generation.status)
      );
      for (const generation of active) {
        const updated = await refreshGeneration(generation.generationId);
        if (updated && isTerminal(updated.status)) {
          notifyUserUsageChanged();
        }
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [generations, hasActiveGeneration, refreshGeneration]);

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
    pricing !== null;

  const handleSubmit = async () => {
    if (!canSubmit || !pricing) return;
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
          ...(conversationIdRef.current
            ? { conversationId: conversationIdRef.current }
            : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        generationId?: string;
        conversationId?: string;
        status?: string;
        reservedCredits?: number;
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
      mergeGeneration({
        generationId: payload.generationId,
        conversationId: payload.conversationId,
        status: payload.status ?? "pending",
        prompt: requestPrompt,
        preset,
        size,
        reservedCredits: payload.reservedCredits ?? pricing.credits,
        refunded: false,
        publicErrorCode: null,
        createdAt: new Date().toISOString(),
        assets: [],
      });
      setPrompt("");
      notifyUserUsageChanged();
    } catch {
      setSubmitError(t("chat.imageGenerationErrorGeneric"));
    } finally {
      setIsSubmitting(false);
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
          <span className="font-mono">{generation.size}</span>
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
        <span className="rounded-full border border-zinc-200 px-2 py-0.5 font-mono text-[11px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          {IMAGE_GENERATION_MODEL_ID}
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
          {generations.map((generation) => (
            <article
              key={generation.generationId}
              data-testid="image-generation-entry"
              className="flex flex-col gap-2"
            >
              <p className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-zinc-900 px-3.5 py-2.5 text-sm text-white dark:bg-zinc-100 dark:text-zinc-950">
                {generation.prompt}
              </p>
              {renderResult(generation)}
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
          {/* Composer contract shape: the textarea owns this full-width row. */}
          <div data-testid="image-composer-textarea-row" className="w-full">
            <textarea
              data-testid="image-generation-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey)
                ) {
                  event.preventDefault();
                  void handleSubmit();
                }
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
                    onClick={() => setPreset(option.preset)}
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
                    onClick={() => setSize(option.size)}
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
            {hasActiveGeneration && (
              <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                {t("chat.imageGenerationBusy")}
              </span>
            )}
            <button
              type="button"
              data-testid="image-generation-submit"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-accent-image-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-accent-image-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-4 w-4" aria-hidden="true" />
              )}
              {t("chat.imageGenerationGenerate")}
              {pricing && (
                <CreditCostBadge
                  credits={pricing.credits}
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
