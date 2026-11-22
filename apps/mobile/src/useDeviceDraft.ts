import { useCallback, useState } from "react";
import { deviceDraftKey, readDeviceDraft, writeDeviceDraft, clearDeviceDrafts } from "@tomverse/chat-core/device-draft";

// The in-memory copy is the source of truth for this app session; device storage
// is optional persistence (24 h) and may throw, be full or lag behind.
const memory = new Map<string, string>();
const remember = (owner: string, conversation: string | null, text: string) => {
  const key = deviceDraftKey(owner, conversation);
  if (text) memory.set(key, text); else memory.delete(key);
};
export const clearNativeDrafts = () => { memory.clear(); try { clearDeviceDrafts(localStorage); } catch { /* Storage may be disabled. */ } };
export const preserveNativeDraft = (owner: string | null, conversation: string | null, text: string) => {
  if (!owner) return;
  remember(owner, conversation, text);
  try { writeDeviceDraft(localStorage, owner, conversation, text); } catch { /* Optional persistence. */ }
};
/** Memory first, then device storage; never throws. */
export function readNativeDraftText(owner: string | null, conversation: string | null) {
  if (!owner) return "";
  const held = memory.get(deviceDraftKey(owner, conversation));
  if (held !== undefined) return held;
  try { return readDeviceDraft(localStorage, owner, conversation); } catch { return ""; }
}
export function useDeviceDraft(owner: string | null, conversation: string | null) {
  const [snapshot, setSnapshot] = useState(() => ({ owner, conversation, text: readNativeDraftText(owner, conversation) }));
  if (snapshot.owner !== owner || snapshot.conversation !== conversation) {
    setSnapshot({ owner, conversation, text: readNativeDraftText(owner, conversation) });
  }
  const update = useCallback((text: string, targetConversation: string | null = conversation) => {
    setSnapshot({ owner, conversation: targetConversation, text });
    preserveNativeDraft(owner, targetConversation, text);
  }, [owner, conversation]);
  return [snapshot.text, update] as const;
}
