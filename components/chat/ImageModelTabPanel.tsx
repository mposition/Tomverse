"use client";

import { ChevronRight, LockKeyhole } from "lucide-react";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { useLanguage } from "@/components/LanguageProvider";
import {
  imageModelBrandParts,
  type ImageModelOwner,
  type ImageModelProvider,
} from "@/lib/imageModelRegistry";
import { useImageModelCatalog } from "@/components/images/ImageModelCatalogProvider";

// The catalogue's image tab (policy v2 section 13 of
// docs/policy/image-generation.md).
//
// Image *generation* models are a separate catalogue from the chat models, and
// deliberately not a filter over them: in the chat list `supportsImage` means
// the model accepts image INPUT, which is a different capability with
// different pricing. Mixing the two into one list would make that word mean
// two things in the same column.
//
// Only models that can run are listed. Owner decision 2026-11-13: a held
// model (an unverified price, an unbounded worst case, an operator hold) is
// operator state, and a row a user cannot pick is noise in the picker. The
// Admin catalogue is where holds are stated. Each row carries its owner's
// logo, the same ModelLogo the chat list uses.

const interpolate = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );

/**
 * Brand names for the row's subtitle. Never translated -- these are brands.
 *
 * Typed against the union rather than `Record<string, string>`, which is what
 * let `fal` go missing: any string satisfied the index signature, so a model
 * whose label had never been written type-checked, rendered `undefined`, and
 * showed a row that began with the separator and no name at all.
 *
 * Keyed by *owner*, because the subtitle answers "whose model is this" (policy
 * section 16.1). For every direct integration owner and provider are the same
 * string and this reads exactly as it did before; the gateway line below is
 * what makes the difference visible.
 */
const OWNER_LABELS: Record<ImageModelOwner, string> = {
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  fal: "fal",
  qwen: "Qwen",
};

/** Same table, for the supplier when it differs from the owner. */
const PROVIDER_LABELS: Record<ImageModelProvider, string> = {
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  fal: "fal",
  qwen: "Alibaba Cloud",
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
  const { models: catalogue } = useImageModelCatalog();
  const models = catalogue.filter((model) => model.disabledReason === null);

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
          const brand = imageModelBrandParts(model);
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
                data-locked={lock ? "true" : "false"}
                onClick={() => {
                  if (lock) {
                    onLockedClick(lock);
                    return;
                  }
                  onSelectModel(model.id);
                }}
                className={`flex w-full items-start gap-3 rounded-xl border px-3 text-left transition ${
                  touchTarget ? "min-h-14 py-2.5" : "py-2.5"
                } border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800`}
              >
                {/* Whose model it is, like the chat list: Nano Banana 2 through
                    fal shows Google's mark, and the subtitle names fal. */}
                <ModelLogo provider={brand.owner} size="lg" className="h-9 w-9" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-bold text-zinc-900 dark:text-zinc-100">
                    {model.name}
                  </span>
                  <span className="mt-0.5 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
                    {/* Brand names, not copy: never translated. */}
                    {OWNER_LABELS[brand.owner]}
                    {brand.gateway !== null && (
                      <>
                        {" · "}
                        {/* Named, not hidden (policy section 16.1). Whose model
                            it is and who supplies it are different facts, and a
                            row that showed only one of them would be wrong
                            about the other. */}
                        <span data-testid="image-model-gateway">
                          {interpolate(t("chat.imageModelViaGateway"), {
                            gateway: PROVIDER_LABELS[brand.gateway],
                          })}
                        </span>
                      </>
                    )}
                    {" · "}
                    {t(LATENCY_LABEL_KEYS[model.latencyClass])}
                  </span>
                  {lock && (
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
                  <ChevronRight
                    className="h-4 w-4 text-zinc-400"
                    aria-hidden="true"
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
