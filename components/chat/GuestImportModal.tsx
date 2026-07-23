"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  buildGuestImportPayload,
  importGuestConversation,
  type GuestConversationSummary,
} from "@/lib/guestImport";

const interpolateCopy = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );

type ImportSummary = {
  succeeded: number;
  failed: number;
  failedIds: string[];
};

type GuestImportModalProps = {
  open: boolean;
  conversations: GuestConversationSummary[];
  defaultConversationId: string | null;
  onSkip: () => void;
  onComplete: (conversationIdToOpen: string | null) => void | Promise<void>;
};

export function GuestImportModal({
  open,
  conversations,
  defaultConversationId,
  onSkip,
  onComplete,
}: GuestImportModalProps) {
  const { t } = useLanguage();
  const [isImporting, setIsImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  if (!open || conversations.length === 0) return null;

  const runImport = async (targets: GuestConversationSummary[]) => {
    setIsImporting(true);
    let succeeded = 0;
    const failedIds: string[] = [];
    let conversationIdToOpen: string | null = null;

    for (const target of targets) {
      const payload = buildGuestImportPayload(target.id);
      if (!payload) {
        failedIds.push(target.id);
        continue;
      }
      const result = await importGuestConversation(payload);
      if (result.success) {
        succeeded += 1;
        if (target.id === defaultConversationId || !conversationIdToOpen) {
          conversationIdToOpen = result.conversationId;
        }
      } else {
        failedIds.push(target.id);
      }
    }

    setIsImporting(false);

    if (failedIds.length === 0) {
      await onComplete(conversationIdToOpen);
      return;
    }

    setSummary({ succeeded, failed: failedIds.length, failedIds });
  };

  const handleImportCurrentOnly = () => {
    const target =
      conversations.find((c) => c.id === defaultConversationId) || conversations[0];
    void runImport([target]);
  };

  const handleImportAll = () => {
    void runImport(conversations);
  };

  const handleRetryFailed = () => {
    if (!summary) return;
    const failedConversations = conversations.filter((c) => summary.failedIds.includes(c.id));
    setSummary(null);
    void runImport(failedConversations);
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="guest-import-modal-title"
    >
      <button
        type="button"
        className="absolute inset-0 h-full w-full cursor-default"
        onClick={() => !isImporting && onSkip()}
        aria-label={t("auth.cancel")}
      />
      <div className="relative z-10 w-full max-w-sm rounded-t-3xl border border-zinc-200 bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 sm:rounded-3xl sm:pb-5">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700 sm:hidden" />
        <div className="flex items-start justify-between gap-3">
          <h2
            id="guest-import-modal-title"
            className="text-base font-black text-zinc-900 dark:text-zinc-100"
          >
            {t("chat.guestImportModalTitle")}
          </h2>
          <button
            type="button"
            onClick={() => !isImporting && onSkip()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 dark:hover:bg-zinc-900"
            aria-label={t("auth.cancel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          {t("chat.guestImportModalBody")}
        </p>

        {summary ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              {interpolateCopy(t("chat.guestImportSummary"), {
                success: summary.succeeded,
                failed: summary.failed,
              })}
            </p>
            <button
              type="button"
              onClick={handleRetryFailed}
              disabled={isImporting}
              className="flex items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-black text-white transition hover:bg-blue-500 disabled:opacity-60"
            >
              {t("chat.guestImportRetry")}
            </button>
            <button
              type="button"
              onClick={() => onSkip()}
              className="text-center text-sm font-semibold text-zinc-500 transition hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              {t("auth.cancel")}
            </button>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              onClick={handleImportCurrentOnly}
              disabled={isImporting}
              className="flex items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-black text-white transition hover:bg-blue-500 disabled:opacity-60"
            >
              {t("chat.guestImportCurrentOnly")}
            </button>
            <button
              type="button"
              onClick={handleImportAll}
              disabled={isImporting}
              className="flex items-center justify-center rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-black text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              {interpolateCopy(t("chat.guestImportAll"), { count: conversations.length })}
            </button>
            <button
              type="button"
              onClick={() => onSkip()}
              disabled={isImporting}
              className="mt-1 text-center text-sm font-semibold text-zinc-500 transition hover:text-zinc-700 disabled:opacity-60 dark:hover:text-zinc-300"
            >
              {t("chat.guestImportSkip")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
