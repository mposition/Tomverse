"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Info, RefreshCw, Shuffle } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";

type PublicModelStatus = "available" | "limited" | "unavailable";

type PublicModelStatusRecord = {
  id: string;
  provider: string;
  status: PublicModelStatus;
  fallbackModelIds: string[];
};

type ProviderStatusBannerProps = {
  selectedModels?: string[];
  compact?: boolean;
  onToggleModel?: (modelId: string) => void;
};

export function ProviderStatusBanner({
  selectedModels = [],
  compact = false,
  onToggleModel,
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
    const visibleUnavailable =
      selectedUnavailable.length > 0 ? selectedUnavailable : unavailable;
    const fallbackIds = Array.from(
      new Set(visibleUnavailable.flatMap((model) => model.fallbackModelIds))
    )
      .filter((id) => !selectedSet.has(id))
      .slice(0, 3);
    const fallbackNames = fallbackIds.map(modelName);

    return {
      impacted: visibleUnavailable,
      fallbackIds,
      fallbackNames,
      isSelectedOnly: selectedUnavailable.length > 0,
    };
  }, [modelName, models, selectedModels]);

  if (models.length === 0) return null;

  const hasImpact = bannerState.impacted.length > 0;
  if (!hasImpact) return null;

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
            <div className="flex min-w-0 items-center gap-2 font-black">
              <span className="truncate">
                {bannerState.isSelectedOnly
                  ? t("providerStatus.selectedIssue")
                  : t("providerStatus.globalIssue")}
              </span>
              <span className="shrink-0 rounded-full bg-black/5 px-2 py-0.5 text-[10px] dark:bg-white/10">
                {bannerState.impacted.length} {t("providerStatus.unavailable")}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] font-medium opacity-80">
              {bannerState.fallbackNames.length > 0
                ? `${t("providerStatus.tryFallback")} ${bannerState.fallbackNames.join(", ")}`
                : t("providerStatus.tryLater")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadStatus()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-black/5 transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
            aria-label={t("providerStatus.refresh")}
          >
            {isLoading ? (
              <Info className="h-4 w-4 animate-pulse" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </button>
        </div>
        {onToggleModel && bannerState.fallbackIds.length > 0 && (
          <div className="mt-1.5 flex gap-1.5 overflow-x-auto overscroll-x-contain pb-0.5">
            {bannerState.fallbackIds.map((modelId) => (
              <button
                key={modelId}
                type="button"
                onClick={() => onToggleModel(modelId)}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-black/5 px-2 text-[11px] font-black transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
              >
                <Shuffle className="h-3 w-3" />
                {modelName(modelId)}
              </button>
            ))}
          </div>
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
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-black">
            <span>
              {bannerState.isSelectedOnly
                ? t("providerStatus.selectedIssue")
                : t("providerStatus.globalIssue")}
            </span>
            <span className="rounded-full bg-black/5 px-2 py-0.5 text-[10px] dark:bg-white/10">
              {bannerState.impacted.length} {t("providerStatus.unavailable")}
            </span>
          </div>
          <p className="mt-1 leading-5 opacity-90">
            {bannerState.impacted.slice(0, 3).map((model) => modelName(model.id)).join(", ")}
            {bannerState.fallbackNames.length > 0
              ? ` ${t("providerStatus.tryFallback")} ${bannerState.fallbackNames.join(", ")}`
              : ` ${t("providerStatus.tryLater")}`}
          </p>
          {onToggleModel && bannerState.fallbackIds.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {bannerState.fallbackIds.map((modelId) => (
                <button
                  key={modelId}
                  type="button"
                  onClick={() => onToggleModel(modelId)}
                  className="inline-flex items-center gap-1 rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-black transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
                >
                  <Shuffle className="h-3 w-3" />
                  {t("providerStatus.switchTo")} {modelName(modelId)}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void loadStatus()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-black/5 transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
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
