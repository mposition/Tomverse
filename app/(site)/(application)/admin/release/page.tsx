export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { getServerSession } from "next-auth/next";
import { AdminAgentDigestsPanel } from "@/components/admin/AdminAgentDigestsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminViewSwitch } from "@/components/admin/AdminViewSwitch";
import { AmuxIdeaLaneDailyLoading, AmuxIdeaLaneDailySection } from "@/components/admin/AmuxIdeaLaneDailySection";
import { CiAdmissionSection } from "@/components/admin/CiAdmissionSection";
import { QaReleaseLaneVerdictsSection } from "@/components/admin/QaReleaseLaneVerdictsSection";
import { QaReleaseMergeLaneSection } from "@/components/admin/QaReleaseMergeLaneSection";
import { QaReleaseTrainBoard } from "@/components/admin/QaReleaseTrainBoard";
import { ReleaseTrainOverview, ReleaseTrainOverviewLoading } from "@/components/admin/ReleaseTrainOverview";
import { QaReleaseTrainCargoSection } from "@/components/admin/QaReleaseTrainCargoSection";
import { QaReleaseTrainEmergencySection } from "@/components/admin/QaReleaseTrainEmergencySection";
import { QaReleaseTrainRefresher } from "@/components/admin/QaReleaseTrainRefresher";
import { QaReleaseTrainLoading, QaReleaseTrainSummary } from "@/components/admin/QaReleaseTrainSummary";
import { QA_RELEASE_SECTION_IDS } from "@/components/admin/qaReleaseTabParts";
import { readAgentDigestConsole } from "@/lib/agentDigestConsoleRead";
import { readAmuxIdeaLaneDailyReport } from "@/lib/amux/ideaLaneDailyReportRead";
import { readCiAdmissionAdminView } from "@/lib/ciAdmissionService";
import { readQaReleaseCiAdvice } from "@/lib/qaReleaseCiAdviceStore";
import { readQaReleaseMainCandidates } from "@/lib/qaReleaseMainCandidatesRead";
import { type QaReleaseLaneRounds, readQaReleaseLaneRounds } from "@/lib/qaReleaseMergeLaneRoundStore";
import { readQaReleaseTrainBoard } from "@/lib/qaReleaseTrainBoardRead";
import { qaReleaseTrainNextDepartureMs } from "@/lib/qaReleaseTrainCore";
import { readQaReleaseTrainReports, readQaReleaseTrainSchedule, readQaReleaseTrainSelection } from "@/lib/qaReleaseTrainStore";
import { hasAdminPermission } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminNavItemTabs, resolveAdminTab, resolveAdminView } from "@/lib/adminNavigation";
import { adminUiMessages } from "@/lib/adminMessages/ui";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("release");

/** The three screens the QA tab still holds, until its own is built. */
const QA_VIEWS = ["overview", "train", "lane"] as const;

/**
 * Release (docs/policy/qa-release-agent.md section 4): from a develop merge to
 * production -- the merge lane, the release train and CI admission. It was
 * `/admin/qa-release`, and before that a tab of Agent digests; both addresses
 * redirect here.
 *
 * The QA tab holds what the old page's overview, train and lane tabs held, as
 * views of it (`?view=`), moved as they were. Only the open view's data is
 * loaded. Reading takes ordinary admin authentication, which the console
 * layout has established; every write takes owner or ops and a recent sign-in,
 * checked by its route.
 */
