export const dynamic = "force-dynamic";

import { OperatorPlaybooksPanel, SupportAgePanel } from "@/components/admin/AdminRiskPanels";
import { AdminWorkQueuePanel } from "@/components/admin/AdminWorkQueuePanel";
import { feedbackSlaRows, loadFeedbackRows } from "@/lib/adminConsoleData";
import { loadAdminWorkQueue } from "@/lib/adminWorkQueue";

/**
 * One list of work that is actually waiting.
 *
 * Two-person approval used to be a second tab. It is not a queue anymore:
 * an eligible administrator executes the action, and the audit log is the
 * record. `/admin/approvals` redirects here.
 */
export default async function AdminWorkQueuePage() {
  const now = new Date();

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminWorkQueuePanel queue={await loadAdminWorkQueue(now)} now={now} />
      <SupportAgePanel slaRows={feedbackSlaRows(await loadFeedbackRows(), now)} />
      <OperatorPlaybooksPanel />
    </div>
  );
}
