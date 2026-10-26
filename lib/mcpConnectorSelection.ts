// Tab-local explicit choices. No automatic restore, cross-account sharing,
// or copying a connection into a new conversation.
const selection = new Map<string, string>();
const listeners = new Set<() => void>();
export const selectedMcpConnection = (conversationId?: string | null) => selection.get(conversationId || "new");
export function selectMcpConnection(conversationId: string | null | undefined, id?: string) {
  const key = conversationId || "new";
  if (id) selection.set(key, id); else selection.delete(key);
  for (const listener of listeners) listener();
}
export function subscribeMcpSelection(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
