import "server-only";

import type { Prisma } from "@prisma/client";
import type { ModelMessage } from "ai";

const MAX_PROVIDER_CONTEXT_BYTES = 2 * 1024 * 1024;

const isResponseMessage = (value: unknown): value is ModelMessage => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant" && candidate.role !== "tool") return false;
  return (
    typeof candidate.content === "string" || Array.isArray(candidate.content)
  );
};

export type SerializedProviderContext = {
  messages: Prisma.InputJsonValue;
  byteLength: number;
};

/**
 * Produces bounded, JSON-only provider state for a private side table.
 * Reasoning is intentionally not returned to the browser or public exports.
 */
export const serializeProviderResponseMessages = (
  value: unknown
): SerializedProviderContext | null => {
  if (!Array.isArray(value) || !value.every(isResponseMessage)) return null;
  const serialized = JSON.stringify(value);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength === 0 || byteLength > MAX_PROVIDER_CONTEXT_BYTES) return null;
  return {
    messages: JSON.parse(serialized) as Prisma.InputJsonValue,
    byteLength,
  };
};

export const parseProviderResponseMessages = (
  value: unknown
): ModelMessage[] | null => {
  if (!Array.isArray(value) || !value.every(isResponseMessage)) return null;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROVIDER_CONTEXT_BYTES) {
    return null;
  }
  return JSON.parse(serialized) as ModelMessage[];
};

/** Visible text plus private reasoning/tool text for conservative input sizing. */
export const providerContextText = (messages: readonly ModelMessage[]) =>
  messages
    .flatMap((message) => {
      if (typeof message.content === "string") return [message.content];
      return message.content.map((part) => {
        if ("text" in part && typeof part.text === "string") return part.text;
        if ("output" in part) return JSON.stringify(part.output);
        if ("input" in part) return JSON.stringify(part.input);
        return "";
      });
    })
    .filter(Boolean)
    .join("\n");
