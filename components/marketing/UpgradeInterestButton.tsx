"use client";

import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { dispatchAppToast } from "@/lib/appToast";
import { useLanguage } from "@/components/LanguageProvider";

export function UpgradeInterestButton({
  plan,
  className,
  children,
}: {
  plan: "Pro" | "Max";
  className: string;
  children: ReactNode;
}) {
  const { t } = useLanguage();
  const [isSending, setIsSending] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [promoCode, setPromoCode] = useState("TOMVERSE50");
  const inputId = useId();

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const submit = async () => {
    if (isSending) return;
    const normalizedCode = promoCode.trim().toUpperCase();
    if (normalizedCode !== "TOMVERSE50") {
      dispatchAppToast(t("billing.promoInvalid"), "error");
      return;
    }
    setIsSending(true);
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, promoCode: normalizedCode }),
      });
      if (!response.ok) throw new Error("Waitlist failed");
      dispatchAppToast(t("billing.promoApplied"), "success");
      setIsOpen(false);
    } catch {
      dispatchAppToast(t("billing.waitlistFailed"), "error");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => setIsOpen(true)} disabled={isSending} className={className}>
        {isSending ? t("billing.sending") : children}
      </button>
      {isOpen ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${inputId}-title`}
        >
          <form
            className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id={`${inputId}-title`} className="text-lg font-black text-zinc-950 dark:text-white">
                  {t("billing.promoTitle")}
                </h2>
                <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                  {plan === "Pro" ? t("billing.promoProDescription") : t("billing.promoMaxDescription")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="rounded-full border border-zinc-200 px-3 py-1 text-sm font-bold text-zinc-500 hover:text-zinc-950 dark:border-zinc-800 dark:text-zinc-400 dark:hover:text-white"
                aria-label={t("billing.close")}
              >
                ×
              </button>
            </div>
            <label htmlFor={inputId} className="mt-5 block text-xs font-black uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">
              {t("billing.promoLabel")}
            </label>
            <input
              id={inputId}
              value={promoCode}
              onChange={(event) => setPromoCode(event.target.value)}
              className="mt-2 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-base font-black uppercase text-zinc-950 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
              placeholder="TOMVERSE50"
              autoComplete="off"
            />
            <p className="mt-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
              {t("billing.promoFinePrint")}
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="rounded-xl border border-zinc-200 px-4 py-2 text-sm font-black text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-900"
              >
                {t("billing.cancel")}
              </button>
              <button
                type="submit"
                disabled={isSending}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSending ? t("billing.sending") : t("billing.applyPromo")}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
