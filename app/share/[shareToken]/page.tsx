import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { isValidShareTokenFormat } from "@/lib/shareTokens";

const modelNames: Record<string, string> = {
  "gpt-4o": "GPT-4o",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "gemini-1-5": "Gemini 1.5",
};

const modelAccents: Record<string, string> = {
  "gpt-4o": "border-emerald-200 bg-emerald-50 text-emerald-700",
  "claude-haiku-4-5": "border-orange-200 bg-orange-50 text-orange-700",
  "gemini-1-5": "border-blue-200 bg-blue-50 text-blue-700",
};

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function getAssistantLabel(modelId?: string | null) {
  if (!modelId) return "Assistant";
  return modelNames[modelId] || modelId;
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

  const conversation = await prisma.conversation.findFirst({
    where: {
      shareToken,
      shareEnabled: true,
    },
    select: {
      title: true,
      sharedAt: true,
      createdAt: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          role: true,
          content: true,
          modelId: true,
          createdAt: true,
        },
      },
    },
  });

  if (!conversation) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 py-6 md:px-8">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                Tomverse shared conversation
              </p>
              <h1 className="mt-2 truncate text-2xl font-semibold text-zinc-950 md:text-3xl">
                {conversation.title}
              </h1>
            </div>
            <div className="shrink-0 rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-500">
              Read only
            </div>
          </div>

          <div className="flex flex-wrap gap-2 text-xs text-zinc-500">
            <span>Created {formatDate(conversation.createdAt)}</span>
            {conversation.sharedAt && <span>Shared {formatDate(conversation.sharedAt)}</span>}
          </div>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-5 py-8 md:px-8">
        {conversation.messages.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-6 text-center text-sm text-zinc-500">
            No messages were shared.
          </div>
        ) : (
          conversation.messages.map((message) => {
            const isUser = message.role === "user";
            const label = isUser ? "User" : getAssistantLabel(message.modelId);
            const accent = message.modelId ? modelAccents[message.modelId] : undefined;

            return (
              <article
                key={message.id}
                className={`flex w-full flex-col ${isUser ? "items-end" : "items-start"}`}
              >
                <div
                  className={`mb-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                    isUser
                      ? "border-zinc-300 bg-zinc-900 text-white"
                      : accent || "border-zinc-200 bg-white text-zinc-600"
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
