"use client";

import { useEffect, useState } from "react";
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
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-5 text-zinc-950">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold">Shared conversation unavailable</h1>
          <p className="mt-2 text-sm text-zinc-500">{error}</p>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        Loading shared conversation...
      </main>
    );
  }

  const { snapshot, expiresAt } = data;
  return (
    <main className="min-h-screen overflow-y-auto bg-zinc-50 text-zinc-950">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 py-6 md:px-8">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase text-zinc-500">
                Tomverse shared conversation
              </p>
              <h1 className="mt-2 truncate text-2xl font-semibold text-zinc-950 md:text-3xl">
                {snapshot.title}
              </h1>
            </div>
            <div className="shrink-0 rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-500">
              Read only
            </div>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
            <span>Created {formatDate(snapshot.conversationCreatedAt)}</span>
            <span>Snapshot {formatDate(snapshot.sharedAt)}</span>
            <span>Expires {formatDate(expiresAt)}</span>
          </div>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-5 py-8 md:px-8">
        {snapshot.messages.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500">
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
                  className={`mb-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                    isUser
                      ? "border-zinc-300 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-white text-zinc-600"
                  }`}
                >
                  {label}
                </div>
                <div
                  className={`max-w-[92%] whitespace-pre-wrap rounded-lg border px-4 py-3 text-sm leading-6 shadow-sm md:max-w-[82%] ${
                    isUser
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-white text-zinc-800"
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
