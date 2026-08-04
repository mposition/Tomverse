"use client";

import { ChevronRight, LockKeyhole, Sparkles } from "lucide-react";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { useLanguage } from "@/components/LanguageProvider";
import { listImageModels } from "@/lib/imageModelRegistry";

// The catalogue's image tab (policy v2 section 13 of
// docs/policy/image-generation.md).
//
// Image *generation* models are a separate catalogue from the chat models, and
// deliberately not a filter over them: in the chat list `supportsImage` means
// the model accepts image INPUT, which is a different capability with
// different pricing. Mixing the two into one list would make that word mean
// two things in the same column.
//
// Every registered model is listed, including the ones held disabled by the
// section 12 price verification rule -- a model the product has decided about
// but cannot yet run is more honest as a stated hold than as an absence. A held
// model is not selectable; only the verification state changes that, never a
// click here.

const interpolate = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  google: "Google",
};

const LATENCY_LABEL_KEYS = {
  fast: "chat.imageModelLatencyFast",
  balanced: "chat.imageModelLatencyBalanced",
  slow: "chat.imageModelLatencySlow",
} as const;

export type ImageModelTabPanelProps = {
  /**
   * Set when the viewer may see image generation but not use it yet. Rows stay
   * visible and clickable and route to the sign-in or upgrade prompt: the
   * requirement is stated up front rather than at the end of the flow, and UI
   * exposure was never the security boundary (the server re-checks).
   */
  lock: "sign_in" | "upgrade" | null;
  onSelectModel: (modelId: string) => void;
  onLockedClick: (lock: "sign_in" | "upgrade") => void;
  /** 44px rows for touch input, matching the rest of the picker. */
  touchTarget: boolean;
  /** UI-001: the panel above owns the scroll while the keyboard is up. */
  isKeyboardCompact: boolean;
};

export function ImageModelTabPanel({
  lock,
  onSelectModel,
  onLockedClick,
  touchTarget,
  isKeyboardCompact,
}: ImageModelTabPanelProps) {
  const { t } = useLanguage();
  const models = listImageModels();

  return (
    <div
      data-testid="image-model-tab-panel"
      className={
        isKeyboardCompact
          ? "min-h-0 shrink-0 space-y-2 overflow-x-hidden px-1 pb-4 pr-2"
          : "h-0 min-h-0 flex-1 touch-pan-y space-y-2 overflow-x-hidden overflow-y-scroll overscroll-y-contain px-1 pb-4 pr-2 [scrollbar-gutter:stable] [-webkit-overflow-scrolling:touch]"
      }
    >
      <p className="px-1 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
        {t("chat.imageModelTabSubtitle")}
      </p>

      <ul className="space-y-2">
        {models.map((model) => {
          const held = model.disabledReason !== null;
          // "From" pricing: the picker does not know which quality and size the
          // workspace will end on, so it quotes the cheapest option rather than
          // a number the composer might contradict.
          const fromCredits = model.prices.length
            ? Math.min(...model.prices.map((price) => price.credits))
            : null;
          return (
            <li key={model.id}>
              <button
                type="button"
                data-testid="image-model-option"
                data-model-id={model.id}
                data-held={held ? "true" : "false"}
                data-locked={!held && lock ? "true" : "false"}
                disabled={held}
                onClick={() => {
                  if (held) return;
                  if (lock) {
                    onLockedClick(lock);
                    return;
                  }
                  onSelectModel(model.id);
                }}
                className={`flex w-full items-start gap-3 rounded-xl border px-3 text-left transition ${
                  touchTarget ? "min-h-14 py-2.5" : "py-2.5"
                } ${
                  held
                    ? "cursor-not-allowed border-zinc-200 bg-zinc-50 opacity-70 dark:border-zinc-800 dark:bg-zinc-900/40"
                    : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                }`}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-image-500/10 text-accent-image-500">
                  <Sparkles className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-bold text-zinc-900 dark:text-zinc-100">
                    {model.name}
                  </span>
                  <span className="mt-0.5 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
                    {/* Provider names are brands, not copy: never translated. */}
                    {PROVIDER_LABELS[model.provider]}
                    {" · "}
                    {t(LATENCY_LABEL_KEYS[model.latencyClass])}
                  </span>
                  {held && (
                    <span
                      data-testid="image-model-hold-note"
                      className="mt-1 text-[11px] font-bold leading-4 text-amber-600 dark:text-amber-400"
                    >
                      {t("chat.imageModelHoldPriceUnverified")}
                    </span>
                  )}
                  {!held && lock && (
                    <span className="mt-1 flex items-center gap-1 text-[11px] font-bold text-accent-image-600 dark:text-accent-image-300">
                      <LockKeyhole className="h-3 w-3" aria-hidden="true" />
                      {lock === "sign_in"
                        ? t("modelStatusReasons.loginRequired")
                        : t("modelStatusReasons.upgradeRequired")}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {fromCredits !== null && (
                    <CreditCostBadge
                      credits={fromCredits}
                      size="xs"
                      testId="image-model-credit-badge"
                      label={interpolate(t("chat.imageModelCreditsFrom"), {
                        credits: fromCredits,
                      })}
                    />
                  )}
                  {!held && (
                    <ChevronRight
                      className="h-4 w-4 text-zinc-400"
                      aria-hidden="true"
                    />
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
