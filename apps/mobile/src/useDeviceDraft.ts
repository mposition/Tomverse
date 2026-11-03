import { useCallback, useState } from "react";
import { readDeviceDraft, writeDeviceDraft, clearDeviceDrafts } from "@tomverse/chat-core/device-draft";

export const clearNativeDrafts = () => { try { clearDeviceDrafts(localStorage); } catch { /* Storage may be disabled. */ } };
export const preserveNativeDraft = (owner: string | null, conversation: string, text: string) => { if (owner) { try { writeDeviceDraft(localStorage, owner, conversation, text); } catch { /* Optional persistence. */ } } };
export function useDeviceDraft(owner: string | null, conversation: string | null) {
  const read = () => { try { return owner ? readDeviceDraft(localStorage, owner, conversation) : ""; } catch { return ""; } };
  const [snapshot, setSnapshot] = useState(() => ({ owner, conversation, text: read() }));
  if (snapshot.owner !== owner || snapshot.conversation !== conversation) {
    setSnapshot({ owner, conversation, text: read() });
  }
  const update = useCallback((text: string, targetConversation: string | null = conversation) => {
    setSnapshot({ owner, conversation: targetConversation, text });
    if (owner) { try { writeDeviceDraft(localStorage, owner, targetConversation, text); } catch { /* Input remains in memory. */ } }
  }, [owner, conversation]);
  return [snapshot.text, update] as const;
}
