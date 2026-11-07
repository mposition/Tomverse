export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminPrivacyRequestsPanel } from "@/components/admin/AdminPrivacyRequestsPanel";
import { AutoFixReviewPanel } from "@/components/admin/AutoFixReviewPanel";
import { FeedbackInboxPanel, type FeedbackRow } from "@/components/admin/FeedbackInboxPanel";
import { SupportReadFailedBlock } from "@/components/admin/SupportReadFailedBlock";
import { SupportTriageModelPanel } from "@/components/admin/SupportTriageModelPanel";
import { hasAdminPermission } from "@/lib/adminAuth";
import { ADMIN_READ_LIMITS, loadFeedbackRows } from "@/lib/adminConsoleData";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("support");

/**
 * Support absorbs the former standalone Feedback workspace.
 *
 * The inquiries tab and the Auto-fix review tab read the same newest reports
 * (`loadFeedbackRows`): the second is those reports seen by the automation's
 * case, so it adds no read and no store of its own. `/admin/feedback` redirects
 * here with `?tab=feedback`, so every existing link still lands on the inbox.
 * The retired `?tab=fixes` falls to the first tab, the same inbox.
 *
 * A failed read is drawn as an error with a retry, never as an empty list. The
 * privacy tab reads its own queue in the browser and holds its own failure.
 * `canWrite` only draws the write controls locked for a role that cannot use
 * them; every route still refuses on its own.
 */
export default async function AdminSupportPage({
  searchParams,
}: PageProps<"/admin/support">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const session = await getServerSession(authOptions);
  const canWrite = hasAdminPermission(session, "support:write");

  // The two report-backed tabs share one read; the privacy tab reads in the browser.
  let feedbackRows: FeedbackRow[] | null = null;
  if (tab.id !== "privacy") {
    const [read] = await Promise.allSettled([
      loadFeedbackRows({
        includeId:
          tab.id === "feedback" && typeof query.q === "string"
            ? query.q.trim() || undefined
            : undefined,
      }),
    ]);
    if (read.status === "fulfilled") {
      feedbackRows = read.value;
    } else {
      console.warn({ event: "admin_support_read_failed", read: "feedback" });
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/support"
        tabs={TABS}
        activeTabId={tab.id}
        label="Support sections"
        query={query}
      />
      {tab.id === "privacy" ? (
        <AdminPrivacyRequestsPanel canWrite={canWrite} />
      ) : feedbackRows === null ? (
        <SupportReadFailedBlock read={tab.id === "autofix" ? "autofix" : "inquiries"} />
      ) : tab.id === "autofix" ? (
        <AutoFixReviewPanel rows={feedbackRows} rowLimit={ADMIN_READ_LIMITS.feedback} />
      ) : (
        <>
          <FeedbackInboxPanel
            rows={feedbackRows}
            rowLimit={ADMIN_READ_LIMITS.feedback}
            canWrite={canWrite}
          />
          <SupportTriageModelPanel />
        </>
      )}
    </div>
  );
}
