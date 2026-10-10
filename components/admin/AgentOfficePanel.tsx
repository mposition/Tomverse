"use client";

import type { CSSProperties, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import AgentOfficeWorld from "@/components/admin/AgentOfficeWorld";
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
  reviewQuotaView,
  reviewRoomView,
  financeLiveDept,
  qaLiveDept,
  researchLiveDept,
  type AgentOfficeAmuxView,
  type AgentOfficeReviewView,
  type AgentOfficeSeatedView,
  type AgentOfficeQuotaView,
  type AgentOfficeOperatorQueue,
  type AgentOfficeLiveRow,
  type AgentOfficeLiveDept,
  type AgentOfficeLiveRooms,
} from "@/lib/agentOffice/live";
import {
  AGENT_OFFICE_AMUX_RECORD_HREF,
  AGENT_OFFICE_DEPTS,
  AGENT_OFFICE_TEAM_IDS,
  agentOfficeDept,
  agentOfficeSeatedClothes,
  type AgentOfficeSeatedRoom,
} from "@/lib/agentOffice/roster";
import {
  AgentOffice,
  type Agent,
  type AgentStatus,
  type DeptStatus,
  type OfficeCopy,
  type Snapshot,
  type StaffSeed,
} from "@/lib/agentOffice/sim";
import { aestStamp, brisbaneIso } from "@/lib/agentOffice/time";
import { AMUX_ROOM, DEPT_ROOMS, REVIEW_ROOM } from "@/lib/agentOffice/world";

type View = "live" | "dashboard";
type Filter = "all" | DeptStatus;

const OFFICE_PATH = "/admin/office";
/** A section is an address (docs/ui-contracts/admin-console-ia.md, rule 2). */
const viewHref = (view: View) => `${OFFICE_PATH}?tab=${view}`;

const FILTERS: readonly Filter[] = ["all", "working", "done", "approval", "attention", "blocked"];

/** The colour a person's status pill takes, from the same five tones as a room. */
const AGENT_STATUS_TONE: Record<AgentStatus, DeptStatus> = {
  working: "working",
  meeting: "approval",
  reporting: "approval",
  blocked: "blocked",
  onBreak: "done",
  offDuty: "waiting",
  commuting: "waiting",
  idle: "waiting",
  moving: "waiting",
};

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
 * The Agent office: a pixel office for the eight agent teams, after the
 * original AI OFFICE UI by godseng.mom.
 *
 * A shell. The day it plays is a demo scenario run in this browser tab, and
 * its approve button advances the demo and nothing else. The facts on the
 * screen are the record links, which point at the console pages each team
 * already has, and the rooms marked LIVE, whose state the server read and
 * the demo leaves alone.
 */
