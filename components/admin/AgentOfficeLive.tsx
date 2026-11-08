"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import AgentOfficeBriefing from "@/components/admin/AgentOfficeBriefing";
import AgentOfficeCliMonitor from "@/components/admin/AgentOfficeCliMonitor";
import AgentOfficeFloor, {
  CHANNEL_COLOR,
  ChannelIcon,
  PixelSprite,
  cn,
  type Clothes,
  type FloorSeated,
  type FloorTeam,
  type FloorWorker,
} from "@/components/admin/AgentOfficeFloor";
import s from "@/components/admin/agentOfficeFloor.module.css";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAgentOfficeFloorMessages, type AgentOfficeFloorCopy } from "@/lib/adminMessages/agentOfficeFloor";
import type { AdminMessageShape } from "@/lib/adminLocale";

type FloorCopy = AdminMessageShape<AgentOfficeFloorCopy>;
import { isAgentOfficeCliWorker, type AgentOfficeCliWorker } from "@/lib/agentOfficeCliMonitorCore";
import {
  AGENT_OFFICE_CHANNELS,
  agentOfficeChannel,
  agentOfficeFloorLayout,
  brisbaneHour,
  floorLightAt,
  workerNeedsLook,
  workerPlace,
  type AgentOfficeChannel,
  type FloorLight,
} from "@/lib/agentOffice/floor";
import {
  AGENT_OFFICE_QUOTA_FRESH_MS,
  agentOfficeChannelQuota,
  agentOfficeInbox,
  agentOfficeQuotaReading,
  inboxTotal,
  type AgentOfficeInboxItem,
  type AgentOfficeQuotaReading,
} from "@/lib/agentOffice/inbox";
import { busyAt, replayMoment, replayState, replaySteps } from "@/lib/agentOffice/replay";
import type {
  AgentOfficeAmuxPulse,
  AgentOfficeAmuxWorkerState,
  AgentOfficeDecisionView,
  AgentOfficeLiveDept,
  AgentOfficeLiveRooms,
  AgentOfficeReviewView,
  AgentOfficeWorkerDetail,
} from "@/lib/agentOffice/live";
import { AGENT_OFFICE_DEPT_IDS, agentOfficeDept, agentOfficeSeatedClothes } from "@/lib/agentOffice/roster";
import type { AgentOffice, DeptStatus, OfficeCopy } from "@/lib/agentOffice/sim";
import { aestClock, aestSince, aestStamp, brisbaneIso } from "@/lib/agentOffice/time";

const WORKERS_HREF = "/admin/amux-settings?tab=workers";
const SAFETY_HREF = "/admin/amux-recovery?tab=safety";
const CARDS_HREF = "/admin/amux-execution?tab=cards";
/** A floor worker with what the office may say about its quota. */
type LiveWorker = FloorWorker & { quota: AgentOfficeQuotaReading };
const QUOTA_FRESH_MINUTES = AGENT_OFFICE_QUOTA_FRESH_MS / 60_000;

const RUNNING: readonly AgentOfficeAmuxWorkerState[] = ["ready", "idle", "busy", "starting", "error", "lost", "paused", "isolated", "blocked"];
const SOUND_KEY = "tomverse.agentOffice.sound";
/** The AMUX room is re-read this often while the tab is visible; the rest of the office every minute. */
const AMUX_PULSE_MS = 15_000;
const PLAY_STEP_MS = 350;

type LightPreview = "now" | FloorLight;

