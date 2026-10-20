/** Easy follows a provider across per-turn model changes without mixing peers. */
export function reviewProviderPanels(
  modelIds: readonly string[], disabled: readonly string[], resolveProvider: (id: string) => string | undefined
): string[] {
  const selected = new Map<string, string>();
  for (const id of [...modelIds.filter(id => !disabled.includes(id)), ...modelIds.filter(id => disabled.includes(id))]) {
    const provider = resolveProvider(id);
    if (provider && !selected.has(provider)) selected.set(provider, id);
  }
  return [...selected.values()];
}

export function reviewProviderTranscript<T extends { role: string; modelId?: string | null }>(
  messages: readonly T[], provider: string, resolveProvider: (modelId: string) => string | undefined
): T[] {
  return messages.filter(message => message.role !== "assistant" ||
    Boolean(message.modelId && resolveProvider(message.modelId) === provider));
}
