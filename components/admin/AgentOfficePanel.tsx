"use client";

import type { CSSProperties, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import AgentOfficeLive from "@/components/admin/AgentOfficeLive";
import { cx } from "@/components/admin/agentOfficeStyles";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { useModalDialog } from "@/components/useModalDialog";
import { adminAgentOfficeMessages } from "@/lib/adminMessages/agentOffice";
import {
  amuxRoomView,
  engineeringLiveDept,
  OPERATOR_QUEUE_HREFS,
  OPERATOR_QUEUE_KEYS,
  agentOfficeBrief,
  agentOfficeReport,
  operatorQueueTotal,
  agentOfficeStaffCount,
  decisionRoomView,
  digestLiveDept,
  reviewQuotaView,
  reviewRoomView,
  financeLiveDept,
  marketingLiveDept,
  qaLiveDept,
  researchLiveDept,
  routingLiveDept,
  sreLiveDept,
  supportLiveDept,
  trustLiveDept,
  type AgentOfficeAmuxView,
  type AgentOfficeReviewView,
  type AgentOfficeDecisionView,
  type AgentOfficeStaffCount,
  type AgentOfficeSeatedView,
  type AgentOfficeQuotaView,
  type AgentOfficeOperatorQueue,
  type AgentOfficeLiveRow,
  type AgentOfficeLiveDept,
  type AgentOfficeLiveRooms,
} from "@/lib/agentOffice/live";
import {
  AGENT_OFFICE_AMUX_RECORD_HREF,
  AGENT_OFFICE_DECISION_RECORD_HREF,
  AGENT_OFFICE_DEPTS,
  AGENT_OFFICE_DIGEST_SENDERS,
  AGENT_OFFICE_TEAM_IDS,
  agentOfficeDept,
  AGENT_OFFICE_ROOM_POLICIES,
  agentOfficeSeatedClothes,
  type AgentOfficeSeatedRoom,
  type AgentOfficeTeamId,
} from "@/lib/agentOffice/roster";
import { AgentOffice, type DeptStatus, type OfficeCopy, type Snapshot, type StaffSeed } from "@/lib/agentOffice/sim";
import { aestStamp, brisbaneIso } from "@/lib/agentOffice/time";
import { REVIEW_DESKS } from "@/lib/agentOffice/floor";
import { agentOfficeInbox, inboxTotal } from "@/lib/agentOffice/inbox";

/** The record rooms' icons, beside the teams' own (lib/agentOffice/roster.ts). */
const ROOM_ICON = { amux: "🧩", review: "🔎", decision: "⚖️" } as const;

type View = "live" | "dashboard";
type Filter = "all" | DeptStatus;

const OFFICE_PATH = "/admin/office";
/** A section is an address (docs/ui-contracts/admin-console-ia.md, rule 2). */
const viewHref = (view: View) => `${OFFICE_PATH}?tab=${view}`;

const FILTERS: readonly Filter[] = ["all", "working", "done", "attention", "blocked"];

function PixelEmployee({ hair, shirt, accent }: { hair: string; shirt: string; accent: string }) {
  const style = {
    "--pixel-hair": hair,
    "--pixel-shirt": shirt,
    "--pixel-accent": accent,
  } as CSSProperties;
  return (
    <span className={cx("pixel-employee")} style={style} aria-hidden="true">
      <i className={cx("pixel-shadow")} />
      <i className={cx("pixel-legs")} />
      <i className={cx("pixel-body")} />
      <i className={cx("pixel-arm left")} />
      <i className={cx("pixel-arm right")} />
      <i className={cx("pixel-face")}>
        <b className={cx("pixel-eyes")} />
      </i>
      <i className={cx("pixel-hair")} />
      <i className={cx("pixel-headset")} />
    </span>
  );
}

/**
 * The Agent office: a pixel office for the nine agent teams, after the
 * original AI OFFICE UI by godseng.mom.
 *
 * It shows records and decides nothing. A room marked LIVE is what the
 * server read for it; any other room says whether the console has a record
 * screen for it, and links it when it does. Nothing here plays a scenario,
 * approves or sends anything.
 */
export function AgentOfficePanel({ view, live, cliMonitorEnabled = false }: {
  view: View; live: AgentOfficeLiveRooms; cliMonitorEnabled?: boolean;
}) {
  const m = useAdminMessages(adminAgentOfficeMessages);
  const router = useRouter();
  // The rooms that read a real record, in the console's language. Each
  // navigation brings a fresh server reading, and the engine takes it.
  const liveDepts = useMemo<Record<string, AgentOfficeLiveDept>>(
    () => ({
      research: researchLiveDept(live.research, m.real.research),
      qa: qaLiveDept(live.qa, m.real.qa),
      finance: financeLiveDept(live.finance, m.real.finance),
      routing: routingLiveDept(live.routing, m.real.routing),
      sre: sreLiveDept(live.sre, m.real.sre),
      support: supportLiveDept(live.support, m.real.support),
      marketing: marketingLiveDept(live.marketing, m.real.marketing),
      trust: trustLiveDept(live.trust, m.real.trust),
      engineering: engineeringLiveDept(live.engineering, m.real.engineering),
      digest: digestLiveDept(
        live.digest,
        m.real.digest,
        Object.fromEntries(
          Object.entries(AGENT_OFFICE_DIGEST_SENDERS).map(([agentKey, deptId]) => [agentKey, m.depts[deptId].name])
        )
      ),
    }),
    [live, m]
  );
  // The AMUX room is not a team: its workers are drawn from the record, one per desk.
  const amuxView = useMemo(
    // Every worker is on the floor or in the roster: no desk limit here (lib/agentOffice/floor.ts).
    () => amuxRoomView(live.amux, Number.MAX_SAFE_INTEGER, m.real.amux),
    [live, m]
  );
  const reviewView = useMemo(
    () => reviewRoomView(live.review, REVIEW_DESKS, m.real.review),
    [live, m]
  );
  const decisionView = useMemo(() => decisionRoomView(live.decision, m.real.decision), [live, m]);
  const [engine] = useState(() => new AgentOffice(m, liveDepts));
  // Everyone drawn: the teams' staff and every AMUX worker, reviewer and
  // Decision Maker instance on record. An unread room makes the total a floor.
  const staff = useMemo(() => agentOfficeStaffCount(engine.staff.length, live), [engine, live]);
  const staffText = staff.unknown ? `${staff.total}+` : String(staff.total);
  const [filter, setFilter] = useState<Filter>("all");
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | undefined>(undefined);
  // A fresh reading moves the rooms' colours; nothing else in the engine changes.
  const snap = useMemo<Snapshot>(() => {
    engine.setLive(liveDepts);
    return engine.snapshot();
  }, [engine, liveDepts]);
  const stale = useStaleReading(live.readAt);

  // A fresh reading of the live rooms every minute while the tab is visible,
  // and at once when it comes back into view: the page's server component
  // reads again and a room whose record changed says so (engine.setLive).
  // Reading only -- nothing on the page writes.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, LIVE_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2400);
  }, []);

  // A seated figure is not an engine agent: it is named by its room and the
  // name its record gives it, and its profile is re-read from that record.
  const [seated, setSeated] = useState<{ room: AgentOfficeSeatedRoom; name: string } | null>(null);
  const onSelectSeated = useCallback((room: AgentOfficeSeatedRoom, name: string) => setSeated({ room, name }), []);
  // A room's name opens what its team does, written from its code and policy.
  const [teamInfo, setTeamInfo] = useState<AgentOfficeTeamId | null>(null);
  const onSelectTeam = useCallback((team: string) => setTeamInfo(team as AgentOfficeTeamId), []);

  /** To the live office, by address; the panel stays mounted and the day goes on. */
  const goLive = useCallback(() => {
    if (view !== "live") router.push(viewHref("live"), { scroll: false });
  }, [router, view]);

  // A card in the live office to bring into view once that section is on
  // screen. From the dashboard the section arrives after a navigation, so the
  // scroll waits for it rather than for a fixed delay.
  const pendingReveal = useRef<string | null>(null);
  const reveal = useCallback(
    (id: string) => {
      pendingReveal.current = id;
      if (view === "live") {
        window.setTimeout(() => {
          document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
          pendingReveal.current = null;
        }, 60);
      } else {
        goLive();
      }
    },
    [goLive, view]
  );
  useEffect(() => {
    const id = pendingReveal.current;
    if (view !== "live" || !id) return;
    const timer = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
      pendingReveal.current = null;
    }, 60);
    return () => window.clearTimeout(timer);
  }, [view]);

  const teams = useMemo(
    () =>
      AGENT_OFFICE_DEPTS.map((dept) => ({
        id: dept.id,
        icon: dept.icon,
        name: engine.roomName(dept.id),
        lead: engine.deptLead[dept.id],
        status: snap.deptStatus[dept.id] ?? "waiting",
        task: engine.deptCopy(dept.id).task,
        live: liveDepts[dept.id] ?? null,
      })),
    [engine, snap.deptStatus, liveDepts]
  );

  const filteredTeams = filter === "all" ? teams : teams.filter((team) => team.status === filter);

  // The status report: what this screen shows, as Markdown, built when asked
  // for. It goes to the clipboard or a download and nowhere else.
  const reportText = () =>
    agentOfficeReport(
      {
        readAt: live.readAt,
        rows: liveRowsFor(teams, amuxView, reviewView, decisionView, m),
        notConnected: teams.filter((team) => !team.live).map((team) => `${team.icon} ${team.name}`),
        queue: OPERATOR_QUEUE_KEYS.map((key) => ({ label: m.queue.labels[key], count: live.queue[key] })),
        quota: reviewQuotaView(live.review, m.real.quota),
        unknownCount: m.queue.unknown,
      },
      m.report
    );
  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(reportText());
      showToast(m.live.reportCopied);
    } catch {
      showToast(m.live.reportCopyFailed);
    }
  };
  const downloadReport = () => {
    const url = URL.createObjectURL(new Blob([reportText()], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    const stamp = (brisbaneIso(live.readAt) ?? live.readAt).slice(0, 16).replace(/[:T]/g, "-");
    link.download = `tomverse-agent-office-${stamp}-aest.md`;
    // In the document while it is clicked, and the URL kept a moment after:
    // some browsers abort a download whose object URL is revoked at once.
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  // The tab counts what "waiting on you" lists in the live office: the same queues and the AMUX workers.
  const waiting = inboxTotal(
    agentOfficeInbox({ queue: live.queue, inbox: live.inbox, amux: live.amux, amuxDetail: live.amuxDetail, now: Date.parse(live.readAt) })
  );

  return (
    <div className={cx("office")} data-testid="agent-office">
      <div className={cx("page-shell")}>
        <div className={cx("wrap")}>
          <nav className={cx("app-nav")} aria-label={m.nav.ariaLabel}>
            <div className={cx("brand-chip")}>
              <span aria-hidden="true">{m.nav.brandLetter}</span>
              <b>{m.nav.brandName}</b>
            </div>
            <div className={cx("nav-tabs")}>
              <Link
                href={viewHref("live")}
                scroll={false}
                className={cx(view === "live" && "active")}
                aria-current={view === "live" ? "page" : undefined}
              >
                {m.nav.live}
              </Link>
              <Link
                href={viewHref("dashboard")}
                scroll={false}
                className={cx(view === "dashboard" && "active")}
                aria-current={view === "dashboard" ? "page" : undefined}
              >
                {m.nav.dashboard}
              </Link>
              <button
                type="button"
                className={cx("todo-tab", waiting.total > 0 && "urgent")}
                onClick={() => reveal("agent-office-rail")}
                title={waiting.unknown ? m.queue.partial : undefined}
              >
                {m.nav.todo} <i>{waiting.unknown ? `${waiting.total}+?` : waiting.total}</i>
              </button>
            </div>
          </nav>

          {view === "live" ? (
            <AgentOfficeLive
              m={m}
              engine={engine}
              live={live}
              liveDepts={liveDepts}
              amuxView={amuxView}
              reviewView={reviewView}
              decisionView={decisionView}
              cliMonitorEnabled={cliMonitorEnabled}
              stale={stale}
              onSelectTeam={onSelectTeam}
              onSelectSeated={onSelectSeated}
              onCopyReport={copyReport}
              onDownloadReport={downloadReport}
            />
          ) : (
            <DashboardView
              m={m}
              engine={engine}
              teams={teams}
              filteredTeams={filteredTeams}
              filter={filter}
              setFilter={setFilter}
              snap={snap}
              readAt={live.readAt}
              staff={staff}
              staffText={staffText}
              queue={live.queue}
              amuxView={amuxView}
              reviewView={reviewView}
              decisionView={decisionView}
              onSelectTeam={onSelectTeam}
            />
          )}
        </div>
      </div>

      {seated ? (
        <SeatedProfileModal
          m={m}
          seated={seated}
          amuxView={amuxView}
          reviewView={reviewView}
          decisionView={decisionView}
          quotaView={reviewQuotaView(live.review, m.real.quota)}
          onClose={() => setSeated(null)}
        />
      ) : null}
      {teamInfo ? (
        <TeamInfoModal
          m={m}
          team={teamInfo}
          engine={engine}
          amuxView={amuxView}
          reviewView={reviewView}
          decisionView={decisionView}
          onClose={() => setTeamInfo(null)}
        />
      ) : null}
      <div className={cx("toast", toast && "show")} role="status">
        {toast}
      </div>
    </div>
  );
}

const ENGINEERING_RECORD_HREF = agentOfficeDept("engineering")?.recordHref ?? null;

/** How often the open office reads the live rooms again. */
const LIVE_REFRESH_MS = 60_000;
/** Past this, the screen says it has stopped refreshing: two missed re-reads. */
export const LIVE_STALE_MS = 2 * LIVE_REFRESH_MS;

/**
 * Whether the reading on screen is older than LIVE_STALE_MS. The clock starts
 * at the reading itself, so the server render and the first client render
 * agree; it then ticks every 15 seconds.
 */
function useStaleReading(readAt: string): boolean {
  const readMs = Date.parse(readAt);
  const [now, setNow] = useState(readMs);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, [readMs]);
  return Number.isFinite(readMs) && now - readMs > LIVE_STALE_MS;
}

/**
 * The approval card while the engineering room reads its real record: its
 * decisions are made on the engineering agent's own screen, never here.
 */
function LiveDecisionNote({ m }: { m: OfficeCopy }) {
  return (
    <>
      <div className={cx("approval-top")}>
        <span className={cx("approval-chips")}>
          <em className={cx("live-chip")}>{m.real.chip}</em>
        </span>
      </div>
      <h3>{m.approval.liveTitle}</h3>
      <p>{m.approval.liveBody}</p>
      {ENGINEERING_RECORD_HREF ? (
        <Link href={ENGINEERING_RECORD_HREF} className={cx("btn")} data-testid="agent-office-engineering-record">
          {m.approval.liveLink}
        </Link>
      ) : null}
    </>
  );
}

/**
 * The operator's to-do: each queue an agent waits on, its count and the screen
 * where it is acted on. The office decides nothing; an unread count says so
 * and is never drawn as zero.
 */
function OperatorQueueList({ m, queue }: { m: OfficeCopy; queue: AgentOfficeOperatorQueue }) {
  const { total, unknown } = operatorQueueTotal(queue);
  return (
    <div className={cx("queue")} data-testid="agent-office-operator-queue">
      <ul className={cx("queue-list")}>
        {OPERATOR_QUEUE_KEYS.map((key) => {
          const count = queue[key];
          return (
            <li key={key} className={cx(count !== null && count > 0 && "waiting")}>
              <span>{m.queue.labels[key]}</span>
              <b>{count === null ? m.queue.unknown : count}</b>
              <Link href={OPERATOR_QUEUE_HREFS[key]}>{m.queue.open}</Link>
            </li>
          );
        })}
      </ul>
      {total === 0 && !unknown ? <p className={cx("queue-note")}>{m.queue.empty}</p> : null}
      {unknown ? <p className={cx("queue-note")}>{m.queue.partial}</p> : null}
    </div>
  );
}

/**
 * The focus contract every aria-modal surface owes (components/useModalDialog.ts):
 * focus moves in, Tab cycles inside, Escape closes, the page behind does not
 * scroll, and focus returns to what opened it.
 */
function useOfficeDialog(onClose: () => void, initialFocusRef: RefObject<HTMLButtonElement | null>) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useModalDialog({ open: true, onClose, dialogRef, panelRef: dialogRef, initialFocusRef });
  return dialogRef;
}

