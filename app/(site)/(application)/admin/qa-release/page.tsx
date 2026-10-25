export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminAgentDigestsPanel } from "@/components/admin/AdminAgentDigestsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { CiAdmissionSection } from "@/components/admin/CiAdmissionSection";
import { QaReleaseLaneVerdictsSection } from "@/components/admin/QaReleaseLaneVerdictsSection";
import { QaReleaseMergeLaneSection } from "@/components/admin/QaReleaseMergeLaneSection";
import { QaReleaseTrainBoard } from "@/components/admin/QaReleaseTrainBoard";
import { QaReleaseTrainCargoSection } from "@/components/admin/QaReleaseTrainCargoSection";
import { QaReleaseTrainEmergencySection } from "@/components/admin/QaReleaseTrainEmergencySection";
import { QaReleaseTrainRefresher } from "@/components/admin/QaReleaseTrainRefresher";
import { QaReleaseTrainSummary } from "@/components/admin/QaReleaseTrainSummary";
import { QA_RELEASE_SECTION_IDS } from "@/components/admin/qaReleaseTabParts";
import { readAgentDigestConsole } from "@/lib/agentDigestConsoleRead";
import { readCiAdmissionAdminView } from "@/lib/ciAdmissionService";
import { readQaReleaseMainCandidates } from "@/lib/qaReleaseMainCandidatesRead";
import { type QaReleaseLaneRounds, readQaReleaseLaneRounds } from "@/lib/qaReleaseMergeLaneRoundStore";
import { readQaReleaseTrainBoard } from "@/lib/qaReleaseTrainBoardRead";
import { qaReleaseTrainNextDepartureMs } from "@/lib/qaReleaseTrainCore";
import { readQaReleaseTrainReports, readQaReleaseTrainSchedule, readQaReleaseTrainSelection } from "@/lib/qaReleaseTrainStore";
import { hasAdminPermission } from "@/lib/adminAuth";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("qa-release");

/**
 * QA and release (docs/policy/qa-release-agent.md section 4): from a develop
 * merge to production -- the merge lane, CI admission and the release train,
 * each on its own tab.
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
  // The merge lane's own record is one stored row too; the pull requests that
  // are the operator's are the lane tab's chip on every tab.
  const laneRounds = await readQaReleaseLaneRounds();
  const yours = (laneRounds.verdicts?.list ?? []).filter((verdict) => verdict.status === "human").length;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/qa-release"
        tabs={TABS}
        activeTabId={tab.id}
        label="QA and release sections"
        query={query}
        chips={{
          lane: yours > 0 ? { label: String(yours), attention: true } : undefined,
          "ci-admission": waiting > 0 ? { label: String(waiting), attention: true } : undefined,
        }}
      />
      {tab.id === "ci-admission" ? (
        <CiAdmissionSection key={tab.id} initial={admission} canWrite={canWrite} />
      ) : tab.id === "train" ? (
        <TrainTab canWrite={canWrite} nowMs={now.getTime()} />
      ) : tab.id === "lane" ? (
        <LaneTab rounds={laneRounds} canWrite={canWrite} />
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

/**
 * The release train (owner, 2026-10-25): where the next train stands, an
 * emergency departure, the next train's cargo and the departure board.
 */
async function TrainTab({ canWrite, nowMs }: { canWrite: boolean; nowMs: number }) {
  const [board, next, schedule] = await Promise.all([readQaReleaseTrainBoard(nowMs), readQaReleaseTrainSelection(), readQaReleaseTrainSchedule()]);
  const nextMs = schedule ? qaReleaseTrainNextDepartureMs(nowMs, schedule.hours) : null;
  const carried = next.departedWith && next.lastTrain?.slot === next.departedWith ? next.numbers.length : 0;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <QaReleaseTrainRefresher />
      <QaReleaseTrainSummary
        nextDepartureAt={nextMs === null ? null : new Date(nextMs).toISOString()}
        riding={next.numbers.length}
        carried={carried}
        openTrain={board.rows.find((row) => row.status === "boarding")?.pullRequestNumber ?? null}
        openUnknown={!board.openRead}
        emergencyPulls={next.emergency.pending?.numbers.length ?? null}
      />
      <QaReleaseTrainEmergencySection canWrite={canWrite} openUnknown={!board.openRead} />
      <QaReleaseTrainCargoSection canWrite={canWrite} id={QA_RELEASE_SECTION_IDS.cargo} />
      <QaReleaseTrainBoard rows={board.rows} pullsRead={board.pullsRead} nowMs={nowMs} />
    </div>
  );
}

/** The merge lane: what it will merge and what is the operator's, then its latch and attempt. */
async function LaneTab({ rounds, canWrite }: { rounds: QaReleaseLaneRounds; canWrite: boolean }) {
  const digest = await readAgentDigestConsole(canWrite);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <QaReleaseLaneVerdictsSection rounds={rounds} latched={digest.mergeLane.latched} />
      <QaReleaseMergeLaneSection lane={digest.mergeLane} canWrite={canWrite} />
    </div>
  );
}
