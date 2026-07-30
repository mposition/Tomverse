"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Info, RefreshCw, Shuffle } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { useIsMobileShell } from "@/components/chat/useIsMobileShell";

type PublicModelStatus = "available" | "limited" | "unavailable";

// RECON-OPS-001: how healthy the replacements offered for this model are
// right now. "degraded" means every candidate is itself limited, "none" that
// there is no usable candidate at all, "unknown" that provider health could
// not be read -- all three have to be said out loud rather than rendered as a
// bare list that reads like a safe swap.
type FallbackHealth = "operational" | "degraded" | "none" | "unknown";

type PublicModelStatusRecord = {
  id: string;
  provider: string;
  status: PublicModelStatus;
  fallbackModelIds: string[];
  fallbackHealth: FallbackHealth;
};

type ProviderStatusBannerProps = {
  selectedModels?: string[];
  compact?: boolean;
  onToggleModel?: (modelId: string) => void;
  onSwapModel?: (removeModelId: string, addModelId: string) => void;
};

export function ProviderStatusBanner({
  selectedModels = [],
  compact = false,
  onToggleModel,
  onSwapModel,
}: ProviderStatusBannerProps) {
  const { models: AVAILABLE_MODELS, publicModels: PUBLIC_MODELS } = useModelCatalog();
  const PUBLIC_MODEL_IDS = useMemo(
    () => new Set(PUBLIC_MODELS.map((model) => model.id)),
    [PUBLIC_MODELS]
  );
  const modelName = useCallback(
    (id: string) => AVAILABLE_MODELS.find((model) => model.id === id)?.name || id,
    [AVAILABLE_MODELS]
  );
  const { t } = useLanguage();
  // UI-TOUCH-001. `compact` is a density flag both shells set, so it cannot
  // decide touch sizing on its own -- the desktop workspace renders this same
  // compact banner. The 44px floor keys off the shell signal the composer
  // already uses for exactly this (see ChatInput's isMobileShell branches), so
  // phones get a real tap target and the desktop keeps its mouse-sized one.
  const isMobileShell = useIsMobileShell();
  const [models, setModels] = useState<PublicModelStatusRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadStatus = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/models/status", {
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = (await response.json()) as { models?: unknown };
      if (!Array.isArray(data.models)) return;

      setModels(
        data.models
          .map((item) => {
            const record = item as {
              id?: unknown;
              provider?: unknown;
              status?: unknown;
              fallbackModelIds?: unknown;
              fallbackHealth?: unknown;
            };
            if (
              typeof record.id !== "string" ||
              typeof record.provider !== "string" ||
              (record.status !== "available" &&
                record.status !== "limited" &&
                record.status !== "unavailable") ||
              !PUBLIC_MODEL_IDS.has(record.id)
            ) {
              return null;
            }
            return {
              id: record.id,
              provider: record.provider,
              status: record.status,
              fallbackModelIds: Array.isArray(record.fallbackModelIds)
                ? record.fallbackModelIds
                    .filter((id): id is string => typeof id === "string")
                    .filter((id) => PUBLIC_MODEL_IDS.has(id))
                    .slice(0, 3)
                : [],
              fallbackHealth:
                record.fallbackHealth === "operational" ||
                record.fallbackHealth === "degraded" ||
                record.fallbackHealth === "none"
                  ? record.fallbackHealth
                  : "unknown",
            };
          })
          .filter((item): item is PublicModelStatusRecord => Boolean(item))
      );
    } finally {
      setIsLoading(false);
    }
  }, [PUBLIC_MODEL_IDS]);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void loadStatus(), 0);
    const timer = window.setInterval(() => void loadStatus(), 300_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [loadStatus]);

  const bannerState = useMemo(() => {
    const selectedSet = new Set(selectedModels);
    const unavailable = models.filter((model) => model.status === "unavailable");
    const selectedUnavailable =
      selectedSet.size > 0
        ? unavailable.filter((model) => selectedSet.has(model.id))
        : [];
    const isSelectedOnly = selectedUnavailable.length > 0;
    const visibleUnavailable = isSelectedOnly ? selectedUnavailable : unavailable;
    const fallbackIds = Array.from(
      new Set(visibleUnavailable.flatMap((model) => model.fallbackModelIds))
    )
      .filter((id) => !selectedSet.has(id))
      .slice(0, 3);

    // When the impacted model is actually one of the user's selections, each
    // gets its own 1:1 replacement pick instead of the flattened fallbackIds
    // list above -- that's what lets the banner call onSwapModel(impacted,
    // suggestion) so it works even when selectedModels is already at the cap
    // (a plain "add" would silently no-op there instead).
    const swapSuggestions = isSelectedOnly
      ? selectedUnavailable
          .map((model) => ({
            removeModelId: model.id,
            addModelId: model.fallbackModelIds.find((id) => !selectedSet.has(id)),
          }))
          .filter(
            (suggestion): suggestion is { removeModelId: string; addModelId: string } =>
              Boolean(suggestion.addModelId)
          )
          .slice(0, 3)
      : [];

    // The caveat has to describe the models actually on offer, so it is the
    // worst health among the impacted models that contributed one. With no
    // candidate left the banner says so instead of falling back to the
    // generic "try again later", which hid that every alternative was out.
    const contributing = visibleUnavailable.filter((model) =>
      model.fallbackModelIds.some((id) => fallbackIds.includes(id))
    );
    const fallbackHealth: FallbackHealth =
      fallbackIds.length === 0
        ? "none"
        : contributing.some((model) => model.fallbackHealth === "unknown")
          ? "unknown"
          : contributing.every((model) => model.fallbackHealth === "degraded")
            ? "degraded"
            : "operational";

    return {
      impacted: visibleUnavailable,
      fallbackIds,
      fallbackHealth,
      swapSuggestions,
      isSelectedOnly,
    };
  }, [models, selectedModels]);

  if (models.length === 0) return null;

  const impactedCount = bannerState.impacted.length;
  if (impactedCount === 0) return null;

  // Never silent about a suggestion the snapshot itself says is shaky.
  const fallbackCaveat =
    bannerState.fallbackHealth === "degraded"
      ? t("providerStatus.fallbackDegraded")
      : bannerState.fallbackHealth === "unknown" && bannerState.fallbackIds.length > 0
        ? t("providerStatus.fallbackUnverified")
        : bannerState.fallbackHealth === "none"
          ? t("providerStatus.tryLater")
          : "";

  const title = bannerState.isSelectedOnly
    ? t("providerStatus.selectedIssue")
    : t("providerStatus.globalIssue");

  // RECON-OPS-002. The count is one whole translated sentence rather than a
  // number glued to the word "unavailable": assembled from fragments it read
  // as a bare tally next to a row of N suggestion buttons, so "6 unavailable"
  // looked like it was counting the buttons. A full sentence also lets each
  // language pick its own word order and counter unit.
  const unavailableCountLabel = (
    impactedCount === 1
      ? t("providerStatus.unavailableCountOne")
      : t("providerStatus.unavailableCount")
  ).replace("{count}", String(impactedCount));

  // Which action shape this banner offers has to be known before the guidance
  // sentence is written, because that sentence may only promise a replacement
  // when a button actually offers one. Swap wins when it applies: it is the
  // only variant that still works at the selection cap.
  const swapActions = onSwapModel ? bannerState.swapSuggestions : [];
  const fallbackActions =
    swapActions.length > 0 ? [] : onToggleModel ? bannerState.fallbackIds : [];
  const hasFallbackActions = swapActions.length + fallbackActions.length > 0;

  // The suggested model names live in the buttons and nowhere else. This line
  // used to be "Try: A, B, C" directly above buttons A, B, C, which read as
  // two separate offers and left the outage count competing with a second,
  // unlabelled quantity.
  const fallbackGuidance = hasFallbackActions
    ? t("providerStatus.fallbackIntro")
    : t("providerStatus.noHealthyFallback");

  const switchToLabel = (modelId: string) =>
    t("providerStatus.switchToModel").replace("{model}", modelName(modelId));
  const switchFromToLabel = (removeModelId: string, addModelId: string) =>
    t("providerStatus.switchFromTo")
      .replace("{from}", modelName(removeModelId))
      .replace("{to}", modelName(addModelId));

  if (compact) {
    return (
      <div
        className="mx-3 mt-2 rounded-2xl border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-800 shadow-sm dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
        role="status"
        aria-live="polite"
        data-testid="provider-outage-banner"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            {/*
              Wraps rather than truncates. Measured on the compact banner at
              320px the title had 198px to work with and `truncate` hid 98px of
              it -- "Some models are temporarily unavai..." -- so the one
              sentence stating what is wrong was the first thing to go. The
              count keeps `shrink-0` so it drops to its own line intact instead
              of clipping its own sentence.
            */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-bold">
              <span data-testid="provider-status-title">{title}</span>
              <span
                className="shrink-0 rounded-full bg-black/5 px-2 py-0.5 text-[11px] dark:bg-white/10"
                data-testid="provider-status-count"
              >
                {unavailableCountLabel}
              </span>
            </div>
            <p
              className="mt-0.5 text-[11px] font-medium opacity-80"
              data-testid="provider-status-guidance"
            >
              {fallbackGuidance}
              {fallbackCaveat ? ` ${fallbackCaveat}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadStatus()}
            // The icon itself stays 16px: only the box around it grows.
            className={`flex shrink-0 items-center justify-center rounded-xl bg-black/5 transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15 ${
              isMobileShell ? "h-11 w-11" : "h-8 w-8"
            }`}
            data-testid="provider-status-refresh"
            aria-label={t("providerStatus.refresh")}
          >
            {isLoading ? (
              <Info className="h-4 w-4 animate-pulse" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </button>
        </div>
        {onSwapModel && swapActions.length > 0 ? (
          <div className="mt-1.5 flex gap-1.5 overflow-x-auto overscroll-x-contain pb-0.5">
            {swapActions.map(({ removeModelId, addModelId }) => (
              <button
                key={removeModelId}
                type="button"
                onClick={() => onSwapModel(removeModelId, addModelId)}
                data-testid="provider-status-swap"
                // A real box rather than a pseudo-element inset: these chips
                // sit 6px apart in a scrolling row, so an inset large enough
                // to reach 44px would overlap the next chip's tap area and
                // steal its taps.
                className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-black/5 text-[11px] font-bold transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15 ${
                  isMobileShell ? "h-11 min-w-11 px-3" : "h-7 px-2"
                }`}
              >
                <Shuffle className="h-3 w-3" />
                {switchFromToLabel(removeModelId, addModelId)}
              </button>
            ))}
          </div>
        ) : (
          onToggleModel &&
          fallbackActions.length > 0 && (
            <div className="mt-1.5 flex gap-1.5 overflow-x-auto overscroll-x-contain pb-0.5">
              {fallbackActions.map((modelId) => (
                <button
                  key={modelId}
                  type="button"
                  onClick={() => onToggleModel(modelId)}
                  data-testid="provider-status-fallback"
                  // Same reasoning as the swap chip above.
                  className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-black/5 text-[11px] font-bold transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15 ${
                    isMobileShell ? "h-11 min-w-11 px-3" : "h-7 px-2"
                  }`}
                >
                  <Shuffle className="h-3 w-3" />
                  {/*
                    The name alone left the shuffle glyph as the only clue to
                    what the chip does. Naming the action in the label keeps
                    the accessible name self-describing without an aria-label
                    that says something different from the visible text.
                  */}
                  {switchToLabel(modelId)}
                </button>
              ))}
            </div>
          )
        )}
      </div>
    );
  }

  return (
    <div
      className="mx-3 mt-3 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-sm dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200 md:mx-4"
      role="status"
      aria-live="polite"
      data-testid="provider-outage-banner"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-bold">
            <span data-testid="provider-status-title">{title}</span>
            <span
              className="rounded-full bg-black/5 px-2 py-0.5 text-[11px] dark:bg-white/10"
              data-testid="provider-status-count"
            >
              {unavailableCountLabel}
            </span>
          </div>
          <p className="mt-1 leading-5 opacity-90" data-testid="provider-status-guidance">
            {bannerState.impacted.slice(0, 3).map((model) => modelName(model.id)).join(", ")}
            {` ${fallbackGuidance}`}
            {fallbackCaveat ? ` ${fallbackCaveat}` : ""}
          </p>
          {onSwapModel && swapActions.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {swapActions.map(({ removeModelId, addModelId }) => (
                <button
                  key={removeModelId}
                  type="button"
                  onClick={() => onSwapModel(removeModelId, addModelId)}
                  data-testid="provider-status-swap"
                  className="inline-flex items-center gap-1 rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-bold transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
                >
                  <Shuffle className="h-3 w-3" />
                  {switchFromToLabel(removeModelId, addModelId)}
                </button>
              ))}
            </div>
          ) : (
            onToggleModel &&
            fallbackActions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {fallbackActions.map((modelId) => (
                  <button
                    key={modelId}
                    type="button"
                    onClick={() => onToggleModel(modelId)}
                    data-testid="provider-status-fallback"
                    className="inline-flex items-center gap-1 rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-bold transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
                  >
                    <Shuffle className="h-3 w-3" />
                    {switchToLabel(modelId)}
                  </button>
                ))}
              </div>
            )
          )}
        </div>
        <button
          type="button"
          onClick={() => void loadStatus()}
          // Desktop keeps its pre-existing, mouse-appropriate size: the 44px
          // floor is a touch requirement and this variant only renders in the
          // desktop shell (see DesktopChatShell / MobileChatShell).
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-black/5 transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
          data-testid="provider-status-refresh"
          aria-label={t("providerStatus.refresh")}
        >
          {isLoading ? (
            <Info className="h-4 w-4 animate-pulse" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}
