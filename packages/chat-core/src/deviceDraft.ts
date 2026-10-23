export type DraftStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; key(index: number): string | null; readonly length: number };
const PREFIX = "tomverse-device-draft:";
export const deviceDraftKey = (owner: string, conversation: string | null) => `${PREFIX}${encodeURIComponent(owner)}:${encodeURIComponent(conversation ?? "new")}`;
export function readDeviceDraft(storage: DraftStorage, owner: string, conversation: string | null, now = Date.now()): string {
  try {
    const key = deviceDraftKey(owner, conversation);
    const item = JSON.parse(storage.getItem(key) ?? "null");
    if (item && typeof item.text === "string" && item.text.length <= 40000 && typeof item.savedAt === "number" && item.savedAt <= now && now - item.savedAt < 86400000) return item.text;
    storage.removeItem(key);
  } catch { /* Storage is optional; input remains usable. */ }
  return "";
}
export function writeDeviceDraft(storage: DraftStorage, owner: string, conversation: string | null, text: string) {
  try { const key = deviceDraftKey(owner, conversation); if (text) storage.setItem(key, JSON.stringify({ text: text.slice(0, 40000), savedAt: Date.now() })); else storage.removeItem(key); } catch { /* Input remains in memory. */ }
}
export function clearDeviceDrafts(storage: DraftStorage) {
  try { for (let i = storage.length - 1; i >= 0; i--) { const key = storage.key(i); if (key?.startsWith(PREFIX)) storage.removeItem(key); } } catch { /* Storage may be unavailable. */ }
}
