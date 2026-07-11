"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, RefreshCw } from "lucide-react";
import { AVAILABLE_MODELS } from "@/components/chat/types";
import { useLanguage } from "@/components/LanguageProvider";

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
};

const modelName = (id: string) =>
  AVAILABLE_MODELS.find((model) => model.id === id)?.name || id;

export function ProviderStatusBanner({
  selectedModels = [],
  compact = false,
}: ProviderStatusBannerProps) {
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
                record.status !== "unavailable")
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
                    .slice(0, 3)
                : [],
            };
          })
          .filter((item): item is PublicModelStatusRecord => Boolean(item))
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void loadStatus(), 0);
    const timer = window.setInterval(() => void loadStatus(), 120_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [loadStatus]);

  const bannerState = useMemo(() => {
    const selectedSet = new Set(selectedModels);
    const impacted = models.filter((model) => model.status !== "available");
    const selectedImpacted =
      selectedSet.size > 0
        ? impacted.filter((model) => selectedSet.has(model.id))
        : [];
    const visibleImpacted = selectedImpacted.length > 0 ? selectedImpacted : impacted;
    const unavailable = visibleImpacted.filter(
      (model) => model.status === "unavailable"
    );
    const limited = visibleImpacted.filter((model) => model.status === "limited");
    const fallbackNames = Array.from(
      new Set(visibleImpacted.flatMap((model) => model.fallbackModelIds))
    )
      .filter((id) => !selectedSet.has(id))
      .slice(0, 3)
      .map(modelName);

    return {
      impacted: visibleImpacted,
      unavailable,
      limited,
      fallbackNames,
      isSelectedOnly: selectedImpacted.length > 0,
    };
  }, [models, selectedModels]);

  if (models.length === 0) return null;

  const hasImpact = bannerState.impacted.length > 0;
  const tone = bannerState.unavailable.length > 0 ? "danger" : "warning";

  if (!hasImpact && compact) return null;

  return (
    <div
      className={`mx-3 mt-3 rounded-2xl border px-3 py-2 text-xs shadow-sm md:mx-4 ${
        hasImpact
          ? tone === "danger"
            ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
            : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
          : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200"
      }`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          {hasImpact ? (
            <AlertTriangle className="h-4 w-4" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-black">
            <span>
              {hasImpact
                ? bannerState.isSelectedOnly
                  ? t("providerStatus.selectedIssue")
                  : t("providerStatus.globalIssue")
                : t("providerStatus.allAvailable")}
            </span>
            {hasImpact && (
              <span className="rounded-full bg-black/5 px-2 py-0.5 text-[10px] dark:bg-white/10">
                {bannerState.unavailable.length > 0
                  ? `${bannerState.unavailable.length} ${t("providerStatus.unavailable")}`
                  : `${bannerState.limited.length} ${t("providerStatus.limited")}`}
              </span>
            )}
          </div>
          {hasImpact ? (
            <p className="mt-1 leading-5 opacity-90">
              {bannerState.impacted.slice(0, 3).map((model) => modelName(model.id)).join(", ")}
              {bannerState.fallbackNames.length > 0
                ? ` ${t("providerStatus.tryFallback")} ${bannerState.fallbackNames.join(", ")}`
                : ` ${t("providerStatus.tryLater")}`}
            </p>
          ) : (
            <p className="mt-1 leading-5 opacity-90">{t("providerStatus.allAvailableBody")}</p>
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
