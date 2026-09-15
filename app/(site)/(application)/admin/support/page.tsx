export const dynamic = "force-dynamic";

import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminPrivacyRequestsPanel } from "@/components/admin/AdminPrivacyRequestsPanel";
import { AutoFixReviewPanel } from "@/components/admin/AutoFixReviewPanel";
import { FeedbackInboxPanel } from "@/components/admin/FeedbackInboxPanel";
import {
  ADMIN_READ_LIMITS,
  loadAutoFixReviewRows,
  loadFeedbackRows,
} from "@/lib/adminConsoleData";
import { promotionConfigurationProblems } from "@/lib/feedbackAutoFixPromotion";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";

const TABS = adminNavItemTabs("support");

/**
 * Support absorbs the former standalone Feedback workspace.
 *
 * The two rendered the same `FeedbackInboxPanel` from the same rows; the only
 * difference was that Support also showed privacy requests. `/admin/feedback`
 * now redirects here with `?tab=feedback`, so every existing link still lands on
 * the inbox.
 */
export default async function AdminSupportPage({
  searchParams,
}: PageProps<"/admin/support">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);

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
        <AdminPrivacyRequestsPanel />
      ) : tab.id === "fixes" ? (
        <AutoFixReviewPanel
          rows={await loadAutoFixReviewRows()}
          rowLimit={ADMIN_READ_LIMITS.autoFixCases}
          configurationProblems={promotionConfigurationProblems()}
        />
      ) : (
        <FeedbackInboxPanel
          rows={await loadFeedbackRows({
            includeId: typeof query.q === "string" ? query.q.trim() || undefined : undefined,
          })}
          rowLimit={ADMIN_READ_LIMITS.feedback}
        />
      )}
    </div>
  );
}