export default async function AdminReleasePage({ searchParams }: PageProps<"/admin/release">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const view = resolveAdminView(QA_VIEWS, query.view);
  const [session, ui] = await Promise.all([getServerSession(authOptions), getAdminMessages(adminUiMessages)]);
  // Whether this viewer may write travels with the payload, so a reader is not
  // offered a form that can only refuse; the routes check again.
  const canWrite = hasAdminPermission(session, "ops:write");
  // The waiting line is one stored row; its length is the CI queue tab's chip
  // on every tab.
  const now = new Date();
  const admission = await readCiAdmissionAdminView();
  const waiting = admission.state.queue.length;
  // The merge lane's own record is one stored row too; the pull requests that
  // are the operator's are the merge lane view's chip on every tab.
  const laneRounds = await readQaReleaseLaneRounds();
  const yours = (laneRounds.verdicts?.list ?? []).filter((verdict) => verdict.status === "human").length;
  // The strip carries no `view`: switching tab starts that tab on its first view.
  const tabQuery = { ...query, view: undefined };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/release"
        tabs={TABS}
        activeTabId={tab.id}
        label="Release sections"
        query={tabQuery}
        chips={{
          ci: waiting > 0 ? { label: String(waiting), attention: true } : undefined,
        }}
      />
      {tab.id === "ci" ? (
        <CiAdmissionSection key={tab.id} initial={admission} canWrite={canWrite} />
      ) : (
        <>
          {/* The next train, today's route and what rides it; the views below hold the detail. */}
          <Suspense fallback={<ReleaseTrainOverviewLoading />}>
            <ReleaseTrainOverview nowMs={now.getTime()} />
          </Suspense>
          <AdminViewSwitch
            basePath="/admin/release"
            tabId="qa"
            query={tabQuery}
            activeId={view}
            views={[
              { id: "overview", label: ui.view.overview },
              { id: "train", label: ui.view.train },
              { id: "lane", label: ui.view.lane, chip: yours > 0 ? String(yours) : undefined },
            ]}
          />
          {view === "train" ? (
            // The view changes at once and says it is reading; what reads GitHub
            // streams in after (on 2026-10-25 a cold read held the click 20-28 s).
            <Suspense key={view} fallback={<QaReleaseTrainLoading />}>
              <TrainView canWrite={canWrite} nowMs={now.getTime()} />
            </Suspense>
          ) : view === "lane" ? (
            <LaneView rounds={laneRounds} canWrite={canWrite} />
          ) : (
            <AdminAgentDigestsPanel
              key={view}
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
              ciAdvice={await readQaReleaseCiAdvice()}
              laneRounds={laneRounds}
              nowMs={now.getTime()}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The release train (owner, 2026-10-25): where the next train stands, an
 * emergency departure, the next train's cargo and the departure board.
 */
async function TrainView({ canWrite, nowMs }: { canWrite: boolean; nowMs: number }) {
  const [board, next, schedule] = await Promise.all([
    readQaReleaseTrainBoard(nowMs),
    readQaReleaseTrainSelection(),
    readQaReleaseTrainSchedule(),
  ]);
  const nextMs = schedule ? qaReleaseTrainNextDepartureMs(nowMs, schedule.hours) : null;
  const carried = next.departedWith && next.lastTrain?.slot === next.departedWith ? next.numbers.length : 0;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <QaReleaseTrainRefresher />
      <QaReleaseTrainSummary
        nextDepartureAt={nextMs === null ? null : new Date(nextMs).toISOString()}
        riding={next.numbers.length}
        carried={carried}
        openTrain={board.openTrains[0] ?? null}
        openUnknown={!board.openRead}
        emergencyPulls={next.emergency.pending?.numbers.length ?? null}
      />
      <QaReleaseTrainEmergencySection canWrite={canWrite} openUnknown={!board.openRead} />
      {/* What the idea lane merged into develop over the last day (owner, 2026-11-04): tested on develop, then picked below. */}
      <Suspense fallback={<AmuxIdeaLaneDailyLoading />}>
        <IdeaLaneDaily nowMs={nowMs} />
      </Suspense>
      <QaReleaseTrainCargoSection canWrite={canWrite} id={QA_RELEASE_SECTION_IDS.cargo} />
      <QaReleaseTrainBoard rows={board.rows} pullsRead={board.pullsRead} nowMs={nowMs} />
    </div>
  );
}

/** The idea lane's daily report, streamed on its own: the cargo's GitHub read can take a while cold. */
async function IdeaLaneDaily({ nowMs }: { nowMs: number }) {
  // A failed read is "unread" on this section alone; the rest of the view still shows.
  const report = await readAmuxIdeaLaneDailyReport(nowMs).catch(() => {
    console.warn(JSON.stringify({ event: "amux_idea_lane_daily_read_failed" }));
    return { status: "unread", failure: "read_failed" } as const;
  });
  return <AmuxIdeaLaneDailySection report={report} />;
}

/** The merge lane: what it will merge and what is the operator's, then its latch and attempt. */
async function LaneView({ rounds, canWrite }: { rounds: QaReleaseLaneRounds; canWrite: boolean }) {
  const digest = await readAgentDigestConsole(canWrite);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <QaReleaseLaneVerdictsSection rounds={rounds} latched={digest.mergeLane.latched} />
      <QaReleaseMergeLaneSection lane={digest.mergeLane} canWrite={canWrite} />
    </div>
  );
}
