"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { modelPickerCopy } from "@/lib/modelPickerPresentation";

type CreditBreakdownItem = {
  id: string;
  name: string;
  credits: number;
};

type CreditBreakdownSheetProps = {
  open: boolean;
  onClose: () => void;
  items: CreditBreakdownItem[];
  total: number;
  multiplier?: number;
};

export function CreditBreakdownSheet({
  open,
  onClose,
  items,
  total,
  multiplier,
}: CreditBreakdownSheetProps) {
  const { t, lang } = useLanguage();
  const pickerCopy = modelPickerCopy[lang];
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const focusFrame = requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={pickerCopy.estimatedUsageTitle}
    >
      <button
        type="button"
        className="absolute inset-0 h-full w-full cursor-default"
        onClick={onClose}
        aria-label={t("auth.cancel")}
      />
      <div className="relative z-10 w-full rounded-t-3xl border-t border-zinc-200 bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
            {pickerCopy.estimatedUsageTitle}
          </p>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 dark:hover:bg-zinc-900"
            aria-label={t("auth.cancel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="mt-3 flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-2 text-sm text-zinc-700 dark:text-zinc-300"
            >
              <span className="min-w-0 truncate">{item.name}</span>
              <CreditCostBadge credits={item.credits} size="xs" label={`${item.credits}`} />
            </li>
          ))}
        </ul>
        {multiplier && multiplier > 1 && (
          <p className="mt-3 text-xs font-semibold text-amber-600 dark:text-amber-400">
            {multiplier}× · {pickerCopy.multiplierApplied}
          </p>
        )}
        <div className="mt-3 flex items-center justify-between border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <span className="text-sm font-black text-zinc-900 dark:text-zinc-100">
            {pickerCopy.total}
          </span>
          <CreditCostBadge credits={total} size="sm" label={`${total}`} />
        </div>
      </div>
    </div>
  );
}
