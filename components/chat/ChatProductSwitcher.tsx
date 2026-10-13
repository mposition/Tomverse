"use client";

import Link from "next/link";
import { useId } from "react";
import { MessageSquare, PanelsTopLeft } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import {
  chatProductUiCopy,
  localizedProductHref,
  type ChatWorkspaceProduct,
} from "@/lib/chatProductUiCopy";
import type { Language } from "@/lib/language";

/**
 * Navigation between the two Chat-family products.
 *
 * This control changes routes only. It never rewrites the open conversation's
 * product, model selection, draft, or selection mode. Smart Adaptive has its
 * own switch beside the send controls because it is a mode inside Chat, not a
 * third product.
 */
export function ChatProductSwitcher({
  currentProduct,
  disabled = false,
  onProductSwitch,
  density = "default",
}: {
  currentProduct: ChatWorkspaceProduct;
  disabled?: boolean;
  onProductSwitch?: (nextProduct: ChatWorkspaceProduct) => boolean;
  density?: "default" | "compact";
}) {
  const { lang } = useLanguage();

  return (
    <ChatProductSwitcherView
      currentProduct={currentProduct}
      language={lang}
      disabled={disabled}
      onProductSwitch={onProductSwitch}
      density={density}
    />
  );
}

/** Pure view exported so the navigation contract can be rendered in Node. */
export function ChatProductSwitcherView({
  currentProduct,
  language,
  disabled = false,
  onProductSwitch,
  density = "default",
}: {
  currentProduct: ChatWorkspaceProduct;
  language: Language;
  disabled?: boolean;
  onProductSwitch?: (nextProduct: ChatWorkspaceProduct) => boolean;
  density?: "default" | "compact";
}) {
  const copy = chatProductUiCopy[language];
  const instanceId = useId();
  const disabledDescriptionId = `chat-product-switch-disabled-description-${instanceId}`;

  return (
    <nav
      data-testid="chat-product-switcher"
      aria-label={copy.selectorLabel}
      data-density={density}
      className={density === "compact"
        ? "w-fit max-w-full min-w-0 max-[240px]:w-full"
        : "w-full min-w-0 max-w-[236px]"}
    >
      <div className={density === "compact"
        ? "grid h-11 min-w-0 grid-cols-[minmax(62px,max-content)_minmax(76px,max-content)] rounded-lg max-[240px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:[@media(pointer:fine)]:h-8"
        : "grid min-w-0 grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-950"}>
        {(["chat", "review"] as const).map((product) => {
          const item = copy[product];
          const current = currentProduct === product;
          const href = localizedProductHref(product, language);
          const ProductIcon = product === "chat" ? MessageSquare : PanelsTopLeft;
          return (
            <Link
              key={product}
              href={href}
              aria-current={current ? "page" : undefined}
              aria-disabled={disabled || undefined}
              aria-describedby={disabled ? disabledDescriptionId : undefined}
              aria-label={`${item.name}. ${item.feature}. ${item.description}`}
              data-testid={`chat-product-${product}`}
              onClick={(event) => {
                if (!allowProductSwitchNavigation({
                  currentProduct,
                  nextProduct: product,
                  disabled,
                  onProductSwitch,
                })) {
                  event.preventDefault();
                }
              }}
              className={`${density === "compact"
                ? "flex h-11 min-w-0 touch-manipulation items-center justify-center rounded-lg border px-2 text-center text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 md:[@media(pointer:fine)]:h-8"
                : "flex min-h-11 min-w-0 flex-wrap touch-manipulation content-center items-center justify-center gap-x-2 gap-y-0.5 rounded-lg border px-2 text-center text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"} ${
                current
                  ? product === "review"
                    ? density === "compact"
                      ? "border-transparent bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-200"
                      : "border-blue-100 bg-blue-50 text-blue-700 shadow-sm dark:border-blue-900/70 dark:bg-blue-950/40 dark:text-blue-200"
                    : density === "compact"
                      ? "border-transparent bg-zinc-100 text-zinc-950 dark:bg-zinc-800 dark:text-white"
                      : "border-zinc-300 bg-white text-zinc-950 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
                  : disabled
                    ? "cursor-wait border-transparent text-zinc-400 dark:text-zinc-600"
                    : "border-transparent text-zinc-600 hover:bg-white/70 hover:text-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900/70 dark:hover:text-white"
              }`}
            >
              {density === "default" && (
                <ProductIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 max-w-full whitespace-normal break-words leading-tight">
                {item.shortLabel}
              </span>
            </Link>
          );
        })}
      </div>
      {disabled && (
        <p id={disabledDescriptionId} className="sr-only" role="status">
          {copy.switchPendingDescription}
        </p>
      )}
    </nav>
  );
}

/** Pure click admission shared by pointer, keyboard and modifier-click events. */
export const allowProductSwitchNavigation = ({
  currentProduct,
  nextProduct,
  disabled,
  onProductSwitch,
}: {
  currentProduct: ChatWorkspaceProduct;
  nextProduct: ChatWorkspaceProduct;
  disabled: boolean;
  onProductSwitch?: (nextProduct: ChatWorkspaceProduct) => boolean;
}): boolean => {
  if (disabled || currentProduct === nextProduct) return false;
  return onProductSwitch ? onProductSwitch(nextProduct) : true;
};
