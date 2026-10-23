export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminAgentDigestsPanel } from "@/components/admin/AdminAgentDigestsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { CiAdmissionSection } from "@/components/admin/CiAdmissionSection";
import { readAgentDigestConsole } from "@/lib/agentDigestConsoleRead";
import { readCiAdmissionAdminView } from "@/lib/ciAdmissionService";
import { readQaReleaseMainCandidates } from "@/lib/qaReleaseMainCandidatesRead";
import { readQaReleaseTrainReports } from "@/lib/qaReleaseTrainStore";
import { hasAdminPermission } from "@/lib/adminAuth";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("qa-release");

/**
 * QA and release (docs/policy/qa-release-agent.md section 4): from a develop
 * merge to production -- the merge lane, CI admission and the release train.
 * Only the open tab's data is loaded. Reading takes ordinary admin
 * authentication, which the console layout has established; every write takes
 * owner or ops and a recent sign-in, checked by its route.
 */
export default async function AdminQaReleasePage({ searchParams }: PageProps<"/admin/qa-release">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const session = await getServerSession(authOptions);
  // Whether this viewer may write travels with the payload, so a reader is not
  // offered a form that can only refuse; the routes check again.
  const canWrite = hasAdminPermission(session, "ops:write");
  // The waiting line is one stored row; its length is the CI admission tab's
  // chip on every tab.
  const now = new Date();
  const admission = await readCiAdmissionAdminView();
  const waiting = admission.state.queue.length;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/qa-release"
        tabs={TABS}
        activeTabId={tab.id}
        label="QA and release sections"
        query={query}
        chips={{ "ci-admission": waiting > 0 ? { label: String(waiting), attention: true } : undefined }}
      />
      {tab.id === "ci-admission" ? (
        <CiAdmissionSection key={tab.id} initial={admission} canWrite={canWrite} />
      ) : (
        <AdminAgentDigestsPanel
          key={tab.id}
          initial={await readAgentDigestConsole(canWrite)}
          main={await readQaReleaseMainCandidates()}
          trains={(await readQaReleaseTrainReports()).map(({ slot, at, report }) => ({
            slot,
            at: at.toISOString(),
            outcome: report.outcome,
            pullRequestNumber: report.pullRequestNumber,
            failure: report.failure,
            picks: report.picks,
          }))}
          nowMs={now.getTime()}
        />
      )}
    </div>
  );
}
