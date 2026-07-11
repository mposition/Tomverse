"use client";

import { useEffect, useState } from "react";
import { Boxes, FileText, LockKeyhole, Share2, X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";

const STORAGE_KEY = "tomverse_onboarding_seen_v1";

export function GoLiveOnboarding() {
  const { t } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (window.localStorage.getItem(STORAGE_KEY) !== "1") {
        setIsOpen(true);
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const close = () => {
    window.localStorage.setItem(STORAGE_KEY, "1");
    setIsOpen(false);
  };

  if (!isOpen) return null;

  const items = [
    { icon: Boxes, title: t("onboarding.compareTitle"), body: t("onboarding.compareBody") },
    { icon: FileText, title: t("onboarding.filesTitle"), body: t("onboarding.filesBody") },
    { icon: LockKeyhole, title: t("onboarding.privateTitle"), body: t("onboarding.privateBody") },
    { icon: Share2, title: t("onboarding.shareTitle"), body: t("onboarding.shareBody") },
  ];

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        className="w-full max-w-2xl overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-600 dark:text-blue-400">
              Tomverse AI
            </p>
            <h2 id="onboarding-title" className="mt-1 text-2xl font-black text-zinc-950 dark:text-white">
              {t("onboarding.title")}
            </h2>
            <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
              {t("onboarding.description")}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-white"
            aria-label={t("auth.cancel")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="grid gap-3 p-5 sm:grid-cols-2">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <article key={item.title} className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
                <Icon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                <h3 className="mt-3 text-sm font-black text-zinc-950 dark:text-white">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{item.body}</p>
              </article>
            );
          })}
        </div>
        <div className="border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <button
            type="button"
            onClick={close}
            className="flex h-11 w-full items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-black text-white transition hover:bg-blue-500"
          >
            {t("onboarding.cta")}
          </button>
        </div>
      </section>
    </div>
  );
}
