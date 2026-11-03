import { adminFetch } from "@/lib/adminFetch";

/** Owner action: archive every active card. Kept apart from the read-only board. */
export async function requestArchiveAllActiveCards(): Promise<void> {
  const response = await adminFetch("/api/admin/amux/execution-archive", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "archive_all_active_cards" }) });
  if (response.status === 428) throw new Error("reauth");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
