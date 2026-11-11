import { adminFetch } from "@/lib/adminFetch";

/**
 * The engineering agent's owner actions as a browser posts them, shared by
 * Admin › Engineering › Decisions and the AMUX owner queue card. Each request
 * goes to the existing `/api/admin/engineering-agent/*` route, which checks
 * `engineering-agent:write`, a recent sign-in, the digest and base the person
 * saw, the lock and the audit again; nothing here decides.
 */

export type EngineeringAgentActionRequest = { url: string; body: Record<string, string> };

export type EngineeringAgentActionResult =
  | { kind: "ok" }
  /** A stale sign-in: the screen shows the way back to the step-up flow. */
  | { kind: "requiresReauthentication" }
  | { kind: "refused"; code: string }
  | { kind: "failed" };

type DraftItem = { id: string; patchDigest: string | null; baseSha: string | null };

/** Approve or reject a T2 draft, bound to the digest and base shown. Null without them. */
export const engineeringAgentDecisionRequest = (
  item: DraftItem,
  decision: "approved" | "rejected",
): EngineeringAgentActionRequest | null =>
  item.patchDigest && item.baseSha
    ? {
        url: "/api/admin/engineering-agent/decisions",
        body: { workItemId: item.id, decision, patchDigest: item.patchDigest, baseSha: item.baseSha },
      }
    : null;

/** Send a v22 draft back to the next tier round, bound to the digest and base shown. */
export const engineeringAgentRejudgeRequest = (item: DraftItem): EngineeringAgentActionRequest | null =>
  item.patchDigest && item.baseSha
    ? {
        url: "/api/admin/engineering-agent/rejudge",
        body: { workItemId: item.id, patchDigest: item.patchDigest, baseSha: item.baseSha },
      }
    : null;

/** One of a state mismatch's actions (lib/engineeringAgentStateMismatch.ts). */
export const engineeringAgentMismatchRequest = (workItemId: string, action: string): EngineeringAgentActionRequest => ({
  url: "/api/admin/engineering-agent/mismatches",
  body: { workItemId, action },
});

export async function postEngineeringAgentAction(
  request: EngineeringAgentActionRequest,
): Promise<EngineeringAgentActionResult> {
  try {
    const response = await adminFetch(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.body),
    });
    const payload = (await response.json().catch(() => ({}))) as { code?: unknown };
    if (response.status === 428 || payload.code === "ADMIN_REAUTHENTICATION_REQUIRED") return { kind: "requiresReauthentication" };
    if (response.status === 409 && typeof payload.code === "string") return { kind: "refused", code: payload.code };
    return response.ok ? { kind: "ok" } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}
