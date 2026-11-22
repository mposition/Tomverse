import { adminFetch } from "@/lib/adminFetch";

export type AmuxHierarchyArchiveOutcome =
  | { state: "archived"; count: number }
  | { state: "refused"; code: string }
  | { state: "reauth" }
  | { state: "failed" };

/** Owner action: archive hierarchies with no work left. Kept apart from the
 * read-only board. Sent once; a failure is never retried from here. */
export async function requestAmuxHierarchyArchive(nodeIds: string[]):
  Promise<AmuxHierarchyArchiveOutcome> {
  let response: Response;
  try {
    response = await adminFetch("/api/admin/amux/hierarchy-archive", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "archive_hierarchy_nodes", nodeIds }) });
  } catch { return { state: "failed" }; }
  if (response.status === 428) return { state: "reauth" };
  const body = await response.json().catch(() => null) as
    { archived?: unknown[]; code?: unknown } | null;
  if (response.ok && Array.isArray(body?.archived))
    return { state: "archived", count: body.archived.length };
  if ((response.status === 409 || response.status === 403) && typeof body?.code === "string")
    return { state: "refused", code: body.code };
  return { state: "failed" };
}
