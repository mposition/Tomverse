/** Easy follows a provider across per-turn model changes without mixing peers. */
export function reviewProviderTranscript<T extends { role: string; modelId?: string | null }>(
  messages: readonly T[], provider: string, resolveProvider: (modelId: string) => string | undefined
): T[] {
  return messages.filter(message => message.role !== "assistant" ||
    Boolean(message.modelId && resolveProvider(message.modelId) === provider));
}
