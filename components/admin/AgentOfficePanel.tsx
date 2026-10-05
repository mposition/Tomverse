"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import AgentOfficeWorld from "@/components/admin/AgentOfficeWorld";
import { cx } from "@/components/admin/agentOfficeStyles";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAgentOfficeMessages } from "@/lib/adminMessages/agentOffice";
import { AGENT_OFFICE_DEPTS, AGENT_OFFICE_TEAM_IDS, agentOfficeDept } from "@/lib/agentOffice/roster";
import {
  AgentOffice,
  PHASE,
  PHASE_COUNT,
  type Agent,
  type DeptStatus,
  type OfficeCopy,
  type Snapshot,
  type StaffSeed,
} from "@/lib/agentOffice/sim";
import { DEPT_ROOMS } from "@/lib/agentOffice/world";

type View = "live" | "dashboard";
type Filter = "all" | DeptStatus;

const FILTERS: readonly Filter[] = ["all", "working", "done", "approval", "blocked"];

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
 * The Agent office: a pixel office for the seven agent teams, after the
 * original AI OFFICE UI by godseng.mom.
 *
 * A shell. The day it plays is a demo scenario run in this browser tab; it
 * reads no agent's record, and its approve button advances the demo and
 * nothing else. The only facts on the screen are the record links, which
 * point at the console pages each team already has.
 */
export function AgentOfficePanel() {
  const m = useAdminMessages(adminAgentOfficeMessages);
  const [engine] = useState(() => new AgentOffice(m));
  const [snap, setSnap] = useState<Snapshot>(() => engine.snapshot());
  const [view, setView] = useState<View>("live");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
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

  const askAgent = useCallback(
    (agent: Agent) => {
      engine.command(m.console.ask(agent.name));
      setSelectedId(null);
      window.setTimeout(
        () => document.getElementById("agent-office-console")?.scrollIntoView({ behavior: "smooth", block: "center" }),
        60
      );
    },
    [engine, m]
  );

  const start = () => {
    engine.start();
    setBriefing(false);
    setView("live");
    showToast(m.live.toastStart(engine.staff.length));
  };

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
      })),
    [engine, snap.deptStatus]
  );

  const filteredTeams = filter === "all" ? teams : teams.filter((team) => team.status === filter);
  const selected = selectedId ? engine.agentById.get(selectedId) ?? null : null;
  const todo = snap.approvalPending ? 1 : 0;
  const onDuty = engine.agents.filter((a) => a.rank !== "operator" && a.status !== "offDuty").length;

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
              <button
                type="button"
                className={cx(view === "live" && "active")}
                aria-pressed={view === "live"}
                onClick={() => setView("live")}
              >
                {m.nav.live}
              </button>
              <button
                type="button"
                className={cx(view === "dashboard" && "active")}
                aria-pressed={view === "dashboard"}
                onClick={() => setView("dashboard")}
              >
                {m.nav.dashboard}
              </button>
              <button
                type="button"
                className={cx("todo-tab", todo > 0 && "urgent")}
                onClick={() => {
                  setView("live");
                  window.setTimeout(
                    () =>
                      document
                        .getElementById("agent-office-approval")
                        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
                    60
                  );
                }}
              >
                {m.nav.todo} <i>{todo}</i>
              </button>
            </div>
          </nav>

          <div className={cx("shell-notice")} role="note" data-testid="agent-office-shell-notice">
            <span className={cx("mini-badge demo")}>{m.shell.chip}</span>
            <p>{m.shell.notice}</p>
          </div>

          {view === "live" ? (
            <LiveView
              m={m}
              engine={engine}
              snap={snap}
              follow={follow}
              setFollow={setFollow}
              selectedId={selectedId}
              onSelect={onSelect}
              onStart={start}
              onApprove={approve}
              onDuty={onDuty}
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
              onStart={start}
              onApprove={approve}
              onSelect={(id) => setSelectedId(id)}
            />
          )}

          <footer className={cx("credit")}>
            {m.credit.line}
            <br />
            <a href="https://www.instagram.com/godseng.mom/" target="_blank" rel="noreferrer">
              {m.credit.link}
            </a>
            <br />
            {m.credit.terms}
          </footer>
        </div>
      </div>

      {selected ? (
        <ProfileModal
          m={m}
          engine={engine}
          agent={selected}
          onClose={() => setSelectedId(null)}
          onAsk={(agent) => {
            setView("live");
            askAgent(agent);
          }}
        />
      ) : null}
      {briefing ? (
        <BriefingModal m={m} narrator={engine.deptLead.digest} snap={snap} onClose={() => setBriefing(false)} />
      ) : null}
      <div className={cx("toast", toast && "show")} role="status">
        {toast}
      </div>
    </div>
  );
}

