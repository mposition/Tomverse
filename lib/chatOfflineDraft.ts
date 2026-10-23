export const OFFLINE_DRAFT_KEY = "tomverse-offline-draft";
export const OFFLINE_DRAFT_OWNER_KEY = "tomverse-offline-owner";
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function clearOfflineChatDraft(storage?: StoragePort) {
  try { const target = storage ?? sessionStorage; target.removeItem(OFFLINE_DRAFT_KEY); target.removeItem(OFFLINE_DRAFT_OWNER_KEY); } catch { /* Storage is optional. */ }
}
export function clearOfflineAccountDraft(storage?: StoragePort) {
  try { const target = storage ?? sessionStorage; if (target.getItem(OFFLINE_DRAFT_OWNER_KEY)?.startsWith("account:")) clearOfflineChatDraft(target); } catch { /* Storage is optional. */ }
}
export function bindOfflineChatDraftOwner(owner: string | null, storage?: StoragePort) {
  if (!owner) return;
  try {
    const target = storage ?? sessionStorage;
    if (target.getItem(OFFLINE_DRAFT_OWNER_KEY) !== owner) target.removeItem(OFFLINE_DRAFT_KEY);
    target.setItem(OFFLINE_DRAFT_OWNER_KEY, owner);
  } catch { /* Offline persistence is optional. */ }
}
export function readOfflineChatDraft(owner: string | null, storage?: StoragePort): string {
  if (!owner) return "";
  try {
    const target = storage ?? sessionStorage;
    if (target.getItem(OFFLINE_DRAFT_OWNER_KEY) !== owner) return "";
    const record = JSON.parse(target.getItem(OFFLINE_DRAFT_KEY) ?? "null");
    return record?.owner === owner && typeof record.text === "string" && record.text.length <= 40000 ? record.text : "";
  } catch { return ""; }
}
