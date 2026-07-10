"use client";

import { useEffect, useState } from "react";
import { Bot, CalendarClock, Clock, Eye, LockKeyhole, Share2, UserRound } from "lucide-react";
import { getModel } from "@/lib/models";
import type { ShareSnapshot } from "@/lib/shareSnapshot";

type SharedConversationData = {
  snapshot: ShareSnapshot;
  expiresAt: string;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function getAssistantLabel(modelId?: string | null) {
  if (!modelId) return "Assistant";
  return getModel(modelId)?.name || modelId;
}

export function SharedConversationView({
  shareToken,
}: {
  shareToken: string;
}) {
  const [data, setData] = useState<SharedConversationData | null>(null);
  const [error, setError] = useState<string | null>(null);

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
              ? "Too many requests. Please try again shortly."
              : "This shared conversation is unavailable."
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
            : "This shared conversation is unavailable."
        );
      });
    return () => controller.abort();
  }, [shareToken]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-100 px-5 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-100">
        <div className="max-w-md rounded-3xl border border-zinc-200 bg-white p-8 text-center shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-500">
            <LockKeyhole className="h-6 w-6" />
          </div>
          <h1 className="mt-5 text-xl font-semibold">Shared conversation unavailable</h1>
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
          Loading shared conversation...
        </div>
      </main>
    );
  }

  const { snapshot, expiresAt } = data;
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
                  Tomverse shared conversation
                </p>
                <h1 className="mt-2 truncate text-2xl font-bold tracking-tight text-zinc-950 dark:text-white md:text-3xl">
                  {snapshot.title}
                </h1>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs font-semibold text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
              <Eye className="h-3.5 w-3.5" />
              Read only
            </div>
          </div>
          <div className="grid gap-2 text-xs text-zinc-500 sm:grid-cols-3">
            <span className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
              <CalendarClock className="h-3.5 w-3.5" />
              Created {formatDate(snapshot.conversationCreatedAt)}
            </span>
            <span className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
              <Share2 className="h-3.5 w-3.5" />
              Snapshot {formatDate(snapshot.sharedAt)}
            </span>
            <span className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
              <Clock className="h-3.5 w-3.5" />
              Expires {formatDate(expiresAt)}
            </span>
          </div>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-5 py-8 md:px-8">
        {snapshot.messages.length === 0 ? (
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            No messages were shared.
          </div>
        ) : (
          snapshot.messages.map((message) => {
            const isUser = message.role === "user";
            const label = isUser ? "User" : getAssistantLabel(message.modelId);
            return (
              <article
                key={message.id}
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
                <time className="mt-1 px-1 text-[11px] text-zinc-400">
                  {formatDate(message.createdAt)}
                </time>
              </article>
            );
          })
        )}
      </section>
    </main>
  );
}