function LiveView({
  m,
  engine,
  snap,
  follow,
  setFollow,
  selectedId,
  onSelect,
  onStart,
  onApprove,
  onDuty,
}: {
  m: OfficeCopy;
  engine: AgentOffice;
  snap: Snapshot;
  follow: boolean;
  setFollow: (value: boolean) => void;
  selectedId: string | null;
  onSelect: (agent: Agent) => void;
  onStart: () => void;
  onApprove: () => void;
  onDuty: number;
}) {
  const progress = Math.round((snap.phaseIndex / (PHASE_COUNT - 1)) * 100);
  const waitingNames = ["engineering", "qa", "digest"]
    .map((dept) => engine.deptLead[dept]?.name)
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <header className={cx("live-hero")}>
        <div>
          <p className={cx("eyebrow")}>{m.live.eyebrow(engine.staff.length)}</p>
          <h2 className={cx("office-title")}>
            {m.company.titlePrefix} <em className={cx("highlight")}>{m.company.titleAccent}</em>
          </h2>
          <p>{m.live.lead}</p>
        </div>
        <div className={cx("live-clock")}>
          <span>{m.live.clockLabel}</span>
          <b data-testid="agent-office-clock">{snap.clock}</b>
          <small>{snap.phase}</small>
        </div>
      </header>

      <section className={cx("live-bar")}>
        <button type="button" className={cx("btn btn-primary")} onClick={onStart} disabled={snap.running}>
          {snap.running ? m.live.running : snap.dayComplete ? m.live.restart : m.live.start}
        </button>
        <button type="button" className={cx("btn btn-ghost")} onClick={() => engine.togglePause()}>
          {snap.paused ? m.live.play : m.live.pause}
        </button>
        <div className={cx("speed-wrap")}>
          <span className={cx("speed-label")} title={m.live.speedHint}>
            {m.live.speedLabel}
          </span>
          <div className={cx("speed-group")} role="group" aria-label={m.live.speedLabel}>
            {[1, 2, 4].map((value) => (
              <button
                type="button"
                key={value}
                className={cx(!snap.turbo && snap.speed === value && "on")}
                aria-pressed={!snap.turbo && snap.speed === value}
                onClick={() => engine.setSpeed(value)}
                title={value === 1 ? m.live.speedSlow : value === 4 ? m.live.speedFast : m.live.speedNormal}
              >
                {value}x
              </button>
            ))}
            <button
              type="button"
              className={cx("skip", snap.turbo && "on")}
              onClick={() => engine.skipToDecision()}
              disabled={!snap.running || snap.approvalPending}
              title={m.live.skipHint}
            >
              {snap.turbo ? m.live.skipping : m.live.skip}
            </button>
          </div>
        </div>
        <button
          type="button"
          className={cx("btn btn-ghost", follow && "on")}
          aria-pressed={follow}
          onClick={() => setFollow(!follow)}
        >
          {m.live.follow(follow)}
        </button>
        <button type="button" className={cx("btn btn-ghost")} disabled title={m.live.publishHint}>
          {m.live.publish}
        </button>
        <div className={cx("live-progress")}>
          <span>{m.live.progress(snap.phase, progress)}</span>
          <i>
            <b style={{ width: `${progress}%` }} />
          </i>
        </div>
        <div className={cx("live-counts")}>
          <span className={cx("lc on-duty")}>{m.live.onDuty(onDuty)}</span>
          <span className={cx("lc done")}>{m.live.done(snap.stats.done)}</span>
          <span className={cx("lc working")}>{m.live.working(snap.stats.working)}</span>
          <span className={cx("lc blocked")}>{m.live.blocked(snap.stats.blocked)}</span>
        </div>
      </section>

      <section className={cx("live-grid")}>
        <AgentOfficeWorld engine={engine} snap={snap} selectedId={selectedId} follow={follow} onSelect={onSelect} />

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

          <section className={cx("win rail-card feed-card")}>
            <div className={cx("win-bar")}>
              <span>{m.feed.windowTitle}</span>
              <span className={cx("window-controls")} aria-hidden="true">
                —　▢　✕
              </span>
            </div>
            <div className={cx("win-body feed-body")}>
              {snap.meetingTitle ? <div className={cx("feed-now")}>{m.feed.meetingNow(snap.meetingTitle)}</div> : null}
              <ul className={cx("feed-list")}>
                {snap.log.map((entry) => (
                  <li key={entry.id} className={cx(entry.tone)}>
                    <b>{entry.time}</b>
                    <i aria-hidden="true">{entry.icon}</i>
                    <span>{entry.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className={cx("win rail-card")}>
            <div className={cx("win-bar")}>
              <span>{m.roster.windowTitle}</span>
              <span className={cx("window-controls")} aria-hidden="true">
                —　▢　✕
              </span>
            </div>
            <div className={cx("win-body roster-body")}>
              {DEPT_ROOMS.map((room) => {
                const status = snap.deptStatus[room.id] ?? "waiting";
                return (
                  <div className={cx("roster-dept")} key={room.id}>
                    <p>
                      <b>
                        {room.icon} {engine.roomName(room.id)}
                      </b>
                      <i className={cx("rm-dot", status)} title={m.deptStatus[status]} />
                    </p>
                    <div className={cx("roster-chips")}>
                      {engine.staff
                        .filter((seed) => seed.deptId === room.id)
                        .map((seed) => {
                          const agent = engine.agentById.get(seed.id);
                          return (
                            <button
                              type="button"
                              key={seed.id}
                              className={cx("roster-chip", selectedId === seed.id && "on")}
                              onClick={() => agent && onSelect(agent)}
                            >
                              <i style={{ background: seed.shirt, borderColor: seed.hair }} />
                              {seed.name}
                              <small>{m.agentStatus[agent?.status ?? "offDuty"]}</small>
                            </button>
                          );
                        })}
                    </div>
                  </div>
                );
              })}
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
        <div className={cx("console-status")}>
          <span className={cx("mini-badge", snap.focusMode ? "yellow" : "mint")}>
            {snap.focusMode ? m.console.focusOn : m.console.normal}
          </span>
          {snap.busyWithOrder ? <span className={cx("mini-badge lav")}>{m.console.busy}</span> : null}
        </div>

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

/** Closes on Escape, as every console dialog does. */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
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
  useEscape(onClose);
  const dept = agentOfficeDept(agent.deptId);
  return (
    <div className={cx("modal-backdrop")} onClick={onClose}>
      <section
        className={cx("win team-modal")}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={m.profile.dialogLabel(agent.name)}
        data-testid="agent-office-profile"
      >
        <div className={cx("win-bar")}>
          <span>{m.profile.windowTitle}</span>
          <button type="button" className={cx("window-close")} onClick={onClose} aria-label={m.profile.closeIcon} autoFocus>
            ✕
          </button>
        </div>
        <div className={cx("win-body employee-profile")}>
          <div className={cx("profile-top")}>
            <PixelEmployee hair={agent.hair} shirt={agent.shirt} accent={agent.accent} />
            <div>
              <span className={cx("status-pill working")}>{m.agentStatus[agent.status]}</span>
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
            <strong>{agent.speech ?? agent.thoughts[0]}</strong>
          </div>
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
  onClose,
}: {
  m: OfficeCopy;
  narrator: StaffSeed | undefined;
  snap: Snapshot;
  onClose: () => void;
}) {
  useEscape(onClose);
  return (
    <div className={cx("modal-backdrop")} onClick={onClose}>
      <section
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
            <li>
              <span className={cx("dot green")} />
              {m.briefing.approved}
            </li>
            <li>
              <span className={cx("dot gray")} />
              {m.briefing.blocked(snap.stats.blocked)}
            </li>
          </ul>
          <div className={cx("decision-box")}>
            <span className={cx("tiny-label")}>{m.briefing.decisionLabel}</span>
            <strong>{m.briefing.decisionNone}</strong>
          </div>
          <button type="button" className={cx("btn btn-primary")} onClick={onClose} autoFocus>
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
};

function DashboardView({
  m,
  engine,
  teams,
  filteredTeams,
  filter,
  setFilter,
  snap,
  onStart,
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
  onStart: () => void;
  onApprove: () => void;
  onSelect: (id: string) => void;
}) {
  const filterLabel = (value: Filter) => (value === "all" ? m.dashboard.filterAll : m.deptStatus[value]);

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
            <p className={cx("eyebrow")}>{m.dashboard.eyebrow}</p>
            <h2 className={cx("office-title")}>
              {m.dashboard.titleBefore}
              <em className={cx("highlight")}>{m.dashboard.titleAccent}</em>
            </h2>
            <p>{m.dashboard.lead(AGENT_OFFICE_TEAM_IDS.length, engine.staff.length)}</p>
          </div>
          <div className={cx("hero-actions")}>
            <button type="button" className={cx("btn btn-primary")} onClick={onStart} disabled={snap.running}>
              {snap.running ? m.dashboard.running : m.dashboard.start}
            </button>
            <span className={cx("trust-copy")}>{m.dashboard.trust}</span>
          </div>
        </div>
      </header>

      <section className={cx("summary-grid")}>
        <article className={cx("metric yellow")}>
          <span>{m.dashboard.metricStaff}</span>
          <strong>{engine.staff.length}</strong>
          <small>STAFF</small>
        </article>
        <article className={cx("metric mint")}>
          <span>{m.dashboard.metricDone}</span>
          <strong>{snap.stats.done}</strong>
          <small>DONE</small>
        </article>
        <article className={cx("metric pink")}>
          <span>{m.dashboard.metricWorking}</span>
          <strong>{snap.stats.working}</strong>
          <small>WORKING</small>
        </article>
        <article className={cx("metric lav")}>
          <span>{m.dashboard.metricApproval}</span>
          <strong>{snap.stats.approval}</strong>
          <small>APPROVAL</small>
        </article>
        <article className={cx("metric white")}>
          <span>{m.dashboard.metricBlocked}</span>
          <strong>{snap.stats.blocked}</strong>
          <small>WAITING</small>
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
                  return (
                    <div className={cx("flow-row", snap.phaseIndex > phase && "past")} key={item}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <b>{item}</b>
                      <i aria-hidden="true">{snap.phaseIndex === phase ? "●" : snap.phaseIndex > phase ? "✓" : "·"}</i>
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
                <span className={cx("mini-badge lav")}>{m.dashboard.liveLinkStatus}</span>
              </div>
              {AGENT_OFFICE_DEPTS.map((dept) =>
                dept.recordHref ? (
                  <Link key={dept.id} href={dept.recordHref} className={cx("integration-row")}>
                    <b>
                      {dept.icon} {engine.roomName(dept.id)}
                    </b>
                    <span className={cx("mini-badge mint")}>{m.dashboard.recordOpen}</span>
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
                      </b>
                      <small>{team.task}</small>
                    </span>
                    <span className={cx("status-pill", team.status)}>{m.deptStatus[team.status]}</span>
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
                    {snap.approvalPending ? m.dashboard.briefApprovalNeeded : m.dashboard.briefNoApproval}
                  </li>
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
