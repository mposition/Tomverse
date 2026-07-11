"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, CalendarClock, Clipboard, Clock, Eye, LockKeyhole, Share2, UserRound } from "lucide-react";
import { getModel } from "@/lib/models";
import type { ShareSnapshot } from "@/lib/shareSnapshot";
import { useLanguage } from "@/components/LanguageProvider";

type SharedConversationData = {
  snapshot: ShareSnapshot;
  expiresAt: string;
};

function formatDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function getAssistantLabel(modelId: string | null | undefined, fallback: string) {
  if (!modelId) return fallback;
  return getModel(modelId)?.name || modelId;
}

export function SharedConversationView({
  shareToken,
}: {
  shareToken: string;
}) {
  const [data, setData] = useState<SharedConversationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState("all");
  const { t, lang } = useLanguage();
  const snapshot = data?.snapshot;
  const modelOptions = useMemo(() => {
    if (!snapshot) return [];
    const ids = Array.from(
      new Set(
        snapshot.messages
          .map((message) => message.modelId)
          .filter((modelId): modelId is string => !!modelId)
      )
    );
    return ids.map((modelId) => ({
      id: modelId,
      name: getAssistantLabel(modelId, t("share.assistant")),
    }));
  }, [snapshot, t]);
  const visibleMessages = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.messages.filter(
      (message) =>
        modelFilter === "all" ||
        message.role === "user" ||
        message.modelId === modelFilter
    );
  }, [modelFilter, snapshot]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/public/shares/${encodeURIComponent(shareToken)}`, {
      signal: controller.signal,
      credentials: "omit",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            response.status === 429
              ? t("share.tooManyRequests")
              : t("share.unavailable")
          );
        }
        return (await response.json()) as SharedConversationData;
      })
      .then(setData)
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") {
          return;
        }
        setError(
          requestError instanceof Error
            ? requestError.message
            : t("share.unavailable")
        );
      });
    return () => controller.abort();
  }, [shareToken, t]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-100 px-5 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-100">
        <div className="max-w-md rounded-3xl border border-zinc-200 bg-white p-8 text-center shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-500">
            <LockKeyhole className="h-6 w-6" />
          </div>
          <h1 className="mt-5 text-xl font-semibold">{t("share.unavailableTitle")}</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-500">{error}</p>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-100 text-sm text-zinc-500 dark:bg-zinc-950">
        <div className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white px-5 py-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          {t("share.loading")}
        </div>
      </main>
    );
  }

  const loadedSnapshot = data.snapshot;
  const { expiresAt } = data;
  const copyMessage = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {}
  };
  return (
    <main className="min-h-screen overflow-y-auto bg-zinc-100 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-5 py-6 md:px-8">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-4">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white ring-1 ring-zinc-200 shadow-sm dark:ring-zinc-800">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/tomverse-logo.png" alt="Tomverse AI" className="h-full w-full object-cover" />
              </span>
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-zinc-500">
                  <Share2 className="h-3.5 w-3.5" />
                  {t("share.eyebrow")}
                </p>
                <h1 className="mt-2 truncate text-2xl font-bold tracking-tight text-zinc-950 dark:text-white md:text-3xl">
                  {loadedSnapshot.title}
                </h1>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-semibold text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
              <Eye className="h-3.5 w-3.5" />
              {t("share.readOnly")}
            </div>
          </div>
          <div className="grid gap-2 text-xs text-zinc-500 sm:grid-cols-3">
            <span className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
              <CalendarClock className="h-3.5 w-3.5" />
              {t("share.created")} {formatDate(loadedSnapshot.conversationCreatedAt, lang)}
            </span>
            <span className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
              <Share2 className="h-3.5 w-3.5" />
              {t("share.snapshot")} {formatDate(loadedSnapshot.sharedAt, lang)}
            </span>
            <span className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
              <Clock className="h-3.5 w-3.5" />
              {t("share.expires")} {formatDate(expiresAt, lang)}
            </span>
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">
                Document controls
              </p>
              <p className="mt-1 text-xs text-zinc-400">
                Filter by model, jump through the outline, or copy useful messages.
              </p>
            </div>
            <select
              value={modelFilter}
              onChange={(event) => setModelFilter(event.target.value)}
              className="h-10 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
            >
              <option value="all">All models</option>
              {modelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </div>
          {modelOptions.length > 0 && (
            <nav className="flex gap-2 overflow-x-auto text-xs">
              {modelOptions.map((model) => (
                <a
                  key={model.id}
                  href={`#model-${encodeURIComponent(model.id)}`}
                  className="shrink-0 rounded-full border border-zinc-200 bg-white px-3 py-1.5 font-semibold text-zinc-600 hover:border-blue-300 hover:text-blue-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
                >
                  {model.name}
                </a>
              ))}
            </nav>
          )}
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-5 py-8 md:px-8">
        {loadedSnapshot.messages.length === 0 ? (
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            {t("share.noMessages")}
          </div>
        ) : (
          visibleMessages.map((message) => {
            const isUser = message.role === "user";
            const label = isUser ? t("share.user") : getAssistantLabel(message.modelId, t("share.assistant"));
            return (
              <article
                key={message.id}
                id={!isUser && message.modelId ? `model-${encodeURIComponent(message.modelId)}` : undefined}
                className={`flex w-full flex-col ${
                  isUser ? "items-end" : "items-start"
                }`}
              >
                <div
                  className={`mb-1.5 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                    isUser
                      ? "border-blue-600 bg-blue-600 text-white"
                      : "border-zinc-200 bg-white text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
                  }`}
                >
                  {isUser ? <UserRound className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                  {label}
                </div>
                <div
                  className={`max-w-[92%] whitespace-pre-wrap rounded-2xl border px-4 py-3 text-sm leading-6 shadow-sm md:max-w-[82%] ${
                    isUser
                      ? "rounded-br-md border-blue-600 bg-blue-600 text-white"
                      : "rounded-bl-md border-zinc-200 bg-white text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                  }`}
                >
                  {message.content}
                </div>
                <div className="mt-1 flex items-center gap-2 px-1">
                  <time className="text-[11px] text-zinc-400">
                    {formatDate(message.createdAt, lang)}
                  </time>
                  <button
                    type="button"
                    onClick={() => void copyMessage(message.content)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-zinc-400 hover:text-blue-500"
                  >
                    <Clipboard className="h-3 w-3" />
                    Copy
                  </button>
                </div>
              </article>
            );
          })
        )}
      </section>
    </main>
  );
}