/**
 * A seated figure's profile: an AMUX worker or a reviewer, read from its
 * room's record by name. It has no task, no word and no "ask" as an engine
 * agent does: it shows the record, and follows it when the room is re-read.
 */
function SeatedProfileModal({
  m,
  seated,
  amuxView,
  reviewView,
  decisionView,
  quotaView,
  onClose,
}: {
  m: OfficeCopy;
  seated: { room: AgentOfficeSeatedRoom; name: string };
  amuxView: AgentOfficeAmuxView;
  reviewView: AgentOfficeReviewView;
  decisionView: AgentOfficeDecisionView;
  quotaView: AgentOfficeQuotaView;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useOfficeDialog(onClose, closeRef);
  const people: AgentOfficeSeatedView[] =
    seated.room === "amux" ? amuxView.workers : seated.room === "review" ? reviewView.reviewers : decisionView.members;
  // Only the AMUX room and the Decision Maker have a record screen; a reviewer's lives on the review server.
  const recordHref =
    seated.room === "amux" ? AGENT_OFFICE_AMUX_RECORD_HREF : seated.room === "decision" ? AGENT_OFFICE_DECISION_RECORD_HREF : null;
  const roomName = { amux: m.rooms.amux, review: m.rooms.review, decision: m.rooms.decision }[seated.room];
  const desk = people.findIndex((person) => person.name === seated.name);
  const person = desk >= 0 ? people[desk] : null;
  // Someone who has left the record keeps the clothes they wore when opened.
  const [openedDesk] = useState(desk);
  const clothes = agentOfficeSeatedClothes(seated.room, desk >= 0 ? desk : Math.max(openedDesk, 0));
  const quota = seated.room === "review" ? quotaView.rows.find((row) => row.id === seated.name) : undefined;
  return (
    <div className={cx("modal-backdrop")} onClick={onClose}>
      <section
        ref={dialogRef}
        className={cx("win team-modal")}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={m.profile.dialogLabel(seated.name)}
        data-testid="agent-office-seated-profile"
        data-seated-room={seated.room}
      >
        <div className={cx("win-bar")}>
          <span>{m.profile.windowTitle}</span>
          <button ref={closeRef} type="button" className={cx("window-close")} onClick={onClose} aria-label={m.profile.closeIcon}>
            ✕
          </button>
        </div>
        <div className={cx("win-body employee-profile")}>
          <div className={cx("profile-top")}>
            <PixelEmployee hair={clothes.hair} shirt={clothes.shirt} accent={clothes.accent} />
            <div>
              {person ? <span className={cx("status-pill", person.status)}>{person.label}</span> : null}
              <h2>{seated.name}</h2>
              <p>{roomName}</p>
            </div>
          </div>
          <div className={cx("live-box")} data-testid="agent-office-seated-profile-facts">
            <span className={cx("tiny-label")}>
              <em className={cx("live-chip")}>{m.real.chip}</em> {m.real.boxLabel}
            </span>
            {person ? (
              <dl className={cx("profile-facts")}>
                {person.facts.map((fact) => (
                  <div key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
                {quota ? (
                  <div>
                    <dt>{m.profile.seatedQuota}</dt>
                    <dd>
                      {quota.label} · {quota.amount}
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <strong>{m.profile.seatedGone}</strong>
            )}
          </div>
          {recordHref ? (
            <div className={cx("profile-record")} data-testid="agent-office-seated-profile-record">
              <Link href={recordHref}>{m.profile.record}</Link>
            </div>
          ) : null}
          <div className={cx("profile-actions")}>
            <button type="button" className={cx("btn btn-primary")} onClick={onClose}>
              {m.profile.close}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Every automation the office reads for real: the live team rooms, then the
 * AMUX execution room and the review server. The dashboard lists them and the
 * status report is built from them.
 */
/**
 * What a team or record room does, written from its code and policy
 * (lib/adminMessages/agentOffice.ts, `teamInfo`), beside what the office
 * read for it now. Read only: it links the record and names the policy.
 */
function TeamInfoModal({
  m,
  team,
  engine,
  amuxView,
  reviewView,
  decisionView,
  onClose,
}: {
  m: OfficeCopy;
  team: AgentOfficeTeamId;
  engine: AgentOffice;
  amuxView: AgentOfficeAmuxView;
  reviewView: AgentOfficeReviewView;
  decisionView: AgentOfficeDecisionView;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useOfficeDialog(onClose, closeRef);
  const info = m.teamInfo.teams[team];
  const room = team === "amux" || team === "review" || team === "decision" ? team : null;
  const dept = room ? null : agentOfficeDept(team);
  const name = room ? m.rooms[room] : engine.roomName(team);
  const icon = room ? ROOM_ICON[room] : dept?.icon ?? "";
  const recordHref = room
    ? room === "amux"
      ? AGENT_OFFICE_AMUX_RECORD_HREF
      : room === "decision"
        ? AGENT_OFFICE_DECISION_RECORD_HREF
        : null
    : dept?.recordHref ?? null;
  const policy = room ? AGENT_OFFICE_ROOM_POLICIES[room] : dept?.policy ?? null;
  // Now: a record room's own reading, or a desk room's live line, or why it has none.
  const view = room ? { amux: amuxView, review: reviewView, decision: decisionView }[room] : null;
  const live = room ? null : engine.liveDept(team);
  const status: DeptStatus = view ? view.status : live ? live.status : (engine.deptStatus[team] ?? "waiting");
  const nowLine = view
    ? view.summary
    : live
      ? live.line
      : status === "blocked"
        ? engine.deptCopy(team).blockReason
        : m.teamInfo.notLive;
  const sections = [
    ["does", m.teamInfo.does, info.does],
    ["never", m.teamInfo.never, info.never],
    ["human", m.teamInfo.human, info.human],
  ] as const;
  return (
    <div className={cx("modal-backdrop")} onClick={onClose}>
      <section
        ref={dialogRef}
        className={cx("win team-modal team-info")}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={m.teamInfo.dialogLabel(name)}
        data-testid="agent-office-team-info"
        data-team={team}
      >
        <div className={cx("win-bar")}>
          <span>{m.teamInfo.windowTitle}</span>
          <button ref={closeRef} type="button" className={cx("window-close")} onClick={onClose} aria-label={m.teamInfo.close}>
            ✕
          </button>
        </div>
        <div className={cx("win-body team-info-body")}>
          <h2>
            {icon} {name}
          </h2>
          <p className={cx("team-info-summary")}>{info.summary}</p>
          <div className={cx("live-box")} data-testid="agent-office-team-info-now">
            <span className={cx("tiny-label")}>
              {view || live ? <em className={cx("live-chip")}>{m.real.chip}</em> : null} {m.teamInfo.now}
            </span>
            <span className={cx("status-pill", status)}>{m.deptStatus[status]}</span>
            <strong>{nowLine}</strong>
          </div>
          {sections.map(([key, label, lines]) => (
            <section key={key} className={cx("team-info-section")}>
              <h3>{label}</h3>
              <ul>
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          ))}
          <section className={cx("team-info-section")}>
            <h3>{m.teamInfo.switch}</h3>
            <p>{info.switch}</p>
          </section>
          <div className={cx("profile-record")} data-testid="agent-office-team-info-record">
            {recordHref ? <Link href={recordHref}>{m.teamInfo.record}</Link> : <span>{m.teamInfo.noRecord}</span>}
            {policy ? (
              <span>
                {m.teamInfo.policy} <code>{policy}</code>
              </span>
            ) : null}
          </div>
          <p className={cx("team-info-basis")}>{m.teamInfo.basis}</p>
          <div className={cx("profile-actions")}>
            <button type="button" className={cx("btn btn-primary")} onClick={onClose}>
              {m.teamInfo.close}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function liveRowsFor(
  teams: readonly TeamRow[],
  amuxView: AgentOfficeAmuxView,
  reviewView: AgentOfficeReviewView,
  decisionView: AgentOfficeDecisionView,
  m: OfficeCopy
): AgentOfficeLiveRow[] {
  return [
    ...teams.flatMap((team) =>
      team.live
        ? [
            {
              id: team.id,
              name: `${team.icon} ${team.name}`,
              status: team.status,
              badge: team.live.badge,
              line: team.live.line,
              href: agentOfficeDept(team.id)?.recordHref ?? null,
            },
          ]
        : []
    ),
    {
      id: "amux",
      name: `${ROOM_ICON.amux} ${m.rooms.amux}`,
      status: amuxView.status,
      badge: m.deptStatus[amuxView.status],
      line: amuxView.summary,
      href: AGENT_OFFICE_AMUX_RECORD_HREF,
    },
    {
      id: "review",
      name: `${ROOM_ICON.review} ${m.rooms.review}`,
      status: reviewView.status,
      badge: m.deptStatus[reviewView.status],
      line: reviewView.summary,
      href: null,
    },
    {
      id: "decision",
      name: `${ROOM_ICON.decision} ${m.rooms.decision}`,
      status: decisionView.status,
      badge: m.deptStatus[decisionView.status],
      line: decisionView.summary,
      href: AGENT_OFFICE_DECISION_RECORD_HREF,
    },
  ];
}

type TeamRow = {
  id: string;
  icon: string;
  name: string;
  lead: StaffSeed;
  status: DeptStatus;
  task: string;
  /** The room's real reading, or null for a room without one. */
  live: AgentOfficeLiveDept | null;
};

function DashboardView({
  m,
  engine,
  teams,
  filteredTeams,
  filter,
  setFilter,
  snap,
  readAt,
  staff,
  staffText,
  queue,
  amuxView,
  reviewView,
  decisionView,
  onSelectTeam,
}: {
  m: OfficeCopy;
  engine: AgentOffice;
  teams: TeamRow[];
  filteredTeams: TeamRow[];
  filter: Filter;
  setFilter: (value: Filter) => void;
  snap: Snapshot;
  /** When the server read the live rooms (UTC ISO). */
  readAt: string;
  staff: AgentOfficeStaffCount;
  staffText: string;
  queue: AgentOfficeOperatorQueue;
  amuxView: AgentOfficeAmuxView;
  reviewView: AgentOfficeReviewView;
  decisionView: AgentOfficeDecisionView;
  onSelectTeam: (team: AgentOfficeTeamId) => void;
}) {
  const filterLabel = (value: Filter) => (value === "all" ? m.dashboard.filterAll : m.deptStatus[value]);
  const liveCount = teams.filter((team) => team.live !== null).length;
  const engineeringLive = engine.liveDept("engineering") !== null;
  const todo = operatorQueueTotal(queue);
  const liveRows = liveRowsFor(teams, amuxView, reviewView, decisionView, m);
  // The dashboard is a view of the same reading, so it says the same when the reading stops.
  const stale = useStaleReading(readAt);
  const notConnected = teams.filter((team) => !team.live);
  const notConnectedNames = notConnected.map((team) => team.name).join(" · ");
  const brief = agentOfficeBrief(liveRows);
  const todoText = todo.unknown ? `${todo.total}+?` : String(todo.total);
  const digestHref = agentOfficeDept("digest")?.recordHref ?? null;

  return (
    <>
      <header className={cx("win hero")}>
        <div className={cx("win-bar")}>
          <span>🎛️ {m.company.windowLabel}</span>
          <span className={cx("window-controls")} aria-hidden="true">
            —　▢　✕
          </span>
        </div>
        <div className={cx("hero-body")}>
          <div className={cx("hero-copy")}>
            <p className={cx("eyebrow")}>
              {m.dashboard.eyebrowReal(aestStamp(readAt))}
              {stale ? (
                <span className={cx("stale-note")} role="status" data-testid="agent-office-dashboard-stale">
                  {m.live.stale}
                </span>
              ) : null}
            </p>
            <h2 className={cx("office-title")}>
              {m.dashboard.titleBefore}
              <em className={cx("highlight")}>{m.dashboard.titleAccent}</em>
            </h2>
            <p>{m.dashboard.lead(AGENT_OFFICE_TEAM_IDS.length, staffText)}</p>
          </div>
          <div className={cx("hero-actions")}>
            <span className={cx("trust-copy")}>{m.dashboard.trust}</span>
          </div>
        </div>
      </header>

      <section className={cx("summary-grid")}>
        <article className={cx("metric staff")}>
          <span>{m.dashboard.metricStaff}</span>
          <strong>{staffText}</strong>
          <small data-testid="agent-office-staff-parts">
            {m.dashboard.staffParts(
              String(staff.parts.teams),
              staff.parts.amux === null ? "?" : String(staff.parts.amux),
              staff.parts.review === null ? "?" : String(staff.parts.review),
              staff.parts.decision === null ? "?" : String(staff.parts.decision)
            )}
          </small>
        </article>
        <article className={cx("metric done")}>
          <span>{m.dashboard.metricDone}</span>
          <strong>{snap.stats.done}</strong>
          <small>{m.dashboard.stampDone}</small>
        </article>
        <article className={cx("metric working")}>
          <span>{m.dashboard.metricWorking}</span>
          <strong>{snap.stats.working}</strong>
          <small>{m.dashboard.stampWorking}</small>
        </article>
        <article className={cx("metric approval")}>
          <span>{m.dashboard.metricApproval}</span>
          <strong>{todo.unknown ? `${todo.total}+?` : todo.total}</strong>
          <small>{m.dashboard.stampApproval}</small>
        </article>
        <article className={cx("metric attention")}>
          <span>{m.dashboard.metricAttention}</span>
          <strong>{snap.stats.attention}</strong>
          <small>{m.dashboard.stampAttention}</small>
        </article>
        <article className={cx("metric blocked")}>
          <span>{m.dashboard.metricBlocked}</span>
          <strong>{snap.stats.blocked}</strong>
          <small>{m.dashboard.stampBlocked}</small>
        </article>
      </section>

      <section className={cx("workspace")}>
        <aside className={cx("side-stack")}>
          <section className={cx("win")}>
            <div className={cx("win-bar")}>
              <span>{m.dashboard.scheduleTitle}</span>
              <span className={cx("window-controls")} aria-hidden="true">
                —　▢　✕
              </span>
            </div>
            <div className={cx("win-body")}>
              <p className={cx("tiny-label")}>{m.dashboard.automationHeading}</p>
              {liveRows.length > 0 ? (
                <ul className={cx("auto-list")} data-testid="agent-office-automation">
                  {liveRows.map((row) => (
                    <li key={row.id}>
                      <i className={cx("rm-dot", row.status)} aria-hidden="true" />
                      <b>{row.name}</b>
                      <span className={cx("status-pill", row.status)}>{row.badge}</span>
                      <small>{row.line}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={cx("queue-note")}>{m.dashboard.automationEmpty}</p>
              )}
              {notConnected.length > 0 ? (
                <p className={cx("queue-note")}>
                  {m.dashboard.automationNotConnected(notConnectedNames, notConnected.length)}
                </p>
              ) : null}
            </div>
          </section>

          <section className={cx("win")}>
            <div className={cx("win-bar")}>
              <span>{m.dashboard.recordsTitle}</span>
              <span className={cx("window-controls")} aria-hidden="true">
                —　▢　✕
              </span>
            </div>
            <div className={cx("win-body integration-list")} data-testid="agent-office-records">
              <div className={cx("integration-row")}>
                <b>{m.dashboard.liveLink}</b>
                <span className={cx("mini-badge", liveCount > 0 ? "mint" : "lav")}>
                  {m.dashboard.liveLinkStatus(liveCount)}
                </span>
              </div>
              {AGENT_OFFICE_DEPTS.map((dept) =>
                dept.recordHref ? (
                  <Link key={dept.id} href={dept.recordHref} className={cx("integration-row")}>
                    <b>
                      {dept.icon} {engine.roomName(dept.id)}
                    </b>
                    <span className={cx("mini-badge", engine.liveDept(dept.id) ? "live" : "mint")}>
                      {engine.liveDept(dept.id) ? m.dashboard.recordLive : m.dashboard.recordOpen}
                    </span>
                  </Link>
                ) : (
                  <div key={dept.id} className={cx("integration-row")}>
                    <b>
                      {dept.icon} {engine.roomName(dept.id)}
                    </b>
                    <span className={cx("mini-badge lav")}>{m.dashboard.recordNone}</span>
                  </div>
                )
              )}
            </div>
          </section>
        </aside>

        <div className={cx("main-stack")}>
          <section className={cx("win")}>
            <div className={cx("win-bar")}>
              <span>{m.dashboard.boardTitle}</span>
              <span className={cx("window-controls")} aria-hidden="true">
                —　▢　✕
              </span>
            </div>
            <div className={cx("win-body")}>
              <div className={cx("section-heading")}>
                <div>
                  <p className={cx("eyebrow")}>{m.dashboard.boardEyebrow}</p>
                  <h2>{m.dashboard.boardHeading(teams.length, teams.length)}</h2>
                </div>
                <div className={cx("filter-tabs")} role="group" aria-label={m.dashboard.filterLabel}>
                  {FILTERS.map((item) => (
                    <button
                      type="button"
                      key={item}
                      className={cx(filter === item && "active")}
                      aria-pressed={filter === item}
                      onClick={() => setFilter(item)}
                    >
                      {filterLabel(item)}
                    </button>
                  ))}
                </div>
              </div>
              <div className={cx("team-grid")}>
                {filteredTeams.map((team) => (
                  <button
                    type="button"
                    className={cx("team-card")}
                    key={team.id}
                    onClick={() => onSelectTeam(team.id as AgentOfficeTeamId)}
                    aria-haspopup="dialog"
                  >
                    <span className={cx("status-dot", team.status)} aria-hidden="true" />
                    <span className={cx("mini-pixel")}>
                      <PixelEmployee hair={team.lead.hair} shirt={team.lead.shirt} accent={team.lead.accent} />
                    </span>
                    <span className={cx("team-copy")}>
                      <b>
                        {team.lead.name} · {team.icon} {team.name}
                        {team.live ? <em className={cx("live-chip")}>{m.real.chip}</em> : null}
                      </b>
                      <small>{team.live ? team.live.line : team.task}</small>
                    </span>
                    <span className={cx("status-pill", team.status)}>
                      {team.live ? team.live.badge : m.deptStatus[team.status]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className={cx("two-col")}>
            <section className={cx("win")}>
              <div className={cx("win-bar")}>
                <span>{m.approval.windowTitle}</span>
                <span className={cx("window-controls")} aria-hidden="true">
                  —　▢　✕
                </span>
              </div>
              <div className={cx("win-body approval-body")}>
                <OperatorQueueList m={m} queue={queue} />
                {engineeringLive ? <LiveDecisionNote m={m} /> : null}
              </div>
            </section>

            <section className={cx("win secretary")}>
              <div className={cx("win-bar")}>
                <span>{m.dashboard.briefTitle}</span>
                <span className={cx("window-controls")} aria-hidden="true">
                  —　▢　✕
                </span>
              </div>
              <div className={cx("win-body")}>
                <h3>
                  {brief.attention.length > 0
                    ? m.dashboard.briefNeedsLook(brief.attention.length)
                    : m.dashboard.briefAllClear}
                </h3>
                <ul data-testid="agent-office-brief">
                  {brief.attention.map((row) => (
                    <li key={row.id}>
                      <span className={cx("dot yellow")} />
                      {row.name}: {row.line}
                    </li>
                  ))}
                  {brief.working.map((row) => (
                    <li key={row.id}>
                      <span className={cx("dot green")} />
                      {row.name}: {row.line}
                    </li>
                  ))}
                  <li>
                    <span className={cx("dot gray")} />
                    {[
                      m.dashboard.briefWorking(brief.working.length),
                      m.dashboard.briefQuiet(brief.quiet),
                      m.dashboard.briefNotConnected(notConnected.length),
                    ].join(" · ")}
                  </li>
                </ul>
                <div className={cx("decision-box")}>
                  <strong>{m.dashboard.briefTodo(todoText)}</strong>
                  {digestHref ? (
                    <Link href={digestHref} className={cx("btn")}>
                      {m.dashboard.briefDigestLink}
                    </Link>
                  ) : null}
                </div>
              </div>
            </section>
          </section>
        </div>
      </section>

      <section className={cx("win storage")}>
        <div className={cx("win-bar")}>
          <span>{m.dashboard.storageTitle}</span>
          <span className={cx("window-controls")} aria-hidden="true">
            —　▢　✕
          </span>
        </div>
        <div className={cx("win-body")}>
          <div className={cx("section-heading")}>
            <div>
              <p className={cx("eyebrow")}>{m.dashboard.storageEyebrow}</p>
              <h2>{m.dashboard.storageHeading}</h2>
            </div>
          </div>
          <div className={cx("result-table")}>
            <div className={cx("result-row header")}>
              <span>{m.dashboard.storageOutput}</span>
              <span>{m.dashboard.storageTeam}</span>
              <span>{m.dashboard.storageStatus}</span>
              <span>{m.dashboard.storageLink}</span>
            </div>
            {liveRows.filter((row) => row.href).length > 0 ? (
              liveRows
                .filter((row) => row.href)
                .map((row) => (
                  <div className={cx("result-row")} key={row.id} data-testid="agent-office-latest-record">
                    <span>{row.line}</span>
                    <span>{row.name}</span>
                    <span className={cx("status-pill", row.status)}>{row.badge}</span>
                    <Link href={row.href as string}>{m.dashboard.storageOpen}</Link>
                  </div>
                ))
            ) : (
              <p className={cx("storage-empty")}>{m.dashboard.storageEmpty}</p>
            )}
          </div>
          <p className={cx("queue-note")}>{m.dashboard.storageContentNote}</p>
        </div>
      </section>

      <p className={cx("dash-note")}>
        {m.dashboard.note(engine.operatorSeed.name, AGENT_OFFICE_TEAM_IDS.length, staffText)}
      </p>
    </>
  );
}
