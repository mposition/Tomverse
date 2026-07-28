"use client";

import { useEffect, useRef, useState } from "react";
import { Lock, Microscope, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { getWeightedUsageCredits, type AiModel } from "@/lib/models";
import type { DeepResearchDepth } from "@/lib/perplexityDeepResearch";

const DEPTHS: DeepResearchDepth[] = ["quick", "standard", "deep"];

type DeepResearchSetupSheetProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: (depth: DeepResearchDepth) => void;
  deepResearchModel: AiModel | null;
  isGuestMode: boolean;
  isPlanLocked: boolean;
  onGuestSignInPrompt: () => void;
  estimatedInputTokens: number;
  hasDraftText: boolean;
};

export function DeepResearchSetupSheet({
  open,
  onClose,
  onConfirm,
  deepResearchModel,
  isGuestMode,
  isPlanLocked,
  onGuestSignInPrompt,
  estimatedInputTokens,
  hasDraftText,
}: DeepResearchSetupSheetProps) {
  const { t } = useLanguage();
  const [depth, setDepth] = useState<DeepResearchDepth>("standard");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const locked = isGuestMode || isPlanLocked;
  const estimatedCredits = deepResearchModel
    ? getWeightedUsageCredits(deepResearchModel, estimatedInputTokens)
    : null;

  return (
    <div className="fixed inset-0 z-[110] flex items-end justify-center md:items-center">
      <button
        type="button"
        className="fixed inset-0 bg-black/40 backdrop-blur-[1px]"
        onClick={onClose}
        aria-label={t("auth.cancel")}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.deepResearchSetupTitle")}
        className="relative z-[111] w-full max-w-md rounded-t-3xl border border-zinc-200 bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 md:rounded-3xl md:pb-4"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700 md:hidden" aria-hidden="true" />
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">
              <Microscope className="h-5 w-5" />
            </span>
            <p className="text-base font-bold text-zinc-900 dark:text-zinc-100">
              {t("chat.deepResearchSetupTitle")}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={t("auth.cancel")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {locked ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900/60 dark:bg-amber-950/20">
            <div className="flex items-center gap-2 font-bold text-amber-900 dark:text-amber-200">
              <Lock className="h-4 w-4" />
              {isGuestMode
                ? t("chat.deepResearchLoginRequired")
                : t("chat.deepResearchUpgradeRequired")}
            </div>
            {isGuestMode && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onGuestSignInPrompt();
                }}
                className="mt-3 rounded-xl bg-amber-600 px-3 py-2 text-xs font-bold text-white hover:bg-amber-500"
              >
                {t("chat.aiReviewLoginToUnlock")}
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="mb-4 rounded-2xl bg-zinc-50 px-3 py-2.5 text-xs text-zinc-600 dark:bg-zinc-950/60 dark:text-zinc-300">
              <p className="font-bold text-zinc-800 dark:text-zinc-100">
                {t("chat.deepResearchEngineLabel")}
              </p>
              <p className="mt-0.5">{deepResearchModel?.name || "Perplexity Deep Research"}</p>
            </div>

            <p className="mb-2 text-xs font-bold text-zinc-700 dark:text-zinc-300">
              {t("chat.deepResearchDepthLabel")}
            </p>
            <div className="mb-4 space-y-1.5">
              {DEPTHS.map((option) => (
                <button
                  key={option}
                  type="button"
                  data-testid={`deep-research-depth-${option}`}
                  aria-pressed={depth === option}
                  onClick={() => setDepth(option)}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                    depth === option
                      ? "border-violet-400 bg-violet-50 dark:border-violet-700 dark:bg-violet-950/30"
                      : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  }`}
                >
                  <span>
                    <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {t(`chat.deepResearchDepth${option === "quick" ? "Quick" : option === "standard" ? "Standard" : "Deep"}`)}
                    </span>
                    <span className="block text-xs text-zinc-500">
                      {t(`chat.deepResearchDepth${option === "quick" ? "Quick" : option === "standard" ? "Standard" : "Deep"}Description`)}
                    </span>
                  </span>
                  {depth === option && (
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-violet-500" aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>

            <div className="mb-4 flex items-center justify-between rounded-2xl bg-zinc-50 px-3 py-2.5 text-xs dark:bg-zinc-950/60">
              <span className="text-zinc-600 dark:text-zinc-300">
                {t("chat.deepResearchEstimatedTime")}
              </span>
              <span className="font-bold text-zinc-800 dark:text-zinc-100">
                {t("chat.deepResearchEstimatedTimeValue")}
              </span>
            </div>
            {estimatedCredits !== null && (
              <div className="mb-4 flex items-center justify-between rounded-2xl bg-zinc-50 px-3 py-2.5 text-xs dark:bg-zinc-950/60">
                <span className="text-zinc-600 dark:text-zinc-300">
                  {t("chat.deepResearchEstimatedCost")}
                </span>
                <CreditCostBadge credits={estimatedCredits} size="xs" />
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                data-testid="deep-research-cancel"
                onClick={onClose}
                className="flex-1 rounded-xl border border-zinc-200 px-3 py-2.5 text-sm font-bold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                {t("auth.cancel")}
              </button>
              <button
                type="button"
                data-testid="deep-research-confirm-start"
                disabled={!hasDraftText}
                onClick={() => onConfirm(depth)}
                className="flex-1 rounded-xl bg-violet-600 px-3 py-2.5 text-sm font-bold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("chat.deepResearchStart")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