export function AgentOfficePanel({ view, live }: { view: View; live: AgentOfficeLiveRooms }) {
  const m = useAdminMessages(adminAgentOfficeMessages);
  const router = useRouter();
  // The rooms that read a real record, in the console's language. Each
  // navigation brings a fresh server reading, and the engine takes it.
  const liveDepts = useMemo<Record<string, AgentOfficeLiveDept>>(
    () => ({
      research: researchLiveDept(live.research, live.readAt, m.real.research),
      qa: qaLiveDept(live.qa, live.readAt, m.real.qa),
      finance: financeLiveDept(live.finance, live.readAt, m.real.finance),
      engineering: engineeringLiveDept(live.engineering, live.readAt, m.real.engineering),
    }),
    [live, m]
  );
  // The AMUX room is not a team: its workers are drawn from the record and never enter the demo.
  const amuxView = useMemo(
    () => amuxRoomView(live.amux, live.readAt, AMUX_ROOM.desks.length, m.real.amux),
    [live, m]
  );
  const reviewView = useMemo(
    () => reviewRoomView(live.review, live.readAt, REVIEW_ROOM.desks.length, m.real.review),
    [live, m]
  );
  const quotaView = useMemo(() => reviewQuotaView(live.review, m.real.quota), [live, m]);
  const [engine] = useState(() => new AgentOffice(m, liveDepts));
  const [snap, setSnap] = useState<Snapshot>(() => engine.snapshot());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The camera keeps the selected person in view when zoomed in.
  const follow = true;
  const [briefing, setBriefing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      engine.tick(dt);
      acc += dt;
      if (acc >= 0.18) {
        acc = 0;
        setSnap(engine.snapshot());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  // The paint loop picks the new statuses up on its next snapshot.
  useEffect(() => {
    engine.setLive(liveDepts);
  }, [engine, liveDepts]);

  // A fresh reading of the live rooms every minute while the tab is visible:
  // the page's server component reads again and a room whose record changed
  // says so (engine.setLive). Reading only -- nothing on the page writes.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, LIVE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [router]);

  useEffect(() => {
    engine.setBriefingHandler(() => setBriefing(true));
    return () => engine.setBriefingHandler(null);
  }, [engine]);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2400);
  }, []);

  const onSelect = useCallback((agent: Agent) => setSelectedId(agent.id), []);
  // A seated figure is not an engine agent: it is named by its room and the
  // name its record gives it, and its profile is re-read from that record.
  const [seated, setSeated] = useState<{ room: AgentOfficeSeatedRoom; name: string } | null>(null);
  const onSelectSeated = useCallback((room: AgentOfficeSeatedRoom, name: string) => setSeated({ room, name }), []);

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

  const askAgent = useCallback(
    (agent: Agent) => {
      engine.command(m.console.ask(agent.name));
      setSelectedId(null);
      reveal("agent-office-console");
    },
    [engine, m, reveal]
  );

  const teams = useMemo(
    () =>
      DEPT_ROOMS.map((room) => ({
        id: room.id,
        icon: room.icon,
        name: engine.roomName(room.id),
        lead: engine.deptLead[room.id],
        status: snap.deptStatus[room.id] ?? "waiting",
        task: engine.deptCopy(room.id).task,
        live: liveDepts[room.id] ?? null,
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
        rows: liveRowsFor(teams, amuxView, reviewView, m),
        notConnected: teams.filter((team) => !team.live).map((team) => `${team.icon} ${team.name}`),
        queue: OPERATOR_QUEUE_KEYS.map((key) => ({ label: m.queue.labels[key], count: live.queue[key] })),
        quota: quotaView,
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
  const selected = selectedId ? engine.agentById.get(selectedId) ?? null : null;
  // The operator's to-do is the real queues an agent waits on (OPERATOR_QUEUE_KEYS).
  const todo = operatorQueueTotal(live.queue);

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
                className={cx("todo-tab", todo.total > 0 && "urgent")}
                onClick={() => reveal("agent-office-approval")}
                title={todo.unknown ? m.queue.partial : undefined}
              >
                {m.nav.todo} <i>{todo.unknown ? `${todo.total}+?` : todo.total}</i>
              </button>
            </div>
          </nav>

          {/* The real view needs no banner: what it shows is real or says it
              is waiting on a link. The demo says it is a demo while it plays. */}
          {snap.demo ? (
            <div className={cx("shell-notice")} role="note" data-testid="agent-office-shell-notice">
              <span className={cx("mini-badge demo")}>{m.shell.chip}</span>
              <p>{m.shell.notice}</p>
            </div>
          ) : null}

          {view === "live" ? (
            <LiveView
              m={m}
              engine={engine}
              amuxView={amuxView}
              reviewView={reviewView}
              quotaView={quotaView}
              queue={live.queue}
              readAt={live.readAt}
              snap={snap}
              follow={follow}
              selectedId={selectedId}
              onSelect={onSelect}
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
              queue={live.queue}
              amuxView={amuxView}
              reviewView={reviewView}
              onSelect={(id) => setSelectedId(id)}
            />
          )}
        </div>
      </div>

      {selected ? (
        <ProfileModal
          m={m}
          engine={engine}
          agent={selected}
          onClose={() => setSelectedId(null)}
          onAsk={askAgent}
        />
      ) : null}
      {seated ? (
        <SeatedProfileModal
          m={m}
          seated={seated}
          amuxView={amuxView}
          reviewView={reviewView}
          quotaView={quotaView}
          onClose={() => setSeated(null)}
        />
      ) : null}
      {briefing ? (
        <BriefingModal
          m={m}
          narrator={engine.deptLead.digest}
          snap={snap}
          engineeringLive={engine.liveDept("engineering") !== null}
          onClose={() => setBriefing(false)}
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

/**
 * The approval card while the engineering room reads its real record: the
 * demo plays no draft and no approval, and real decisions are made on the
 * engineering agent's own screen, never here.
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

function LiveView({
  m,
  engine,
  amuxView,
  reviewView,
  quotaView,
  queue,
  readAt,
  snap,
  follow,
  selectedId,
  onSelect,
  onSelectSeated,
  onCopyReport,
  onDownloadReport,
}: {
  m: OfficeCopy;
  engine: AgentOffice;
  amuxView: AgentOfficeAmuxView;
  reviewView: AgentOfficeReviewView;
  quotaView: AgentOfficeQuotaView;
  queue: AgentOfficeOperatorQueue;
  /** When the server read the live rooms (UTC ISO). */
  readAt: string;
  snap: Snapshot;
  follow: boolean;
  selectedId: string | null;
  onSelect: (agent: Agent) => void;
  onSelectSeated: (room: AgentOfficeSeatedRoom, name: string) => void;
  onCopyReport: () => void;
  onDownloadReport: () => void;
}) {
  const engineeringLive = engine.liveDept("engineering") !== null;

  return (
    <>
      <header className={cx("live-hero")}>
        <div>
          <p className={cx("eyebrow")}>
            {snap.demo ? m.live.eyebrow(engine.staff.length) : m.live.eyebrowReal(engine.staff.length)}
          </p>
          <h2 className={cx("office-title")}>
            {m.company.titlePrefix} <em className={cx("highlight")}>{m.company.titleAccent}</em>
          </h2>
          <p>{snap.demo ? m.live.lead : m.live.leadReal}</p>
        </div>
        {snap.demo ? (
          <div className={cx("live-clock")}>
            <span>{m.live.clockLabel}</span>
            <b data-testid="agent-office-clock">{snap.clock}</b>
            <small>{snap.phase}</small>
          </div>
        ) : (
          <div className={cx("live-clock")}>
            <span>{m.live.clockReal}</span>
            <b data-testid="agent-office-clock">{aestStamp(readAt)}</b>
            <small>{m.live.realPhase}</small>
          </div>
        )}
      </header>

      <section className={cx("live-bar")}>
        <button
          type="button"
          className={cx("btn btn-ghost")}
          onClick={onCopyReport}
          title={m.live.reportHint}
          data-testid="agent-office-report-copy"
        >
          {m.live.reportCopy}
        </button>
        <button
          type="button"
          className={cx("btn btn-ghost")}
          onClick={onDownloadReport}
          title={m.live.reportHint}
          data-testid="agent-office-report-download"
        >
          {m.live.reportDownload}
        </button>
        <div className={cx("live-counts")}>
          <span className={cx("lc done")}>{m.live.done(snap.stats.done)}</span>
          <span className={cx("lc working")}>{m.live.working(snap.stats.working)}</span>
          <span className={cx("lc attention")}>{m.live.attention(snap.stats.attention)}</span>
          <span className={cx("lc blocked")}>{m.live.blocked(snap.stats.blocked)}</span>
        </div>
      </section>

      <section className={cx("live-grid")}>
        <AgentOfficeWorld
          engine={engine}
          amux={amuxView}
          review={reviewView}
          snap={snap}
          selectedId={selectedId}
          follow={follow}
          onSelect={onSelect}
          onSelectSeated={onSelectSeated}
        />

        <aside className={cx("live-rail")}>
          <OperatorConsole m={m} engine={engine} snap={snap} />

          <section className={cx("win rail-card")} id="agent-office-approval">
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

          <QuotaCard m={m} view={quotaView} />
        </aside>
      </section>
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
 * The reviewers' account quota, from the review server's own check. Read
 * only: it shows what the server last reported and how old that is.
 */
function QuotaCard({ m, view }: { m: OfficeCopy; view: AgentOfficeQuotaView }) {
  return (
    <section className={cx("win rail-card")} data-testid="agent-office-quota">
      <div className={cx("win-bar")}>
        <span>{m.real.quota.windowTitle}</span>
        <span className={cx("window-controls")} aria-hidden="true">
          —　▢　✕
        </span>
      </div>
      <div className={cx("win-body quota-body")}>
        {view.rows.length > 0 ? (
          <ul className={cx("quota-list")}>
            {view.rows.map((row) => (
              <li key={row.id}>
                <i className={cx("rm-dot", row.status)} aria-hidden="true" />
                <b>{row.id}</b>
                <small>{row.vendor}</small>
                <span className={cx("quota-state")}>{row.label}</span>
                <span className={cx("quota-amount")}>{row.amount}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {view.note ? <p className={cx("quota-note")}>{view.note}</p> : null}
      </div>
    </section>
  );
}

function OperatorConsole({ m, engine, snap }: { m: OfficeCopy; engine: AgentOffice; snap: Snapshot }) {
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const count = snap.chat.length;
  const lastId = snap.chat.at(-1)?.id;

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, lastId]);

  const send = (text: string) => {
    const value = text.trim();
    if (!value) return;
    engine.command(value);
    setDraft("");
  };

  return (
    <section className={cx("win rail-card console-card")} id="agent-office-console">
      <div className={cx("win-bar")}>
        <span>{m.console.windowTitle}</span>
        <span className={cx("window-controls")} aria-hidden="true">
          —　▢　✕
        </span>
      </div>
      <div className={cx("win-body console-body")}>
        <div className={cx("console-log")} ref={logRef} aria-live="polite" data-testid="agent-office-console-log">
          {snap.chat.map((entry) => (
            <div key={entry.id} className={cx("console-line", entry.from)}>
              <b>{entry.from === "operator" ? m.console.operatorLabel : entry.name}</b>
              <p>{entry.text}</p>
              <small>{entry.time}</small>
            </div>
          ))}
        </div>

        <div className={cx("console-quick")}>
          {m.console.quick.map((item) => (
            <button type="button" key={item.label} onClick={() => send(item.command)}>
              {item.label}
            </button>
          ))}
        </div>

        <form
          className={cx("console-input")}
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={m.console.placeholder}
            aria-label={m.console.inputLabel}
            data-testid="agent-office-console-input"
          />
          <button type="submit">{m.console.send}</button>
        </form>
      </div>
    </section>
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

function ProfileModal({
  m,
  engine,
  agent,
  onClose,
  onAsk,
}: {
  m: OfficeCopy;
  engine: AgentOffice;
  agent: Agent;
  onClose: () => void;
  onAsk: (agent: Agent) => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useOfficeDialog(onClose, closeRef);
  const dept = agentOfficeDept(agent.deptId);
  const live = engine.liveDept(agent.deptId);
  return (
    <div className={cx("modal-backdrop")} onClick={onClose}>
      <section
        ref={dialogRef}
        className={cx("win team-modal")}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={m.profile.dialogLabel(agent.name)}
        data-testid="agent-office-profile"
      >
        <div className={cx("win-bar")}>
          <span>{m.profile.windowTitle}</span>
          <button ref={closeRef} type="button" className={cx("window-close")} onClick={onClose} aria-label={m.profile.closeIcon}>
            ✕
          </button>
        </div>
        <div className={cx("win-body employee-profile")}>
          <div className={cx("profile-top")}>
            <PixelEmployee hair={agent.hair} shirt={agent.shirt} accent={agent.accent} />
            <div>
              <span className={cx("status-pill", AGENT_STATUS_TONE[agent.status])}>{m.agentStatus[agent.status]}</span>
              <h2>
                {agent.name}
                {agent.callsign ? <small> · {agent.callsign}</small> : null}
              </h2>
              <p>
                {agent.role}
                {dept ? ` · ${engine.roomName(dept.id)}` : null}
              </p>
            </div>
          </div>
          <div className={cx("profile-task")}>
            <span className={cx("tiny-label")}>{m.profile.doingNow}</span>
            <strong>{agent.taskLabel}</strong>
            {agent.anim === "type" ? (
              <span className={cx("profile-progress")}>
                <i style={{ width: `${Math.round(agent.progress * 100)}%` }} />
              </span>
            ) : null}
          </div>
          <div className={cx("report-box")}>
            <span className={cx("tiny-label")}>{m.profile.lastWord}</span>
            <strong>{agent.speech ?? live?.line ?? agent.thoughts[0]}</strong>
          </div>
          {live ? (
            <div className={cx("live-box")} data-testid="agent-office-profile-live">
              <span className={cx("tiny-label")}>
                <em className={cx("live-chip")}>{m.real.chip}</em> {m.real.boxLabel}
              </span>
              <strong>{live.line}</strong>
              <small>{live.detail}</small>
              <small>{m.real.contentElsewhere}</small>
            </div>
          ) : null}
          {dept ? (
            <div className={cx("profile-record")} data-testid="agent-office-profile-record">
              {dept.recordHref ? (
                <Link href={dept.recordHref}>{m.profile.record}</Link>
              ) : (
                <span>{m.profile.noRecord}</span>
              )}
              {dept.policy ? (
                <span>
                  {m.profile.policy} <code>{dept.policy}</code>
                </span>
              ) : null}
            </div>
          ) : null}
          <div className={cx("profile-actions")}>
            <button type="button" className={cx("btn btn-primary")} onClick={() => onAsk(agent)}>
              {m.profile.ask}
            </button>
            <button type="button" className={cx("text-button")} onClick={onClose}>
              {m.profile.close}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
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
  quotaView,
  onClose,
}: {
  m: OfficeCopy;
  seated: { room: AgentOfficeSeatedRoom; name: string };
  amuxView: AgentOfficeAmuxView;
  reviewView: AgentOfficeReviewView;
  quotaView: AgentOfficeQuotaView;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useOfficeDialog(onClose, closeRef);
  const people: AgentOfficeSeatedView[] = seated.room === "amux" ? amuxView.workers : reviewView.reviewers;
  const desk = people.findIndex((person) => person.name === seated.name);
  const person = desk >= 0 ? people[desk] : null;
  const clothes = agentOfficeSeatedClothes(seated.room, Math.max(desk, 0));
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
              <p>{seated.room === "amux" ? m.rooms.amux : m.rooms.review}</p>
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
          {seated.room === "amux" && AGENT_OFFICE_AMUX_RECORD_HREF ? (
            <div className={cx("profile-record")} data-testid="agent-office-seated-profile-record">
              <Link href={AGENT_OFFICE_AMUX_RECORD_HREF}>{m.profile.record}</Link>
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

function BriefingModal({
  m,
  narrator,
  snap,
  engineeringLive,
  onClose,
}: {
  m: OfficeCopy;
  narrator: StaffSeed | undefined;
  snap: Snapshot;
  /** Engineering reads its real record: its decisions are made on its own screen. */
  engineeringLive: boolean;
  onClose: () => void;
}) {
  const okRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useOfficeDialog(onClose, okRef);
  return (
    <div className={cx("modal-backdrop")} onClick={onClose}>
      <section
        ref={dialogRef}
        className={cx("win team-modal secretary")}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={m.briefing.dialogLabel}
      >
        <div className={cx("win-bar")}>
          <span>{m.briefing.windowTitle}</span>
          <button type="button" className={cx("window-close")} onClick={onClose} aria-label={m.profile.closeIcon}>
            ✕
          </button>
        </div>
        <div className={cx("win-body")}>
          <p className={cx("brief-date")}>{m.briefing.dateLine(snap.clock, narrator?.name ?? "")}</p>
          <h3>{m.briefing.title}</h3>
          <ul>
            <li>
              <span className={cx("dot green")} />
              {m.briefing.done(snap.stats.done)}
            </li>
            {snap.approved ? (
              <li>
                <span className={cx("dot green")} />
                {m.briefing.approved}
              </li>
            ) : null}
            {snap.stats.attention > 0 ? (
              <li>
                <span className={cx("dot yellow")} />
                {m.briefing.attention(snap.stats.attention)}
              </li>
            ) : null}
            <li>
              <span className={cx("dot gray")} />
              {m.briefing.blocked(snap.stats.blocked)}
            </li>
          </ul>
          <div className={cx("decision-box")}>
            <span className={cx("tiny-label")}>{m.briefing.decisionLabel}</span>
            <strong>{engineeringLive ? m.dashboard.decisionLive : m.briefing.decisionNone}</strong>
            {engineeringLive && ENGINEERING_RECORD_HREF ? (
              <Link href={ENGINEERING_RECORD_HREF} onClick={onClose}>
                {m.approval.liveLink}
              </Link>
            ) : null}
          </div>
          <button ref={okRef} type="button" className={cx("btn btn-primary")} onClick={onClose}>
            {m.briefing.ok}
          </button>
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
function liveRowsFor(
  teams: readonly TeamRow[],
  amuxView: AgentOfficeAmuxView,
  reviewView: AgentOfficeReviewView,
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
      name: `${AMUX_ROOM.icon} ${m.rooms.amux}`,
      status: amuxView.status,
      badge: m.deptStatus[amuxView.status],
      line: amuxView.summary,
      href: AGENT_OFFICE_AMUX_RECORD_HREF,
    },
    {
      id: "review",
      name: `${REVIEW_ROOM.icon} ${m.rooms.review}`,
      status: reviewView.status,
      badge: m.deptStatus[reviewView.status],
      line: reviewView.summary,
      href: null,
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
  /** The room's real reading, or null for a demo room. */
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
  queue,
  amuxView,
  reviewView,
  onSelect,
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
  queue: AgentOfficeOperatorQueue;
  amuxView: AgentOfficeAmuxView;
  reviewView: AgentOfficeReviewView;
  onSelect: (id: string) => void;
}) {
  const filterLabel = (value: Filter) => (value === "all" ? m.dashboard.filterAll : m.deptStatus[value]);
  const liveCount = teams.filter((team) => team.live !== null).length;
  const engineeringLive = engine.liveDept("engineering") !== null;
  const todo = operatorQueueTotal(queue);
  const liveRows = liveRowsFor(teams, amuxView, reviewView, m);
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
              {snap.demo ? m.dashboard.eyebrow : m.dashboard.eyebrowReal(aestStamp(readAt))}
            </p>
            <h2 className={cx("office-title")}>
              {m.dashboard.titleBefore}
              <em className={cx("highlight")}>{m.dashboard.titleAccent}</em>
            </h2>
            <p>{m.dashboard.lead(AGENT_OFFICE_TEAM_IDS.length, engine.staff.length)}</p>
          </div>
          <div className={cx("hero-actions")}>
            <span className={cx("trust-copy")}>{m.dashboard.trust}</span>
          </div>
        </div>
      </header>

      <section className={cx("summary-grid")}>
        <article className={cx("metric staff")}>
          <span>{m.dashboard.metricStaff}</span>
          <strong>{engine.staff.length}</strong>
          <small>{m.dashboard.stampStaff}</small>
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
                  <button type="button" className={cx("team-card")} key={team.id} onClick={() => onSelect(team.lead.id)}>
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
                <p className={cx("brief-date")}>{m.dashboard.briefAsOf(aestStamp(readAt))}</p>
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
        {m.dashboard.note(engine.operatorSeed.name, AGENT_OFFICE_TEAM_IDS.length, engine.staff.length)}
      </p>
    </>
  );
}
