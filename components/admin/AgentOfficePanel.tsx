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
  reviewRoomView,
  financeLiveDept,
  qaLiveDept,
  researchLiveDept,
  utcStamp,
  type AgentOfficeAmuxView,
  type AgentOfficeReviewView,
  type AgentOfficeLiveDept,
  type AgentOfficeLiveRooms,
} from "@/lib/agentOffice/live";
import { AGENT_OFFICE_DEPTS, AGENT_OFFICE_TEAM_IDS, agentOfficeDept } from "@/lib/agentOffice/roster";
import {
  AgentOffice,
  PHASE,
  type Agent,
  type AgentStatus,
  type DeptStatus,
  type OfficeCopy,
  type Snapshot,
  type StaffSeed,
} from "@/lib/agentOffice/sim";
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

  const approve = () => {
    engine.approve();
    showToast(m.live.toastApproved);
  };

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
  const selected = selectedId ? engine.agentById.get(selectedId) ?? null : null;
  const todo = snap.approvalPending ? 1 : 0;

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
                className={cx("todo-tab", todo > 0 && "urgent")}
                onClick={() => reveal("agent-office-approval")}
              >
                {m.nav.todo} <i>{todo}</i>
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
              readAt={live.readAt}
              snap={snap}
              follow={follow}
              selectedId={selectedId}
              onSelect={onSelect}
              onApprove={approve}
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
              onApprove={approve}
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
  readAt,
  snap,
  follow,
  selectedId,
  onSelect,
  onApprove,
}: {
  m: OfficeCopy;
  engine: AgentOffice;
  amuxView: AgentOfficeAmuxView;
  reviewView: AgentOfficeReviewView;
  /** When the server read the live rooms (UTC ISO). */
  readAt: string;
  snap: Snapshot;
  follow: boolean;
  selectedId: string | null;
  onSelect: (agent: Agent) => void;
  onApprove: () => void;
}) {
  const waitingNames = engine.approverNames();
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
            <b data-testid="agent-office-clock">{utcStamp(readAt)}</b>
            <small>{m.live.realPhase}</small>
          </div>
        )}
      </header>

      <section className={cx("live-bar")}>
        <button type="button" className={cx("btn btn-ghost")} disabled title={m.live.publishHint}>
          {m.live.publish}
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
            <div className={cx("win-body approval-body", snap.approvalPending && "pending")}>
              {snap.approvalPending ? (
                <>
                  <div className={cx("approval-top")}>
                    <span className={cx("approval-chips")}>
                      <span className={cx("mini-badge demo")}>{m.approval.demoChip}</span>
                      <span className={cx("mini-badge yellow")}>{m.approval.badgePending}</span>
                    </span>
                    <span className={cx("score blink")}>{m.approval.awaiting}</span>
                  </div>
                  <h3>{m.approval.title}</h3>
                  <p>{m.approval.waiting(waitingNames)}</p>
                  <div className={cx("reason-list")}>
                    {m.approval.reasons.map((reason) => (
                      <span key={reason}>{reason}</span>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={cx("btn approve-button")}
                    onClick={onApprove}
                    data-testid="agent-office-approve"
                  >
                    {m.approval.approve}
                  </button>
                </>
              ) : engineeringLive ? (
                <LiveDecisionNote m={m} />
              ) : (
                <>
                  <div className={cx("approval-top")}>
                    <span className={cx("approval-chips")}>
                      <span className={cx("mini-badge demo")}>{m.approval.demoChip}</span>
                      <span className={cx("mini-badge mint")}>
                        {snap.approved ? m.approval.badgeApproved : m.approval.badgeNone}
                      </span>
                    </span>
                  </div>
                  <h3>{snap.approved ? m.approval.approvedTitle : m.approval.noneTitle}</h3>
                  <p>{snap.approved ? m.approval.approvedBody : m.approval.noneBody}</p>
                </>
              )}
            </div>
          </section>
        </aside>
      </section>
    </>
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
  onApprove,
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
  onApprove: () => void;
  onSelect: (id: string) => void;
}) {
  const filterLabel = (value: Filter) => (value === "all" ? m.dashboard.filterAll : m.deptStatus[value]);
  const liveCount = teams.filter((team) => team.live !== null).length;
  const engineeringLive = engine.liveDept("engineering") !== null;

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
              {snap.demo ? m.dashboard.eyebrow : m.dashboard.eyebrowReal(utcStamp(readAt))}
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
          <strong>{snap.stats.approval}</strong>
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
              <div className={cx("schedule-card")}>
                <div>
                  <span className={cx("tiny-label")}>{m.dashboard.scheduleLabel}</span>
                  <strong>{m.dashboard.scheduleNone}</strong>
                  <p>{m.dashboard.scheduleBody}</p>
                </div>
                <span className={cx("toggle-off")}>{m.dashboard.scheduleOff}</span>
              </div>
              <div className={cx("flow-list")}>
                {m.phases.slice(PHASE.arrival, PHASE.dayOver).map((item, index) => {
                  const phase = index + PHASE.arrival;
                  // A phase a live room replaces is not played, so it is never ticked.
                  const skipped = snap.skippedPhases.includes(phase);
                  return (
                    <div className={cx("flow-row", snap.phaseIndex > phase && !skipped && "past")} key={item}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <b>
                        {item}
                        {skipped ? <em className={cx("live-chip")}>{m.dashboard.phaseSkipped}</em> : null}
                      </b>
                      <i aria-hidden="true">
                        {skipped ? "–" : snap.phaseIndex === phase ? "●" : snap.phaseIndex > phase ? "✓" : "·"}
                      </i>
                    </div>
                  );
                })}
              </div>
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
                {engineeringLive && !snap.approvalPending ? (
                  <LiveDecisionNote m={m} />
                ) : (
                  <>
                    <div className={cx("approval-top")}>
                      <span className={cx("approval-chips")}>
                        <span className={cx("mini-badge demo")}>{m.approval.demoChip}</span>
                        <span className={cx("mini-badge yellow")}>{m.approval.dashboardBadge}</span>
                      </span>
                      <span className={cx("score")}>{m.approval.dashboardScore}</span>
                    </div>
                    <h3>{m.approval.title}</h3>
                    <p>{m.approval.dashboardBody}</p>
                    <button
                      type="button"
                      className={cx("btn approve-button", snap.approved && "approved")}
                      onClick={onApprove}
                      disabled={!snap.approvalPending}
                    >
                      {snap.approved
                        ? m.approval.approvedButton
                        : snap.approvalPending
                          ? m.approval.approve
                          : m.approval.noneButton}
                    </button>
                  </>
                )}
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
                <p className={cx("brief-date")}>{m.dashboard.briefDate(snap.clock)}</p>
                <h3>{snap.dayComplete ? m.dashboard.briefDoneTitle : m.dashboard.briefNowTitle}</h3>
                <ul>
                  <li>
                    <span className={cx("dot green")} />
                    {m.dashboard.briefPhase(snap.phase, snap.stats.done)}
                  </li>
                  <li>
                    <span className={cx("dot", snap.approvalPending ? "yellow" : "green")} />
                    {snap.approvalPending
                      ? m.dashboard.briefApprovalNeeded
                      : engineeringLive
                        ? m.dashboard.decisionLive
                        : m.dashboard.briefNoApproval}
                  </li>
                  {snap.stats.attention > 0 ? (
                    <li>
                      <span className={cx("dot yellow")} />
                      {m.dashboard.briefAttention(snap.stats.attention)}
                    </li>
                  ) : null}
                  <li>
                    <span className={cx("dot gray")} />
                    {m.dashboard.briefBlocked}
                  </li>
                </ul>
                <div className={cx("decision-box")}>
                  <span className={cx("tiny-label")}>{m.dashboard.decisionLabel}</span>
                  <strong>
                    {snap.approvalPending
                      ? m.dashboard.decisionPending
                      : snap.approved
                        ? m.dashboard.decisionDone
                        : engineeringLive
                          ? m.dashboard.decisionLive
                          : m.dashboard.decisionNone}
                  </strong>
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
            <p className={cx("storage-empty")}>{m.dashboard.storageEmpty}</p>
          </div>
        </div>
      </section>

      <p className={cx("dash-note")}>
        {m.dashboard.note(engine.operatorSeed.name, AGENT_OFFICE_TEAM_IDS.length, engine.staff.length)}
      </p>
    </>
  );
}
