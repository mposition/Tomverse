"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, Info, RefreshCw, Shuffle, SlidersHorizontal } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { useIsMobileShell } from "@/components/chat/useIsMobileShell";
import { openChatModelPicker } from "@/lib/chatModelPickerEvents";

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
  onSwapModel?: (removeModelId: string, addModelId: string) => void;
};

/**
 * Contextual outage disclosure.
 *
 * This banner used to have two modes: a selected-model one, and a global one
 * that fired whenever *any* public model was unavailable. The second mode is
 * gone. A red workspace warning about six models the user never picked reads
 * as "your next message will fail" when nothing of the sort is true, and its
 * "Try: <model>" chip called the plain add/toggle handler -- which no-ops once
 * the selection is at its cap, so the one action on offer did nothing.
 *
 * Operational status is still disclosed in full, just where it is actionable:
 * the model picker/catalogue keeps every unavailable model's status, its
 * disabled selection and its reason (see ModelCatalogue, which reads the same
 * /api/models/status snapshot independently of this component). What changed is
 * only *which* outages are allowed to interrupt the chat workspace and to
 * announce themselves on a live region: the ones the user's own selection is
 * standing on.
 */
export function ProviderStatusBanner({
  selectedModels = [],
  compact = false,
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
  const headingId = useId();
  const actionsId = useId();

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
    // The whole disclosure policy in one filter: an outage reaches the
    // workspace only through a model the user is actually about to send to.
    // `limited` stays out of here as it always has -- the model still answers,
    // so its warning belongs to the picker, not to a red workspace banner.
    const impacted = models.filter(
      (model) => model.status === "unavailable" && selectedSet.has(model.id)
    );

    // One replacement per impacted model, so every offer names the model it
    // repairs. `claimed` stops two impacted models from pointing at the same
    // replacement: accepting both offers would then remove two selections and
    // add one, quietly shrinking the comparison.
    const claimed = new Set<string>();
    const recoveries = impacted.map((model) => {
      const addModelId = model.fallbackModelIds.find(
        (id) => !selectedSet.has(id) && !claimed.has(id)
      );
      if (addModelId) claimed.add(addModelId);
      return {
        modelId: model.id,
        addModelId,
        fallbackHealth: model.fallbackHealth,
      };
    });

    const offered = recoveries.filter((recovery) => Boolean(recovery.addModelId));

    // The caveat has to describe the replacements actually on offer, so it is
    // the worst health among the models that contributed one. With no
    // candidate left the banner says so instead of the generic "try again
    // later", which hid that every alternative was out.
    //
    // `some`, not `every`: each impacted model now owns its own replacement,
    // so one healthy offer must not vouch for a shaky one sitting next to it.
    // Under the old pooled list "all of them are degraded" was the same
    // question; per-model it is the difference between warning and hiding.
    const fallbackHealth: FallbackHealth =
      offered.length === 0
        ? "none"
        : offered.some((recovery) => recovery.fallbackHealth === "unknown")
          ? "unknown"
          : offered.some((recovery) => recovery.fallbackHealth === "degraded")
            ? "degraded"
            : "operational";

    return { impacted, recoveries, fallbackHealth };
  }, [models, selectedModels]);

  const hasImpact = bannerState.impacted.length > 0;

  // Accessibility contract 7 and 9. Taking the swap -- or a refresh that finds
  // the provider recovered -- removes the very control that was focused, and
  // the browser then drops focus on <body>, stranding keyboard and screen
  // reader users at the top of the document. Anything the banner does that can
  // unmount it therefore names where focus should land instead.
  const restoreFocusRef = useRef<string | null>(null);
  const rememberFocusTarget = useCallback(
    (preferredModelId?: string) => {
      restoreFocusRef.current = preferredModelId ?? selectedModels[0] ?? "";
    },
    [selectedModels]
  );

  useEffect(() => {
    if (hasImpact) return;
    const preferred = restoreFocusRef.current;
    if (preferred === null) return;
    restoreFocusRef.current = null;
    // Only step in if focus really was dropped: a click with a mouse leaves
    // <body> active too, but so does nothing else worth fighting over.
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) {
      return;
    }
    const escaped = preferred ? CSS.escape(preferred) : "";
    // Nearest thing that still means "your models", per shell: the replaced
    // model's own tab, then the header summary, then the composer's model
    // selector. Never the composer textarea -- pulling focus there would raise
    // the phone keyboard over the workspace the user was just reading.
    const selectors = [
      ...(escaped
        ? [
            `[data-testid="mobile-model-tab"][data-model-id="${escaped}"]`,
            `[data-testid="model-compare-tab"][data-model-id="${escaped}"]`,
          ]
        : []),
      '[data-testid="mobile-header-model-summary"]',
      '[data-testid="composer-model-select"]',
    ];
    for (const selector of selectors) {
      const target = document.querySelector<HTMLElement>(selector);
      if (!target) continue;
      target.focus({ preventScroll: true });
      if (document.activeElement === target) return;
    }
  }, [hasImpact]);

  if (models.length === 0) return null;
  if (!hasImpact) return null;

  const title =
    bannerState.impacted.length === 1
      ? t("providerStatus.selectedUnavailableOne").replace(
          "{model}",
          modelName(bannerState.impacted[0].id)
        )
      : t("providerStatus.selectedUnavailableMany").replace(
          "{count}",
          String(bannerState.impacted.length)
        );

  // Never silent about a replacement the snapshot itself says is shaky, and
  // never silent about there being none.
  const detail =
    bannerState.fallbackHealth === "degraded"
      ? t("providerStatus.fallbackDegraded")
      : bannerState.fallbackHealth === "unknown"
        ? t("providerStatus.fallbackUnverified")
        : bannerState.fallbackHealth === "none"
          ? t("providerStatus.noHealthyFallback")
          : "";

  // One action per impacted model. A model with a healthy, eligible
  // replacement gets an atomic remove-and-add so it works at the selection cap
  // as well; a model without one gets the picker, which is a real recovery
  // path rather than "try again later".
  const actions = bannerState.recoveries.map((recovery) => {
    const addModelId = recovery.addModelId;
    if (onSwapModel && addModelId) {
      return {
        key: recovery.modelId,
        kind: "swap" as const,
        label: t("providerStatus.switchFromTo")
          .replace("{from}", modelName(recovery.modelId))
          .replace("{to}", modelName(addModelId)),
        run: () => {
          rememberFocusTarget(addModelId);
          onSwapModel(recovery.modelId, addModelId);
        },
      };
    }
    return {
      key: recovery.modelId,
      kind: "picker" as const,
      label:
        bannerState.impacted.length === 1
          ? t("providerStatus.chooseAnother")
          : t("providerStatus.chooseAnotherFor").replace(
              "{model}",
              modelName(recovery.modelId)
            ),
      run: (element: HTMLElement) => {
        // The picker owns focus while it is open and returns it here on close;
        // it is also what will change the selection, so the effect above takes
        // over from there if this banner goes away.
        rememberFocusTarget();
        openChatModelPicker(element);
      },
    };
  });

  const renderActions = (rowClassName: string, chipClassName: string) => (
    <div id={actionsId} className={rowClassName}>
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          onClick={(event) => action.run(event.currentTarget)}
          data-testid={
            action.kind === "swap"
              ? "provider-status-swap"
              : "provider-status-choose-model"
          }
          className={chipClassName}
        >
          {action.kind === "swap" ? (
            <Shuffle className="h-3 w-3 shrink-0" aria-hidden="true" />
          ) : (
            <SlidersHorizontal className="h-3 w-3 shrink-0" aria-hidden="true" />
          )}
          {action.label}
        </button>
      ))}
    </div>
  );

  const refreshButton = (className: string) => (
    <button
      type="button"
      onClick={() => {
        rememberFocusTarget();
        void loadStatus();
      }}
      className={className}
      data-testid="provider-status-refresh"
      aria-label={t("providerStatus.refresh")}
    >
      {isLoading ? (
        <Info className="h-4 w-4 animate-pulse" />
      ) : (
        <RefreshCw className="h-4 w-4" />
      )}
    </button>
  );

  if (compact) {
    return (
      <div
        className="mx-3 mt-2 rounded-2xl border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-800 shadow-sm dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
        role="status"
        aria-live="polite"
        aria-labelledby={headingId}
        aria-describedby={actionsId}
        data-testid="provider-outage-banner"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            {/* Not truncated: the model name is the whole point of the
                sentence, and at 320px or 200% text scaling a single-line clamp
                is exactly where it would be cut off. */}
            <p id={headingId} className="min-w-0 break-words font-bold">
              {title}
            </p>
            {detail ? (
              <p className="mt-0.5 break-words text-[11px] font-medium opacity-80">
                {detail}
              </p>
            ) : null}
          </div>
          {refreshButton(
            // The icon itself stays 16px: only the box around it grows.
            `flex shrink-0 items-center justify-center rounded-xl bg-black/5 transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15 ${
              isMobileShell ? "h-11 w-11" : "h-8 w-8"
            }`
          )}
        </div>
        {renderActions(
          "mt-1.5 flex gap-1.5 overflow-x-auto overscroll-x-contain pb-0.5",
          // A real box rather than a pseudo-element inset: these chips sit 6px
          // apart in a scrolling row, so an inset large enough to reach 44px
          // would overlap the next chip's tap area and steal its taps.
          `inline-flex shrink-0 items-center gap-1 rounded-full bg-black/5 text-[11px] font-bold transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15 ${
            isMobileShell ? "h-11 min-w-11 px-3" : "h-7 px-2"
          }`
        )}
      </div>
    );
  }

  return (
    <div
      className="mx-3 mt-3 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-sm dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200 md:mx-4"
      role="status"
      aria-live="polite"
      aria-labelledby={headingId}
      aria-describedby={actionsId}
      data-testid="provider-outage-banner"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p id={headingId} className="min-w-0 break-words font-bold">
            {title}
          </p>
          {detail ? (
            <p className="mt-1 break-words leading-5 opacity-90">{detail}</p>
          ) : null}
          {renderActions(
            "mt-2 flex flex-wrap gap-1.5",
            "inline-flex items-center gap-1 rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-bold transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
          )}
        </div>
        {/* Desktop keeps its pre-existing, mouse-appropriate size: the 44px
            floor is a touch requirement and this variant only renders in the
            desktop shell (see DesktopChatShell / MobileChatShell). */}
        {refreshButton(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-black/5 transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
        )}
      </div>
    </div>
  );
}