const SOUND_EVENT = "tomverse-agent-office-sound";
let soundFallback = false;
function readSound(): boolean {
  try {
    return window.localStorage.getItem(SOUND_KEY) === "1";
  } catch {
    return soundFallback;
  }
}
function writeSound(on: boolean) {
  soundFallback = on;
  try {
    window.localStorage.setItem(SOUND_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked: this visit only */
  }
  window.dispatchEvent(new Event(SOUND_EVENT));
}
function subscribeSound(onChange: () => void) {
  window.addEventListener(SOUND_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(SOUND_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * The live office (version 2): what waits on the operator, where every AMUX
 * worker is and what it holds, the team rooms, and today's merges. It shows
 * records and links the screens where they are acted on; nothing here writes.
 */
export default function AgentOfficeLive({
  m,
  engine,
  live: served,
  liveDepts,
  reviewView,
  decisionView,
  cliMonitorEnabled,
  stale,
  onSelectTeam,
  onSelectSeated,
  onCopyReport,
  onDownloadReport,
}: {
  m: OfficeCopy;
  engine: AgentOffice;
  live: AgentOfficeLiveRooms;
  liveDepts: Record<string, AgentOfficeLiveDept>;
  reviewView: AgentOfficeReviewView;
  decisionView: AgentOfficeDecisionView;
  cliMonitorEnabled: boolean;
  stale: boolean;
  onSelectTeam: (id: string) => void;
  onSelectSeated: (room: "review" | "decision", name: string) => void;
  onCopyReport: () => void;
  onDownloadReport: () => void;
}) {
  const f = useAdminMessages(adminAgentOfficeFloorMessages);
  const [view, setView] = useState<"floor" | "roster">("floor");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [lightPreview, setLightPreview] = useState<LightPreview>("now");
  const [hour, setHour] = useState(() => brisbaneHour(Date.parse(served.readAt)));
  const [selected, setSelected] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(-1);
  const [cliWorker, setCliWorker] = useState<AgentOfficeCliWorker | null>(null);
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const [celebrate, setCelebrate] = useState(0);
  // The operator's own sound choice, kept in this browser only (off unless turned on).
  const sound = useSyncExternalStore(subscribeSound, readSound, () => false);
  const toastTimer = useRef<number | undefined>(undefined);
  const [pulse, setPulse] = useState<AgentOfficeAmuxPulse | null>(null);
  // null is now; a number is a five-minute step since Brisbane midnight.
  const [rewind, setRewind] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  // The AMUX room every fifteen seconds while the tab is visible. A failed
  // read keeps the last one; the page's own minute refresh still runs.
  useEffect(() => {
    let stopped = false;
    let reading = false;
    const read = async () => {
      if (reading || document.visibilityState !== "visible") return;
      reading = true;
      try {
        const res = await adminFetch("/api/admin/office/amux", { cache: "no-store", credentials: "same-origin" });
        const body = res.ok ? ((await res.json()) as AgentOfficeAmuxPulse) : null;
        if (!stopped && body && typeof body.readAt === "string" && body.amux && body.history) setPulse(body);
      } catch {
        /* keep the last reading */
      } finally {
        reading = false;
      }
    };
    const id = window.setInterval(read, AMUX_PULSE_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, []);
  const live = useMemo<AgentOfficeLiveRooms>(
    () => (pulse && Date.parse(pulse.readAt) > Date.parse(served.readAt) ? { ...served, ...pulse } : served),
    [pulse, served]
  );

  useEffect(() => {
    const tick = () => setHour(brisbaneHour());
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const showToast = useCallback((text: string, bad = false) => {
    setToast({ text, bad });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3_200);
  }, []);
  const audio = useRef<AudioContext | null>(null);
  const chime = useCallback(() => {
    if (!sound) return;
    try {
      audio.current ??= new AudioContext();
      const ctx = audio.current;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
      g.gain.value = 0.08;
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.4);
    } catch {
      /* no audio: silent */
    }
  }, [sound]);

  const now = Date.parse(live.readAt);
  const detail = live.amuxDetail.kind === "observed" ? live.amuxDetail.workers : null;
  const ownerDetail = live.amuxDetail.kind === "observed" && live.amuxDetail.ownerDetail;
  const amuxWorkers = useMemo(() => (live.amux.kind === "observed" ? live.amux.workers : []), [live.amux]);
  const heartbeats = useMemo(() => new Map(amuxWorkers.map((w) => [w.name, w.heartbeatAt])), [amuxWorkers]);
  const history = live.history;
  const steps = history.kind === "observed" ? replaySteps(history.since, now) : 0;
  const replayAt = rewind !== null && history.kind === "observed" ? replayMoment(history.since, now, rewind) : null;
  const busyThen = useMemo(
    () => (replayAt !== null && history.kind === "observed" ? busyAt(history.spans, replayAt) : null),
    [history, replayAt]
  );

  // Playing moves one step at a time and stops at now.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setRewind((r) => {
        const next = (r ?? 0) + 1;
        if (next >= steps) {
          setPlaying(false);
          return null;
        }
        return next;
      });
    }, PLAY_STEP_MS);
    return () => window.clearInterval(id);
  }, [playing, steps]);

  // Only a fresh reading is drawn as a live bar or rests a worker in a pod.
  const workers: LiveWorker[] = useMemo(
    () =>
      amuxWorkers.map((w, i) => {
        const d = detail?.[w.name];
        const quota = agentOfficeQuotaReading(d?.quota, now);
        const exhausted = quota.kind === "fresh" && quota.exhausted;
        return {
          name: w.name,
          channel: agentOfficeChannel(w.provider),
          state: w.state,
          label: m.real.amux.states[w.state],
          quota,
          quotaExhausted: exhausted,
          quotaPercent: quota.kind === "fresh" ? quota.percent : null,
          cardKey: d?.work?.cardKey ?? null,
          needsLook: workerNeedsLook(w.state, exhausted),
          clothes: agentOfficeSeatedClothes("amux", i),
        };
      }),
    [amuxWorkers, detail, now, m]
  );
  // Only the floor is rewound; the summary, inbox, roster and sheet stay now.
  // A rewound floor knows attempts only: no quota place and no card then.
  const floorWorkers: FloorWorker[] = useMemo(
    () =>
      busyThen === null
        ? workers
        : workers.map((w) => {
            const state = replayState(w.state, busyThen.has(w.name));
            return {
              ...w,
              state,
              label: m.real.amux.states[state],
              quotaExhausted: false,
              quotaPercent: null,
              cardKey: null,
              needsLook: workerNeedsLook(state, false),
            };
          }),
    [workers, busyThen, m]
  );
  const layout = useMemo(
    () => (live.amux.kind === "observed" ? agentOfficeFloorLayout(floorWorkers) : null),
    [live.amux.kind, floorWorkers]
  );

  const teams: FloorTeam[] = useMemo(
    () =>
      AGENT_OFFICE_DEPT_IDS.map((id) => ({
        id,
        name: engine.roomName(id),
        icon: agentOfficeDept(id)?.icon ?? "",
        status: engine.deptStatus[id] ?? "waiting",
        line: liveDepts[id]?.line ?? null,
        people: engine.deptStaff(id).map((p) => ({
          id: p.id,
          lead: p.rank === "lead",
          clothes: { hair: p.hair, shirt: p.shirt, accent: p.accent, skin: p.skin },
        })),
      })),
    // engine.deptStatus follows liveDepts (engine.setLive in the panel).
    [engine, liveDepts]
  );
  const reviewers: FloorSeated[] = reviewView.reviewers.map((r, i) => ({ ...r, clothes: agentOfficeSeatedClothes("review", i) }));
  const decision: FloorSeated[] = decisionView.members.map((d, i) => ({ ...d, clothes: agentOfficeSeatedClothes("decision", i) }));

  const items = useMemo(
    () => agentOfficeInbox({ queue: live.queue, inbox: live.inbox, amux: live.amux, amuxDetail: live.amuxDetail, now }),
    [live, now]
  );
  const total = inboxTotal(items);
  const alarm = (live.queue.amuxHalts ?? 0) > 0;

  // What changed since the last reading: merges celebrate, a halt or a worker
  // gone wrong sounds (when the operator turned sound on). The first reading
  // is not a change.
  const previous = useRef<{ merges: Set<number>; halts: number | null; down: Set<string> } | null>(null);
  useEffect(() => {
    const merges = new Set(live.merges.kind === "observed" ? live.merges.items.map((x) => x.pr) : []);
    const down = new Set(amuxWorkers.filter((w) => w.state === "error" || w.state === "lost").map((w) => w.name));
    const prev = previous.current;
    previous.current = { merges, halts: live.queue.amuxHalts, down };
    if (!prev) return;
    const fresh = [...merges].filter((pr) => !prev.merges.has(pr));
    if (fresh.length) {
      setCelebrate((n) => n + 1);
      showToast(f.toast.merged(fresh[0]));
    }
    if (prev.halts !== null && live.queue.amuxHalts !== null) {
      if (prev.halts === 0 && live.queue.amuxHalts > 0) {
        showToast(f.toast.halted, true);
        chime();
      } else if (prev.halts > 0 && live.queue.amuxHalts === 0) {
        showToast(f.toast.haltCleared);
      }
    }
    const newlyDown = [...down].filter((name) => !prev.down.has(name));
    if (newlyDown.length) {
      showToast(f.toast.down(newlyDown[0]), true);
      chime();
    }
  }, [live, amuxWorkers, f, showToast, chime]);

  const light: FloorLight = lightPreview === "now" ? floorLightAt(replayAt === null ? hour : brisbaneHour(replayAt)) : lightPreview;
  const lightIcon = { day: "☀️", dawn: "🌅", dusk: "🌇", night: "🌙" }[light];
  const clockText = lightPreview === "now" ? aestClock(new Date().toISOString()) : { day: "11:00", dawn: "06:00", dusk: "18:00", night: "21:30" }[light];

  const [focusIsland, setFocusIsland] = useState<{ ch: AgentOfficeChannel; n: number } | null>(null);
  const openWorker = useCallback((name: string) => {
    setSelected(name);
    setCliWorker(null);
    if (window.matchMedia("(max-width: 1180px)").matches) {
      document.getElementById("agent-office-rail")?.scrollIntoView({ block: "start" });
    }
  }, []);
  const actOn = (item: AgentOfficeInboxItem) => {
    if (item.worker) openWorker(item.worker);
    else if (item.channel) {
      setView("floor");
      setFocusIsland((x) => ({ ch: item.channel!, n: (x?.n ?? 0) + 1 }));
    }
  };

  // N moves through what is waiting, most urgent first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input,textarea,select,[contenteditable=true]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" || e.key === "N") {
        if (!items.length) return;
        setSelected(null);
        setCliWorker(null);
        setFocusIdx((i) => (i + 1) % items.length);
      } else if (e.key === "Escape") {
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length]);
  useEffect(() => {
    if (focusIdx < 0) return;
    document.querySelector<HTMLElement>(`[data-inbox-index="${focusIdx}"]`)?.focus();
  }, [focusIdx]);

  const selectedWorker = selected ? amuxWorkers.find((w) => w.name === selected) ?? null : null;
  const selectedIndex = selected ? amuxWorkers.findIndex((w) => w.name === selected) : -1;

  return (
    <div className={s.root} data-testid="agent-office-live">
      <Kpis f={f} items={items} workers={workers} amuxRead={live.amux.kind === "observed"} detail={detail} ownerDetail={ownerDetail} now={now} />

      <div className={s.controls}>
        <span className={s.seg} role="group" aria-label={f.controls.view}>
          <button type="button" aria-pressed={view === "floor"} onClick={() => setView("floor")}>{f.controls.floor}</button>
          <button type="button" aria-pressed={view === "roster"} onClick={() => setView("roster")} data-testid="agent-office-roster-tab">{f.controls.roster}</button>
        </span>
        <button type="button" className={s.toggle} aria-pressed={problemsOnly} onClick={() => setProblemsOnly((v) => !v)} data-testid="agent-office-problems">
          <span className={s.sw} />
          {f.controls.problems}
        </button>
        <span className={s.clock} title={f.controls.clock} data-testid="agent-office-clock">
          <span aria-hidden="true">{lightIcon}</span>
          <b className={s.num}>{clockText.replace(" AEST", "")}</b>AEST
        </span>
        <span className={s.seg} role="group" aria-label={f.controls.light}>
          {(["now", "day", "dusk", "night"] as const).map((key) => (
            <button key={key} type="button" aria-pressed={lightPreview === key} onClick={() => setLightPreview(key)}>
              {{ now: f.controls.lightNow, day: f.controls.lightDay, dusk: f.controls.lightDusk, night: f.controls.lightNight }[key]}
            </button>
          ))}
        </span>
        {stale ? <span className={s.stale} role="status" data-testid="agent-office-stale">{m.live.stale}</span> : <span className={s.faint}>{aestStamp(live.readAt)}</span>}
        {replayAt !== null ? (
          <span className={s.rewinding} role="status" data-testid="agent-office-rewinding">
            ⏪ {f.today.at(clockOf(replayAt))}
          </span>
        ) : null}
        <span className={s.spacer} />
        <button type="button" className={s.toggle} onClick={onCopyReport} title={m.live.reportHint} data-testid="agent-office-report-copy">{m.live.reportCopy}</button>
        <button type="button" className={s.toggle} onClick={onDownloadReport} title={m.live.reportHint} data-testid="agent-office-report-download">{m.live.reportDownload}</button>
        <button
          type="button"
          className={s.toggle}
          aria-pressed={sound}
          onClick={() => {
            writeSound(!sound);
          }}
        >
          <span className={s.sw} />
          {f.controls.sound}
        </button>
      </div>

      <div className={s.body}>
        <div style={{ minWidth: 0 }}>
          <div className={s.islList}>
            {AGENT_OFFICE_CHANNELS.map((ch) => {
              const list = workers.filter((w) => w.channel === ch);
              const busy = list.filter((w) => w.state === "busy").length;
              const zz = list.filter((w) => w.quotaExhausted && workerPlace(w.state, true) === "pod").length;
              const bad = list.filter((w) => w.state === "error" || w.state === "lost").length;
              const rest = list.filter((w) => workerPlace(w.state, w.quotaExhausted) === "lounge").length;
              return (
                <button key={ch} type="button" className={s.islCard} onClick={() => { setView("floor"); setFocusIsland((x) => ({ ch, n: (x?.n ?? 0) + 1 })); }}>
                  <span className={s.row}><ChannelIcon channel={ch} size={18} /><b>{f.channels[ch]}</b><span className={s.faint}>{f.island.workers(list.length)}</span></span>
                  <span className={s.cnts}>
                    <span className={cn(s.chip, s.chip_working)}>{m.real.amux.states.busy} {busy}</span>
                    <span className={cn(s.chip, s.chip_waiting)}>☕ {rest}</span>
                    {zz ? <span className={cn(s.chip, s.chip_warn)}>zZ {zz}</span> : null}
                    {bad ? <span className={cn(s.chip, s.chip_attention)}>! {bad}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
          {view === "floor" ? (
            <>
              <FloorWithFocus
                focusIsland={focusIsland}
                floor={
                  <AgentOfficeFloor
                    copy={f}
                    workers={floorWorkers}
                    layout={layout}
                    teams={teams}
                    reviewers={reviewers}
                    decision={decision}
                    reviewStatus={reviewView.status}
                    decisionStatus={decisionView.status}
                    operator={{
                      name: engine.operatorSeed.name,
                      clothes: { hair: engine.operatorSeed.hair, shirt: engine.operatorSeed.shirt, accent: engine.operatorSeed.accent, skin: engine.operatorSeed.skin },
                    }}
                    selected={selected}
                    problemsOnly={problemsOnly}
                    light={light}
                    alarm={alarm}
                    celebrate={celebrate}
                    toast={toast}
                    onSelectWorker={openWorker}
                    onSelectTeam={onSelectTeam}
                    onSelectSeated={onSelectSeated}
                    onOverflow={() => setView("roster")}
                  />
                }
              />
              <div className={s.legend}>
                <span>● {f.legend.desk}</span><span>{f.legend.lounge}</span><span>{f.legend.pod}</span><span>{f.legend.problem}</span><span>🪑 {f.legend.bench}</span>
              </div>
            </>
          ) : (
            <Roster f={f} heartbeats={heartbeats} workers={workers} detail={detail} ownerDetail={ownerDetail} now={now} problemsOnly={problemsOnly} onOpen={openWorker} />
          )}
        </div>

        <aside className={s.rail} id="agent-office-rail" aria-label={f.inbox.title}>
          {cliWorker && cliMonitorEnabled ? (
            <div className={s.cliZone}>
              <AgentOfficeCliMonitor
                key={cliWorker}
                worker={cliWorker}
                avatar={selectedIndex >= 0 ? <PixelSprite c={agentOfficeSeatedClothes("amux", selectedIndex)} /> : undefined}
                onClose={() => setCliWorker(null)}
              />
            </div>
          ) : selectedWorker ? (
            <WorkerSheet
              f={f}
              m={m}
              name={selectedWorker.name}
              state={selectedWorker.state}
              heartbeatAt={selectedWorker.heartbeatAt}
              channel={agentOfficeChannel(selectedWorker.provider)}
              clothes={agentOfficeSeatedClothes("amux", selectedIndex)}
              detail={detail?.[selectedWorker.name] ?? null}
              ownerDetail={ownerDetail}
              now={now}
              onBack={() => setSelected(null)}
              onTerminal={
                cliMonitorEnabled && isAgentOfficeCliWorker(selectedWorker.name)
                  ? () => setCliWorker(selectedWorker.name as AgentOfficeCliWorker)
                  : undefined
              }
            />
          ) : (
            <>
              <AgentOfficeBriefing f={f} />
              <Inbox f={f} items={items} total={total} focusIdx={focusIdx} problemsOnly={problemsOnly} workers={workers} onAct={actOn} />
            </>
          )}
        </aside>
      </div>

      <TodayStrip
        f={f}
        live={live}
        hour={hour}
        steps={steps}
        rewind={rewind}
        replayAt={replayAt}
        playing={playing}
        onRewind={(step) => {
          setPlaying(false);
          setRewind(step >= steps ? null : step);
        }}
        onPlay={() => {
          if (playing) setPlaying(false);
          else {
            if (rewind === null) setRewind(0);
            setPlaying(true);
          }
        }}
      />
    </div>
  );
}

/** Zooms the floor to an island when the parent asks (an island card or a quota item). */
function FloorWithFocus({ floor, focusIsland }: { floor: ReactNode; focusIsland: { ch: AgentOfficeChannel; n: number } | null }) {
  useEffect(() => {
    if (!focusIsland) return;
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="agent-office-island-${focusIsland.ch}"]`);
    button?.click();
    document.querySelector('[data-testid="agent-office-floor"]')?.scrollIntoView({ block: "center" });
  }, [focusIsland]);
  return <>{floor}</>;
}

function stateTone(state: AgentOfficeAmuxWorkerState, exhausted: boolean): string {
  if (state === "error" || state === "lost") return s.chip_attention;
  if (state === "busy") return s.chip_working;
  if (exhausted && workerPlace(state, true) === "pod") return s.chip_warn;
  if (state === "ready") return s.chip_done;
  return s.chip_waiting;
}

const usd = (micro: number) => `US$ ${(micro / 1_000_000).toFixed(2)}`;
const tokensText = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n));
function ago(iso: string | null, now: number, f: FloorCopy): { text: string; seconds: number } | null {
  if (!iso) return null;
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return { text: sec < 120 ? f.sheet.seconds(sec) : sec < 7200 ? f.sheet.minutesShort(Math.round(sec / 60)) : f.sheet.hours(Math.round(sec / 3600)), seconds: sec };
}

function Kpis({
  f,
  items,
  workers,
  amuxRead,
  detail,
  ownerDetail,
  now,
}: {
  f: FloorCopy;
  items: AgentOfficeInboxItem[];
  workers: LiveWorker[];
  amuxRead: boolean;
  detail: Record<string, AgentOfficeWorkerDetail> | null;
  ownerDetail: boolean;
  now: number;
}) {
  const total = inboxTotal(items);
  const sev = { bad: 0, warn: 0, info: 0 };
  for (const i of items) if (i.severity !== "unread") sev[i.severity]++;
  const sevMax = Math.max(1, sev.bad + sev.warn + sev.info);
  const running = workers.filter((w) => RUNNING.includes(w.state));
  const busy = workers.filter((w) => w.state === "busy").length;
  const parts = [
    { n: busy, c: "var(--ac)" },
    { n: running.filter((w) => workerPlace(w.state, w.quotaExhausted) === "lounge").length, c: "var(--ok)" },
    { n: running.filter((w) => w.quotaExhausted && workerPlace(w.state, true) === "pod").length, c: "var(--wa)" },
    { n: running.filter((w) => w.state === "error" || w.state === "lost").length, c: "var(--ba)" },
  ];
  const costByChannel = AGENT_OFFICE_CHANNELS.map((ch) => ({
    ch,
    micro: workers.filter((w) => w.channel === ch).reduce((sum, w) => sum + (detail?.[w.name]?.usage?.apiCostMicrousd ?? 0), 0),
  }));
  const costTotal = costByChannel.reduce((a, b) => a + b.micro, 0);
  const costMax = Math.max(1, ...costByChannel.map((x) => x.micro));
  const channelQuota = AGENT_OFFICE_CHANNELS.map((ch) => ({
    ch,
    q: agentOfficeChannelQuota(workers.filter((w) => w.channel === ch).map((w) => w.quota)),
  }));
  return (
    <section className={s.kpis} aria-label={f.inbox.title}>
      <div className={cn(s.kpi, total.urgent > 0 && s.urgent)} data-testid="agent-office-kpi-waiting">
        <div className={s.grow}>
          <div className={s.kl}>{f.kpi.waiting}</div>
          <div className={cn(s.kv, s.num)}>{total.total}<small>{f.kpi.waitingUnit}{total.unknown ? ` ${f.kpi.unknown}` : ""}</small></div>
          <div className={s.ks}>{total.urgent ? f.kpi.urgent(total.urgent) : f.kpi.nothingUrgent}</div>
        </div>
        <svg className={s.hideM} width="78" height="34" viewBox="0 0 78 34" aria-hidden="true">
          {(["bad", "warn", "info"] as const).map((k, i) => {
            const h = 4 + (sev[k] / sevMax) * 28;
            return <rect key={k} x={i * 27} y={34 - h} width="22" height={h} rx="4" fill={{ bad: "#ef4444", warn: "#f59e0b", info: "#2563eb" }[k]} />;
          })}
        </svg>
      </div>
      <div className={s.kpi} data-testid="agent-office-kpi-working">
        <div className={s.grow}>
          <div className={s.kl}>{f.kpi.working}</div>
          {amuxRead ? (
            <>
              <div className={cn(s.kv, s.num)}>{busy}<small>{f.kpi.workingOf(running.length)}</small></div>
              <div className={s.ks}>{f.kpi.workingSub(workers.length - running.length)}</div>
            </>
          ) : (
            <div className={cn(s.kv, s.bad)} style={{ fontSize: 16 }}>{f.rooms.amuxUnread}</div>
          )}
        </div>
        {amuxRead && running.length ? (
          <svg className={s.hideM} width="92" height="14" viewBox="0 0 92 14" aria-hidden="true">
            {(() => {
              let x = 0;
              return parts.map((p, i) => {
                const w = (p.n / running.length) * 92;
                const el = <rect key={i} x={x} y={0} width={Math.max(0, w - 1)} height={14} rx={3} fill={p.c} />;
                x += w;
                return el;
              });
            })()}
          </svg>
        ) : null}
      </div>
      <div className={s.kpi} data-testid="agent-office-kpi-cost">
        <div className={s.grow}>
          <div className={s.kl}>{f.kpi.cost}</div>
          {detail === null ? (
            <div className={cn(s.kv, s.bad)} style={{ fontSize: 16 }}>{f.rooms.amuxUnread}</div>
          ) : ownerDetail ? (
            <>
              <div className={cn(s.kv, s.num)}>{usd(costTotal)}</div>
              <div className={s.ks}>{f.kpi.costSub}</div>
            </>
          ) : (
            <div className={s.ks} style={{ fontSize: 13 }}>{f.kpi.costOwner}</div>
          )}
        </div>
        {ownerDetail && detail ? (
          <svg className={s.hideM} width="78" height="34" viewBox="0 0 78 34" aria-hidden="true">
            {costByChannel.map((x, i) => {
              const h = 3 + (x.micro / costMax) * 30;
              return <rect key={x.ch} x={i * 20} y={34 - h} width="15" height={h} rx="3" fill={CHANNEL_COLOR[x.ch]} />;
            })}
          </svg>
        ) : null}
      </div>
      <div className={s.kpi} data-testid="agent-office-kpi-quota">
        <div className={s.qbars}>
          <div className={s.kl}>{f.kpi.quota}</div>
          {channelQuota.map(({ ch, q }) => (
            <div key={ch} className={s.qrow} data-quota={q.kind}>
              <span>{f.channels[ch]}</span>
              {q.kind === "fresh" ? (
                <>
                  <span className={s.qtrack}>
                    <span className={s.qfill} style={{ width: `${q.percent}%`, background: q.percent < 20 ? "var(--ba)" : q.percent < 40 ? "var(--wa)" : "var(--ok)" }} />
                  </span>
                  <b className={s.num}>{q.percent}%</b>
                </>
              ) : q.kind === "old" ? (
                <span className={s.qnote} title={f.kpi.quotaOldHint(QUOTA_FRESH_MINUTES)}>
                  <span className={s.num}>{q.percent}%</span> · {f.kpi.quotaAsOf(aestSince(q.observedAt, now))}
                </span>
              ) : q.kind === "missing" ? (
                <span className={s.qnote} title={f.kpi.quotaNotCollectedHint}>{f.kpi.quotaNotCollected}</span>
              ) : (
                <>
                  <span className={s.qtrack} />
                  <b className={s.num}>–</b>
                </>
              )}
            </div>
          ))}
          {channelQuota.some(({ q }) => q.kind === "missing") ? <div className={s.qhint}>{f.kpi.quotaNotCollectedHint}</div> : null}
        </div>
      </div>
    </section>
  );
}

function Inbox({
  f,
  items,
  total,
  focusIdx,
  problemsOnly,
  workers,
  onAct,
}: {
  f: FloorCopy;
  items: AgentOfficeInboxItem[];
  total: { total: number; unknown: boolean };
  focusIdx: number;
  problemsOnly: boolean;
  workers: FloorWorker[];
  onAct: (item: AgentOfficeInboxItem) => void;
}) {
  const shown = problemsOnly ? items.filter((i) => i.severity !== "info") : items;
  return (
    <section className={s.card} style={{ padding: 16 }} data-testid="agent-office-inbox">
      <div className={s.rh}>
        <h2>{f.inbox.title}</h2>
        <span className={s.badge}>{total.unknown ? `${total.total}+` : total.total}</span>
        <span className={s.kbdhint}><kbd>N</kbd> {f.inbox.next}</span>
      </div>
      {shown.length === 0 ? <p className={s.empty}>{f.inbox.empty}</p> : null}
      <div className={s.inbox}>
        {shown.map((item, idx) => {
          const worker = item.worker ? workers.find((w) => w.name === item.worker) : undefined;
          const title =
            item.severity === "unread"
              ? f.inbox.unreadTitle[item.kind] ?? item.kind
              : item.kind === "workerDown"
                ? f.inbox.kinds.workerDown(item.worker ?? "", worker?.label ?? "")
                : item.kind === "quota"
                  ? f.inbox.kinds.quota(item.channel ? f.channels[item.channel] : "", item.count ?? 0)
                  : f.inbox.kinds[item.kind](item.count ?? 0);
          const detailText = item.severity === "unread" ? f.inbox.unread : f.inbox.details[item.kind];
          const avatar = worker ? (
            <span className={s.ava} style={{ background: worker.channel ? `${CHANNEL_COLOR[worker.channel]}22` : undefined }}>
              <PixelSprite c={worker.clothes} u={1} />
            </span>
          ) : (
            <span className={s.ava} style={{ background: { bad: "var(--bas)", warn: "var(--was)", info: "var(--acs)", unread: "var(--grs)" }[item.severity] }} aria-hidden="true">
              {item.kind === "quota" && item.channel ? <ChannelIcon channel={item.channel} size={18} /> : { bad: "⚠️", warn: "💬", info: "📋", unread: "?" }[item.severity]}
            </span>
          );
          const body = (
            <>
              {avatar}
              <span className={s.grow}>
                <span className={s.itT}>{title}</span>
                <span className={s.itS}>{detailText}</span>
                <span className={s.itGo}>{item.worker ? f.inbox.viewWorker : item.kind === "quota" ? f.inbox.viewIsland : f.inbox.open} ›</span>
              </span>
            </>
          );
          const cls = cn(s.it, s[`sev_${item.severity}`], idx === focusIdx && s.focus);
          return item.href ? (
            <Link key={item.id} href={item.href} className={cls} data-inbox-index={idx} data-testid="agent-office-inbox-item" data-kind={item.kind}>
              {body}
            </Link>
          ) : (
            <button key={item.id} type="button" className={cls} onClick={() => onAct(item)} data-inbox-index={idx} data-testid="agent-office-inbox-item" data-kind={item.kind}>
              {body}
            </button>
          );
        })}
      </div>
      <p className={s.roNote}>ⓘ {f.inbox.readOnly}</p>
    </section>
  );
}

function WorkerSheet({
  f,
  m,
  name,
  state,
  heartbeatAt,
  channel,
  clothes,
  detail,
  ownerDetail,
  now,
  onBack,
  onTerminal,
}: {
  f: FloorCopy;
  m: OfficeCopy;
  name: string;
  state: AgentOfficeAmuxWorkerState;
  heartbeatAt: string | null;
  channel: AgentOfficeChannel | null;
  clothes: Clothes;
  detail: AgentOfficeWorkerDetail | null;
  ownerDetail: boolean;
  now: number;
  onBack: () => void;
  onTerminal?: () => void;
}) {
  const quota = agentOfficeQuotaReading(detail?.quota, now);
  const exhausted = quota.kind === "fresh" && quota.exhausted;
  const hb = ago(heartbeatAt, now, f);
  const late = hb !== null && hb.seconds > 120;
  const work = detail?.work ?? null;
  const elapsedMin = work ? Math.max(0, Math.round((now - Date.parse(work.startedAt)) / 60_000)) : 0;
  const leaseMin = work?.leaseExpiresAt ? Math.round((Date.parse(work.leaseExpiresAt) - now) / 60_000) : null;
  const recent = detail?.recent ?? [];
  const count = (k: "s" | "f" | "u") => recent.filter((x) => x === k).length;
  const problem = state === "error" || state === "lost" || exhausted;
  return (
    <section className={s.card} style={{ padding: 16 }} data-testid="agent-office-worker-sheet">
      <button type="button" className={s.back} onClick={onBack}>‹ {f.sheet.back}</button>
      <div className={s.sheetHead}>
        <span className={s.sheetAva} style={{ background: channel ? `${CHANNEL_COLOR[channel]}1f` : "var(--grs)" }}>
          <PixelSprite c={clothes} />
        </span>
        <div className={s.grow}>
          <div className={s.row}><ChannelIcon channel={channel} /><span className={s.sheetName}>{name}</span></div>
          <div className={s.row} style={{ marginTop: 6 }}>
            <span className={cn(s.chip, stateTone(state, exhausted))}>{exhausted && workerPlace(state, true) === "pod" ? f.sheet.quotaOut : m.real.amux.states[state]}</span>
            {channel ? <span className={s.faint}>{f.channels[channel]}</span> : null}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        {!ownerDetail ? (
          <div className={s.cardbox}><div className={s.faint}>{f.sheet.cardHidden}</div></div>
        ) : work ? (
          <div className={s.cardbox} data-testid="agent-office-worker-card">
            <div className={s.cardKey}>{f.sheet.cardRunning(work.cardKey ?? work.taskId.slice(0, 8))}</div>
            <div className={s.cardTtl}>{work.cardTitle ?? f.sheet.titleSealed}</div>
            <div className={s.faint} style={{ marginTop: 4 }}>
              {f.sheet.started(aestClock(work.startedAt))} · {f.sheet.minutes(elapsedMin)}
            </div>
            {leaseMin !== null ? (
              <div className={cn(s.faint, leaseMin < 0 && s.bad)} style={{ marginTop: 4 }}>
                {f.sheet.lease} {leaseMin < 0 ? f.sheet.leaseOver : f.sheet.leaseLeft(leaseMin)}
              </div>
            ) : null}
          </div>
        ) : (
          <div className={s.cardbox}><div className={s.faint}>{f.sheet.noCard}</div></div>
        )}
      </div>

      <div className={s.facts}>
        <div className={s.fact}>
          <div className={s.fl}>{f.sheet.heartbeat}</div>
          <div className={cn(s.fv, late && s.bad)}>{hb ? f.sheet.heartbeatAgo(hb.text) : f.sheet.noHeartbeat}</div>
          <div className={s.fs}>{heartbeatAt ? (late ? f.sheet.heartbeatLate : f.sheet.heartbeatOk) : ""}</div>
        </div>
        <div className={s.fact}>
          <div className={s.fl}>{f.sheet.model}</div>
          <div className={s.fv} style={{ fontSize: 13 }}>{ownerDetail ? detail?.usage?.model ?? f.sheet.modelNone : f.sheet.ownerOnly}</div>
        </div>
        <div className={s.fact}>
          <div className={s.fl}>{f.sheet.tokens}</div>
          <div className={s.fv}>{ownerDetail && detail?.usage ? tokensText(detail.usage.tokens) : "–"}</div>
        </div>
        <div className={s.fact} title={f.sheet.apiCostNote}>
          <div className={s.fl}>{f.sheet.apiCost}</div>
          <div className={s.fv}>{ownerDetail && detail?.usage ? usd(detail.usage.apiCostMicrousd) : "–"}</div>
        </div>
        <div className={cn(s.fact, s.span2)} data-testid="agent-office-worker-quota" data-quota={quota.kind}>
          <div className={s.row}><span className={s.fl}>{f.sheet.quota}</span><span className={s.grow} />
            {quota.kind === "fresh" && quota.resetAt ? <span className={s.fl}>{f.sheet.quotaReset(aestClock(quota.resetAt))}</span> : null}
          </div>
          {quota.kind === "fresh" ? (
            <>
              <div className={s.row}>
                <span className={s.qtrack} style={{ height: 8 }}>
                  <span className={s.qfill} style={{ width: `${quota.percent}%`, background: exhausted || quota.percent < 20 ? "var(--ba)" : "var(--ok)" }} />
                </span>
                <b className={s.num}>{quota.percent}%</b>
              </div>
              <div className={s.fs}>{f.sheet.quotaObserved(aestStamp(quota.observedAt))}</div>
            </>
          ) : quota.kind === "old" ? (
            <>
              <div className={cn(s.fv, s.faint)}>
                <span className={s.num}>{quota.percent}%</span> · {f.sheet.quotaAsOf(aestSince(quota.observedAt, now))}
              </div>
              <div className={s.fs}>{f.sheet.quotaOldHint(QUOTA_FRESH_MINUTES)}</div>
            </>
          ) : (
            <>
              <div className={cn(s.fv, s.faint)}>{f.sheet.quotaNotCollected}</div>
              <div className={s.fs}>{f.sheet.quotaNotCollectedHint}</div>
            </>
          )}
        </div>
        <div className={cn(s.fact, s.span2)}>
          <div className={s.fl}>{f.sheet.recent}</div>
          {recent.length ? (
            <>
              <div className={s.hist}>
                {recent.map((r, i) => (
                  <i key={i} className={r === "f" ? s.hf : r === "u" ? s.hu : undefined} />
                ))}
              </div>
              <div className={s.fs}>{f.sheet.recentCounts(count("s"), count("f"), count("u"))}</div>
            </>
          ) : (
            <div className={s.fs}>{f.sheet.recentNone}</div>
          )}
        </div>
      </div>

      <div className={s.links}>
        {onTerminal ? <button type="button" className={s.lnk} onClick={onTerminal} data-testid="agent-office-view-cli">{f.sheet.openTerminal} ›</button> : null}
        {ownerDetail ? <Link className={s.lnk} href={CARDS_HREF}>{f.sheet.openCard} ›</Link> : null}
        <Link className={s.lnk} href={WORKERS_HREF}>{f.sheet.openWorkers} ›</Link>
        {problem ? <Link className={cn(s.lnk, s.lnkBad)} href={SAFETY_HREF}>{f.sheet.openRecovery} ›</Link> : null}
      </div>
      <p className={s.roNote}>ⓘ {f.sheet.readOnly}</p>
    </section>
  );
}

function Roster({
  f,
  heartbeats,
  workers,
  detail,
  ownerDetail,
  now,
  problemsOnly,
  onOpen,
}: {
  f: FloorCopy;
  heartbeats: ReadonlyMap<string, string | null>;
  workers: LiveWorker[];
  detail: Record<string, AgentOfficeWorkerDetail> | null;
  ownerDetail: boolean;
  now: number;
  problemsOnly: boolean;
  onOpen: (name: string) => void;
}) {
  const rank = (w: FloorWorker) =>
    w.state === "error" || w.state === "lost" ? 0 : w.quotaExhausted && workerPlace(w.state, true) === "pod" ? 1 : w.state === "isolated" || w.state === "blocked" ? 2 : w.state === "busy" ? 3 : w.state === "ready" ? 4 : RUNNING.includes(w.state) ? 5 : 6;
  const rows = [...workers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).filter((w) => !problemsOnly || w.needsLook);
  const heartbeat = (name: string) => {
    const hb = ago(heartbeats.get(name) ?? null, now, f);
    return hb ? f.sheet.heartbeatAgo(hb.text) : "";
  };
  return (
    <div className={cn(s.card, s.roster)} data-testid="agent-office-roster">
      <table className={s.tbl}>
        <caption>{f.roster.caption}</caption>
        <thead>
          <tr>
            <th scope="col">{f.roster.worker}</th>
            <th scope="col">{f.roster.state}</th>
            <th scope="col">{f.roster.card}</th>
            <th scope="col">{f.roster.elapsed}</th>
            <th scope="col">{f.roster.heartbeat}</th>
            <th scope="col">{f.roster.quota}</th>
            <th scope="col" className={s.right}>{f.roster.cost}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => {
            const d = detail?.[w.name];
            const work = d?.work;
            return (
              <tr key={w.name} onClick={() => onOpen(w.name)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(w.name)}>
                <td><span className={s.row}><ChannelIcon channel={w.channel} /><b>{w.name}</b></span></td>
                <td><span className={cn(s.chip, stateTone(w.state, w.quotaExhausted))}>{w.quotaExhausted && workerPlace(w.state, true) === "pod" ? f.sheet.quotaOut : w.label}</span></td>
                <td>{work ? <><b style={{ color: "var(--act)" }}>{work.cardKey ?? "–"}</b> <span className={s.faint}>{work.cardTitle ?? ""}</span></> : <span className={s.faint}>{ownerDetail ? f.roster.none : f.sheet.ownerOnly}</span>}</td>
                <td className={s.num}>{work ? f.sheet.minutes(Math.max(0, Math.round((now - Date.parse(work.startedAt)) / 60_000))) : <span className={s.faint}>–</span>}</td>
                <td className={s.num}>{heartbeat(w.name) || "–"}</td>
                <td data-quota={w.quota.kind}>
                  {w.quota.kind === "fresh" ? (
                    <span className={s.row}>
                      <span className={s.qtrack} style={{ width: 56, flex: "none" }}>
                        <span className={s.qfill} style={{ width: `${w.quota.percent}%`, background: w.quota.percent < 20 ? "var(--ba)" : "var(--ok)" }} />
                      </span>
                      <span className={cn(s.faint, s.num)}>{w.quota.percent}%</span>
                    </span>
                  ) : w.quota.kind === "old" ? (
                    <span className={s.faint} title={f.sheet.quotaOldHint(QUOTA_FRESH_MINUTES)}>
                      <span className={s.num}>{w.quota.percent}%</span> · {f.sheet.quotaAsOf(aestSince(w.quota.observedAt, now))}
                    </span>
                  ) : (
                    <span className={s.faint} title={f.sheet.quotaNotCollectedHint}>{f.sheet.quotaNotCollected}</span>
                  )}
                </td>
                <td className={cn(s.num, s.right)}>{ownerDetail && d?.usage ? usd(d.usage.apiCostMicrousd) : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? <p className={s.empty} style={{ padding: 12 }}>{f.roster.empty}</p> : null}
    </div>
  );
}

function TodayStrip({
  f,
  live,
  hour,
  steps,
  rewind,
  replayAt,
  playing,
  onRewind,
  onPlay,
}: {
  f: FloorCopy;
  live: AgentOfficeLiveRooms;
  hour: number;
  steps: number;
  rewind: number | null;
  replayAt: number | null;
  playing: boolean;
  onRewind: (step: number) => void;
  onPlay: () => void;
}) {
  const lineHour = replayAt === null ? hour : brisbaneHour(replayAt);
  const shownAt = replayAt === null ? f.today.live : f.today.at(clockOf(replayAt));
  const todayKey = (brisbaneIso(live.readAt) ?? "").slice(0, 10);
  const merges =
    live.merges.kind === "observed"
      ? live.merges.items
          .map((x) => ({ ...x, local: brisbaneIso(x.mergedAt) ?? "" }))
          .filter((x) => x.local.slice(0, 10) === todayKey)
      : [];
  const pos = (local: string) => ((Number(local.slice(11, 13)) + Number(local.slice(14, 16)) / 60) / 24) * 100;
  return (
    <section className={cn(s.card, s.today)} aria-label={f.today.title} data-testid="agent-office-today">
      <div className={s.todayHead}>
        <h2>{f.today.title}</h2>
        <span className={s.faint}>
          {live.merges.kind === "unread"
            ? f.today.unread
            : merges.length
              ? merges.map((x) => f.today.merge(x.pr, x.local.slice(11, 16))).join(" · ")
              : f.today.none}
        </span>
      </div>
      <div className={s.track}>
        {merges.map((x) => (
          <i key={x.pr} className={s.tk} style={{ left: `${pos(x.local)}%` }} title={f.today.merge(x.pr, x.local.slice(11, 16))} />
        ))}
        <div className={s.nowline} style={{ left: `${(lineHour / 24) * 100}%` }}>
          <b>{replayAt === null ? f.today.now : clockOf(replayAt)}</b>
        </div>
      </div>
      <div className={cn(s.hours, s.num)}><span>00</span><span>04</span><span>08</span><span>12</span><span>16</span><span>20</span><span>24</span></div>
      {live.history.kind === "observed" ? (
        <div className={s.rewind}>
          <button type="button" className={s.toggle} aria-pressed={playing} onClick={onPlay} data-testid="agent-office-rewind-play">
            {playing ? `⏸ ${f.today.pause}` : `▶ ${f.today.play}`}
          </button>
          <input
            type="range"
            min={0}
            max={steps}
            value={rewind ?? steps}
            onChange={(e) => onRewind(Number(e.target.value))}
            aria-label={f.today.rewind}
            aria-valuetext={shownAt}
            data-testid="agent-office-rewind"
          />
          <span className={s.faint}>{shownAt}</span>
          {rewind !== null ? (
            <button type="button" className={s.toggle} onClick={() => onRewind(steps)}>{f.today.backToNow}</button>
          ) : null}
        </div>
      ) : (
        <p className={s.roNote}>{f.today.rewindUnread}</p>
      )}
      {rewind !== null ? <p className={s.roNote}>ⓘ {f.today.rewindNote}</p> : null}
      {live.history.kind === "observed" && live.history.truncated ? <p className={s.roNote}>{f.today.truncated}</p> : null}
      <p className={s.roNote}>{f.today.note}</p>
    </section>
  );
}

/** HH:MM on Brisbane's clock. */
function clockOf(at: number): string {
  return aestClock(new Date(at).toISOString()).replace(" AEST", "");
}

export type { DeptStatus };
