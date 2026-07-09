import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getModel } from "@/lib/models";
import { shareSnapshotSchema } from "@/lib/shareSnapshot";
import { isValidShareTokenFormat } from "@/lib/shareTokens";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
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

export default async function SharedConversationPage({
  params,
}: {
  params: Promise<{ shareToken: string }>;
}) {
  const { shareToken } = await params;
  if (!isValidShareTokenFormat(shareToken)) {
    notFound();
  }

  const sharedConversation = await prisma.conversation.findFirst({
    where: {
      shareToken,
      shareEnabled: true,
      shareExpiresAt: { gt: new Date() },
    },
    select: {
      shareSnapshot: true,
      shareExpiresAt: true,
    },
  });
  const parsedSnapshot = shareSnapshotSchema.safeParse(
    sharedConversation?.shareSnapshot
  );
  if (
    !sharedConversation?.shareExpiresAt ||
    !parsedSnapshot.success
  ) {
    notFound();
  }

  const snapshot = parsedSnapshot.data;

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
            <span>
              Expires {formatDate(sharedConversation.shareExpiresAt.toISOString())}
            </span>
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
