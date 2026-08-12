import "server-only";

import type { ModelMessage } from "ai";
import { resolveProviderApiKey } from "@/lib/modelRegistryShared";
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
  // STG-R002: the HTTP status is carried as structured data rather than left
  // embedded in the message text. Provider health classification must be able
  // to tell "400, we sent a malformed request" apart from "503, Perplexity is
  // down" without pattern-matching a sentence.
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "PerplexityDeepResearchError";
  }
}

// A request this app built wrong -- no user turn survives normalization, so
// there is nothing to research. Distinct from PerplexityDeepResearchError so
// callers can tell "we never even asked Perplexity" from "Perplexity failed",
// and keep a local bug out of the provider's failure statistics.
export class PerplexityDeepResearchMessageError extends PerplexityDeepResearchError {
  constructor(message: string) {
    super(message);
    this.name = "PerplexityDeepResearchMessageError";
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

// Unlike the OpenAI-compatible sync endpoint every other Perplexity model
// (and every other provider) goes through, the async endpoint strictly
// rejects two consecutive messages of the same role with a 400 --
// "user or tool message(s) should alternate with assistant message(s)".
// This app's stored history isn't guaranteed to already alternate (e.g. a
// dropped empty assistant turn, or a tool-role message filtered out above
// leaving two user turns adjacent), so consecutive same-role messages are
// merged into one instead of sent as-is.
const collapseConsecutiveSameRole = (
  messages: PlainChatMessage[]
): PlainChatMessage[] =>
  messages.reduce<PlainChatMessage[]>((collapsed, message) => {
    const previous = collapsed[collapsed.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = `${previous.content}\n\n${message.content}`;
    } else {
      collapsed.push({ ...message });
    }
    return collapsed;
  }, []);

// Everything a failed submit may be logged with. Roles and counts only: the
// shape of a request is what decides whether it was well-formed, and message
// content must never reach a log line.
export type DeepResearchMessageMetadata = {
  inputMessageCount: number;
  inputRoleSequence: string;
  normalizedMessageCount: number;
  normalizedRoleSequence: string;
  hasLeadingAssistant: boolean;
  droppedLeadingAssistantCount: number;
  droppedTrailingAssistantCount: number;
  misplacedSystemCount: number;
};

const ROLE_CODES: Record<string, string> = {
  system: "s",
  user: "u",
  assistant: "a",
  tool: "t",
};
// Long conversations still produce a bounded log field.
const MAX_DESCRIBED_ROLES = 80;

const describeRoleSequence = (roles: string[]): string => {
  const described = roles
    .slice(0, MAX_DESCRIBED_ROLES)
    .map((role) => ROLE_CODES[role] ?? "?")
    .join("");
  return roles.length > MAX_DESCRIBED_ROLES
    ? `${described}+${roles.length - MAX_DESCRIBED_ROLES}`
    : described;
};

// Deep research is text-only research, not multimodal -- non-text parts
// (images, files, tool calls) are dropped rather than causing a request
// failure, since the model has no way to act on them regardless.
//
// The result is then forced into the exact shape Perplexity's async endpoint
// accepts: "after the (optional) system message(s), user or tool message(s)
// should alternate with assistant message(s)". Anything this app can put in
// front of the first user turn -- most concretely the chat shell's UI-only
// "welcome" bubble on an empty conversation -- is a 400 from the provider,
// so it is removed here rather than trusted not to be sent.
export const normalizeDeepResearchMessages = (
  messages: ModelMessage[]
): { messages: PlainChatMessage[]; metadata: DeepResearchMessageMetadata } => {
  const plain = messages
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

  // System messages are only legal ahead of the conversation, and only the
  // contiguous block at the very start is accepted. A system message that
  // appears once the conversation has begun is NOT quietly moved to the
  // front: hoisting would silently change instruction order and authority
  // the day this app starts sending a real system prompt. It is counted
  // here and rejected locally by toPlainDeepResearchMessages below.
  const firstConversationIndex = plain.findIndex(
    (message) => message.role !== "system"
  );
  const leadingSystemMessages =
    firstConversationIndex === -1 ? plain : plain.slice(0, firstConversationIndex);
  const rest =
    firstConversationIndex === -1 ? [] : plain.slice(firstConversationIndex);
  const misplacedSystemCount = rest.filter(
    (message) => message.role === "system"
  ).length;
  const conversation = rest.filter((message) => message.role !== "system");

  const firstUserIndex = conversation.findIndex(
    (message) => message.role === "user"
  );
  const hasLeadingAssistant = conversation[0]?.role === "assistant";
  // An assistant turn before the first user turn has nothing to answer --
  // it is a UI placeholder, not conversation history.
  const droppedLeadingAssistantCount =
    firstUserIndex === -1 ? conversation.length : firstUserIndex;

  const alternating = collapseConsecutiveSameRole(
    firstUserIndex === -1 ? [] : conversation.slice(firstUserIndex)
  );

  // The provider must be left answering a user turn, never its own reply.
  let droppedTrailingAssistantCount = 0;
  while (alternating[alternating.length - 1]?.role === "assistant") {
    alternating.pop();
    droppedTrailingAssistantCount += 1;
  }

  const normalized = [
    ...collapseConsecutiveSameRole(leadingSystemMessages),
    ...alternating,
  ];

  return {
    messages: normalized,
    metadata: {
      inputMessageCount: messages.length,
      inputRoleSequence: describeRoleSequence(
        messages.map((message) => String(message.role))
      ),
      normalizedMessageCount: normalized.length,
      normalizedRoleSequence: describeRoleSequence(
        normalized.map((message) => message.role)
      ),
      hasLeadingAssistant,
      droppedLeadingAssistantCount,
      droppedTrailingAssistantCount,
      misplacedSystemCount,
    },
  };
};

/** Roles and counts for a request, for logging. Never throws. */
export const describeDeepResearchMessages = (
  messages: ModelMessage[]
): DeepResearchMessageMetadata => normalizeDeepResearchMessages(messages).metadata;

export const toPlainDeepResearchMessages = (
  messages: ModelMessage[]
): PlainChatMessage[] => {
  const { messages: normalized, metadata } = normalizeDeepResearchMessages(messages);

  // Both rejections below keep the request off the wire entirely, so a
  // malformed submit costs one local error instead of a provider 400 counted
  // against Perplexity.
  if (metadata.misplacedSystemCount > 0) {
    throw new PerplexityDeepResearchMessageError(
      `Deep research accepts system messages only before the conversation starts (roles: ${metadata.inputRoleSequence}).`
    );
  }

  // Without a user turn there is no question to research.
  if (!normalized.some((message) => message.role === "user")) {
    throw new PerplexityDeepResearchMessageError(
      `Deep research requires at least one user message (roles: ${metadata.inputRoleSequence || "none"}).`
    );
  }

  return normalized;
};

// Perplexity's async submit takes max_tokens/reasoning_effort directly (no
// documented "depth" parameter of its own) -- these tiers are this app's own
// mapping onto those two real knobs, not a Perplexity concept. "standard"
// matches the flat values this integration already shipped and ran
// successfully with; "quick" trades completeness for a lower cap and no
// forced high reasoning effort; "deep" is a conservative increase over
// "standard", not pushed further without first confirming Perplexity's real
// ceiling for this model.
export type DeepResearchDepth = "quick" | "standard" | "deep";

export const DEEP_RESEARCH_DEPTH_PARAMS: Record<
  DeepResearchDepth,
  { maxOutputTokens: number; reasoningEffort?: "high" }
> = {
  quick: { maxOutputTokens: 8_000 },
  standard: { maxOutputTokens: 24_000, reasoningEffort: "high" },
  deep: { maxOutputTokens: 32_000, reasoningEffort: "high" },
};

const getApiKey = () => {
  const apiKey = resolveProviderApiKey("perplexity");
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
  // Normalized (and validated) before anything else, so a malformed
  // conversation never reaches the network.
  const requestMessages = toPlainDeepResearchMessages(messages);
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
        messages: requestMessages,
        max_tokens: maxOutputTokens,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
    }),
  });

  if (!response.ok) {
    throw new PerplexityDeepResearchError(
      `Perplexity async submit failed with HTTP ${response.status}.`,
      response.status
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
    throw new PerplexityDeepResearchError(
      `Perplexity async poll failed with HTTP ${response.status}.`,
      response.status
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
      errorMessage: "The Perplexity deep research job failed.",
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
