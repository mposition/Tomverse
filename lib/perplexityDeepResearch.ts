import "server-only";

import type { ModelMessage } from "ai";
import {
  parsePerplexityUsageCost,
  type PerplexityUsageCostSnapshot,
} from "@/lib/perplexityUsageCore";

// Perplexity's "sonar-deep-research" model does not stream like every other
// model in this app's catalog -- it's a long-running research job (can run
// well past 30 minutes) submitted via a dedicated async endpoint and polled
// for completion. This module owns that submit/poll HTTP contract; it's kept
// separate from lib/perplexityUsageCapture.ts because that module's `fetch`-
// wrapping trick is architecturally tied to one long-lived streamed response,
// which doesn't apply here -- each poll is a short, independent HTTP call.
const PERPLEXITY_ASYNC_BASE_URL = "https://api.perplexity.ai/v1/async/sonar";

export class PerplexityDeepResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerplexityDeepResearchError";
  }
}

type PlainChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const toPlainTextContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          Boolean(part) &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
};

// Deep research is text-only research, not multimodal -- non-text parts
// (images, files, tool calls) are dropped rather than causing a request
// failure, since the model has no way to act on them regardless.
export const toPlainDeepResearchMessages = (
  messages: ModelMessage[]
): PlainChatMessage[] =>
  messages
    .filter(
      (message): message is ModelMessage & { role: "system" | "user" | "assistant" } =>
        message.role === "system" ||
        message.role === "user" ||
        message.role === "assistant"
    )
    .map((message) => ({
      role: message.role,
      content: toPlainTextContent(message.content),
    }))
    .filter((message) => message.content.trim().length > 0);

const getApiKey = () => {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new PerplexityDeepResearchError(
      "Perplexity API key is not configured."
    );
  }
  return apiKey;
};

export const submitDeepResearchJob = async ({
  messages,
  maxOutputTokens,
  reasoningEffort,
}: {
  messages: ModelMessage[];
  maxOutputTokens: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}): Promise<{ perplexityJobId: string }> => {
  const apiKey = getApiKey();
  const response = await fetch(PERPLEXITY_ASYNC_BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      request: {
        model: "sonar-deep-research",
        messages: toPlainDeepResearchMessages(messages),
        max_tokens: maxOutputTokens,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new PerplexityDeepResearchError(
      `Perplexity async submit failed: ${response.status} ${errorBody.slice(0, 500)}`
    );
  }

  const data = (await response.json().catch(() => null)) as { id?: unknown } | null;
  if (!data || typeof data.id !== "string" || !data.id) {
    throw new PerplexityDeepResearchError(
      "Perplexity async submit response is missing a job id."
    );
  }

  return { perplexityJobId: data.id };
};

const ASYNC_STATUS_VALUES = new Set([
  "CREATED",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
]);

export type DeepResearchJobStatus =
  | "CREATED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED";

export type DeepResearchPollResult = {
  status: DeepResearchJobStatus;
  content?: string;
  usageSnapshot?: PerplexityUsageCostSnapshot | null;
  inputTokens?: number;
  outputTokens?: number;
  errorMessage?: string;
};

export const pollDeepResearchJob = async (
  perplexityJobId: string
): Promise<DeepResearchPollResult> => {
  const apiKey = getApiKey();
  const response = await fetch(
    `${PERPLEXITY_ASYNC_BASE_URL}/${encodeURIComponent(perplexityJobId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    }
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new PerplexityDeepResearchError(
      `Perplexity async poll failed: ${response.status} ${errorBody.slice(0, 500)}`
    );
  }

  const data = (await response.json().catch(() => null)) as {
    status?: unknown;
    response?: {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: unknown;
    } | null;
    error_message?: unknown;
  } | null;

  const status: DeepResearchJobStatus =
    data && typeof data.status === "string" && ASYNC_STATUS_VALUES.has(data.status)
      ? (data.status as DeepResearchJobStatus)
      : "IN_PROGRESS";

  if (status === "FAILED") {
    return {
      status,
      errorMessage:
        data && typeof data.error_message === "string"
          ? data.error_message
          : "The Perplexity deep research job failed.",
    };
  }

  if (status !== "COMPLETED") {
    return { status };
  }

  const content = data?.response?.choices?.[0]?.message?.content;
  const usageSnapshot = parsePerplexityUsageCost(data?.response);

  return {
    status,
    content: typeof content === "string" ? content : "",
    usageSnapshot,
    inputTokens: usageSnapshot?.promptTokens ?? undefined,
    outputTokens: usageSnapshot?.completionTokens ?? undefined,
  };
};
