import type { AdminRole } from "@/lib/adminAuthCore";
import { buildDecisionInbox, type DecisionInbox } from "@/lib/adminDecisionInbox";
import { getAdminNavigationCounts } from "@/lib/adminNavigationCounts";
import { loadAdminWorkQueue } from "@/lib/adminWorkQueue";

/**
 * Reads the two sources the inbox is built from, each on its own. Either one
 * rejecting leaves the other usable, and the inbox says which part is missing.
 */
export async function loadAdminDecisionInbox(
  role: AdminRole | null | undefined,
  now = new Date()
): Promise<DecisionInbox> {
  const [queue, navigation] = await Promise.allSettled([
    loadAdminWorkQueue(now),
    getAdminNavigationCounts(),
  ]);
  if (queue.status === "rejected") {
    console.warn(JSON.stringify({ event: "admin_decision_inbox_read_failed", read: "work_queue", at: now.toISOString() }));
  }
  if (navigation.status === "rejected") {
    console.warn(JSON.stringify({ event: "admin_decision_inbox_read_failed", read: "counts", at: now.toISOString() }));
  }
  return buildDecisionInbox({
    queue: queue.status === "fulfilled" ? queue.value : null,
    counts: navigation.status === "fulfilled" ? navigation.value.counts : null,
    role,
    now,
  });
}
