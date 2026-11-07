"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from "react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";

import s from "@/components/admin/agentOfficeFloor.module.css";
import type { AgentOfficeFloorCopy } from "@/lib/adminMessages/agentOfficeFloor";
import type { AdminMessageShape } from "@/lib/adminLocale";
import type { AgentOfficeAmuxWorkerState } from "@/lib/agentOffice/live";
import type { DeptStatus } from "@/lib/agentOffice/sim";
import {
  AGENT_OFFICE_CHANNELS,
  AMUX_ROOM_RECT,
  DECISION_ROOM_RECT,
  FLOOR_H,
  FLOOR_W,
  ISLAND_H,
  ISLAND_W,
  OPERATOR_ROOM_RECT,
  OPERATOR_SEAT,
  REVIEW_ROOM_RECT,
  ZONES,
  decisionSeat,
  islandRect,
  islandSeat,
  reviewSeat,
  teamRoomRect,
  teamRoomSeats,
  walkPath,
  type AgentOfficeChannel,
  type FloorLayout,
  type FloorLight,
  type FloorPt,
} from "@/lib/agentOffice/floor";

type FloorCopy = AdminMessageShape<AgentOfficeFloorCopy>;

export const cn = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

export type Clothes = { hair: string; shirt: string; accent: string; skin: string };

const OUT = "#27272a";

/** The office's pixel person: a 16 x 22 grid, legs and arms animated by class. */
export const PixelSprite = memo(function PixelSprite({ c, u = 2 }: { c: Clothes; u?: number }) {
  const R = (x: number, y: number, w: number, h: number, fill: string) => (
    <rect x={x * u} y={y * u} width={w * u} height={h * u} fill={fill} />
  );
  return (
    <svg width={16 * u} height={22 * u} viewBox={`0 0 ${16 * u} ${22 * u}`} shapeRendering="crispEdges" aria-hidden="true">
      <g className="lg lgl">{R(4, 17, 3, 5, OUT)}{R(5, 17, 1, 4, "#3f4656")}</g>
      <g className="lg lgr">{R(9, 17, 3, 5, OUT)}{R(10, 17, 1, 4, "#3f4656")}</g>
      {R(2, 12, 12, 6, OUT)}{R(3, 13, 10, 5, c.shirt)}{R(3, 16, 10, 1, c.accent)}
      <g className="arm">{R(1, 13, 2, 4, OUT)}{R(13, 13, 2, 4, OUT)}</g>
      {R(3, 3, 10, 10, OUT)}{R(4, 4, 8, 8, c.skin)}{R(6, 7, 1, 1, OUT)}{R(9, 7, 1, 1, OUT)}
      {R(5, 9, 1, 1, "#e8939b")}{R(10, 9, 1, 1, "#e8939b")}
      {R(2, 1, 12, 4, OUT)}{R(3, 2, 10, 2, c.hair)}{R(3, 4, 2, 3, c.hair)}{R(11, 4, 2, 2, c.hair)}
      {R(12, 5, 3, 6, OUT)}{R(13, 6, 1, 4, c.accent)}{R(11, 10, 2, 1, OUT)}
    </svg>
  );
});

export const CHANNEL_COLOR: Readonly<Record<AgentOfficeChannel, string>> = {
  claude: "#d97757",
  codex: "#10a37f",
  copilot: "#5b6ee1",
  cursor: "#52525b",
};
const CHANNEL_ICON: Partial<Record<AgentOfficeChannel, string>> = {
  claude: "/model-icons/claude.png",
  codex: "/model-icons/chatgpt.png",
};
const CHANNEL_GLYPH: Readonly<Record<AgentOfficeChannel, string>> = { claude: "Cl", codex: "Cx", copilot: "Co", cursor: "Cu" };

export function ChannelIcon({ channel, size = 16 }: { channel: AgentOfficeChannel | null; size?: number }) {
  if (!channel) return <span className={s.glyph} style={{ background: "#71717a", width: size, height: size }}>?</span>;
  const src = CHANNEL_ICON[channel];
  // eslint-disable-next-line @next/next/no-img-element
  if (src) return <img src={src} alt="" width={size} height={size} className={s.chIcon} />;
  return (
    <span className={s.glyph} style={{ background: CHANNEL_COLOR[channel], width: size, height: size }}>
      {CHANNEL_GLYPH[channel]}
    </span>
  );
}

export type FloorWorker = {
  name: string;
  channel: AgentOfficeChannel | null;
  state: AgentOfficeAmuxWorkerState;
  label: string;
  quotaExhausted: boolean;
  /** Mean remaining quota is computed per island from these. */
  quotaPercent: number | null;
  cardKey: string | null;
  needsLook: boolean;
  clothes: Clothes;
};

export type FloorTeam = {
  id: string;
  name: string;
  icon: string;
  status: DeptStatus;
  line: string | null;
  people: { id: string; clothes: Clothes; lead: boolean }[];
};

export type FloorSeated = { name: string; label: string; status: DeptStatus; dim: boolean; clothes: Clothes };

type Props = {
  copy: FloorCopy;
  workers: FloorWorker[];
  /** Null when the AMUX workers could not be read. */
  layout: FloorLayout | null;
  teams: FloorTeam[];
  reviewers: FloorSeated[];
  decision: FloorSeated[];
  reviewStatus: DeptStatus;
  decisionStatus: DeptStatus;
  operator: { name: string; clothes: Clothes };
  selected: string | null;
  problemsOnly: boolean;
  light: FloorLight;
  alarm: boolean;
  /** Bumped by the parent to play the merge celebration. */
  celebrate: number;
  toast: { text: string; bad: boolean } | null;
  onSelectWorker: (name: string) => void;
  onSelectTeam: (id: string) => void;
  onSelectSeated: (room: "review" | "decision", name: string) => void;
  onOverflow: () => void;
};

type Motion = { x: number; y: number; path: FloorPt[] | null; hidden: boolean };
type Cam = { x: number; y: number; s: number };

const LIGHT: Readonly<Record<FloorLight, { dark: number; lamp: number; sky: string; stars: number }>> = {
  day: { dark: 0, lamp: 0, sky: "linear-gradient(#8cc8ff,#dff0ff)", stars: 0 },
  dawn: { dark: 0.2, lamp: 0.5, sky: "linear-gradient(#ffb38a,#cfe4ff)", stars: 0 },
  dusk: { dark: 0.22, lamp: 0.6, sky: "linear-gradient(#ff9a6b,#ffd29a)", stars: 0 },
  night: { dark: 0.62, lamp: 1, sky: "linear-gradient(#0b1533,#1f2d5c)", stars: 1 },
};

const WINDOWS = Array.from({ length: 12 }, (_, i) => i);
const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The live office floor. Every place a worker is drawn comes from its record
 * (lib/agentOffice/floor.ts); a worker walks only when a fresh reading moves
 * it, and nothing here acts on anything. Labels are drawn in screen space so
 * they stay readable at any zoom; finer ones appear as the camera comes closer.
 */
export default function AgentOfficeFloor(props: Props) {
  const { copy, workers, layout, teams, reviewers, decision, selected, problemsOnly, light, alarm, celebrate } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spriteEls = useRef(new Map<string, HTMLDivElement>());
  const motion = useRef(new Map<string, Motion>());
  const cam = useRef<Cam>({ x: FLOOR_W / 2, y: FLOOR_H / 2, s: 0.6 });
  const target = useRef<Cam>({ x: FLOOR_W / 2, y: FLOOR_H / 2, s: 0.6 });
  const fit = useRef(true);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const spots = useMemo(() => new Map((layout?.spots ?? []).map((spot) => [spot.name, spot])), [layout]);
  const byName = useMemo(() => new Map(workers.map((w) => [w.name, w])), [workers]);

  // A fresh reading moves only the workers whose place changed: they walk there.
  useEffect(() => {
    const reduce = reducedMotion();
    for (const w of workers) {
      const spot = spots.get(w.name);
      const at = spot?.at ?? null;
      const m = motion.current.get(w.name);
      if (!m) {
        motion.current.set(w.name, { x: at?.x ?? 0, y: at?.y ?? 0, path: null, hidden: at === null });
        continue;
      }
      if (!at) {
        m.hidden = true;
        m.path = null;
        continue;
      }
      const wasHidden = m.hidden;
      m.hidden = false;
      const endpoint = m.path?.at(-1) ?? { x: m.x, y: m.y };
      if (endpoint.x === at.x && endpoint.y === at.y) continue;
      if (wasHidden || reduce) {
        m.x = at.x;
        m.y = at.y;
        m.path = null;
      } else {
        m.path = walkPath({ x: m.x, y: m.y }, at);
      }
    }
    for (const name of [...motion.current.keys()]) if (!byName.has(name)) motion.current.delete(name);
  }, [workers, spots, byName]);

  const fitAll = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    fit.current = true;
    const scale = Math.min(el.clientWidth / FLOOR_W, el.clientHeight / FLOOR_H);
    target.current = { x: FLOOR_W / 2, y: FLOOR_H / 2, s: scale };
  }, []);
  const zoomTo = useCallback((x: number, y: number, scale: number) => {
    fit.current = false;
    target.current = { x, y, s: Math.max(0.3, Math.min(2.6, scale)) };
  }, []);
  const zoomRect = useCallback(
    (x: number, y: number, w: number, h: number) => {
      const el = wrapRef.current;
      if (!el) return;
      zoomTo(x + w / 2, y + h / 2, Math.min(el.clientWidth / (w + 50), el.clientHeight / (h + 50)));
    },
    [zoomTo]
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    fitAll();
    cam.current = { ...target.current };
    const observer = new ResizeObserver(() => {
      if (fit.current) fitAll();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitAll]);

  // Selecting a worker brings it into view.
  useEffect(() => {
    if (!selected) return;
    const m = motion.current.get(selected);
    if (m && !m.hidden) zoomTo(m.x + 16, m.y + 22, Math.max(target.current.s, 1.5));
  }, [selected, zoomTo]);

  // The paint loop: camera, walking, and labels that follow the camera.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const reduce = reducedMotion();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const wrap = wrapRef.current;
      const stage = stageRef.current;
      const labels = labelsRef.current;
      if (wrap && stage && labels) {
        const c = cam.current;
        const t = target.current;
        const k = reduce ? 1 : 0.12;
        c.x += (t.x - c.x) * k;
        c.y += (t.y - c.y) * k;
        c.s += (t.s - c.s) * k;
        const ox = wrap.clientWidth / 2 - c.x * c.s;
        const oy = wrap.clientHeight / 2 - c.y * c.s;
        stage.style.transform = `translate(${ox}px, ${oy}px) scale(${c.s})`;
        for (const [name, m] of motion.current) {
          if (m.path?.length) {
            const p = m.path[0];
            const dx = p.x - m.x;
            const dy = p.y - m.y;
            const d = Math.hypot(dx, dy);
            const step = 150 * dt;
            if (d <= step) {
              m.x = p.x;
              m.y = p.y;
              m.path.shift();
              if (!m.path.length) m.path = null;
            } else {
              m.x += (dx / d) * step;
              m.y += (dy / d) * step;
            }
          }
          const el = spriteEls.current.get(name);
          if (!el) continue;
          el.style.left = `${m.x}px`;
          el.style.top = `${m.y}px`;
          el.style.zIndex = String(Math.round(m.y + 20));
          el.style.display = m.hidden && !m.path ? "none" : "";
          el.classList.toggle(s.walk, !!m.path);
        }
        const ls = Math.max(0.8, Math.min(1, c.s * 1.3));
        labels.classList.toggle(s.compact, c.s < 0.9);
        const sel = selectedRef.current;
        for (const node of labels.children as HTMLCollectionOf<HTMLElement>) {
          const follow = node.dataset.follow;
          let x = Number(node.dataset.x);
          let y = Number(node.dataset.y);
          // A minimap (a phone) shows only the marks that need a look.
          let visible = (!node.dataset.min || c.s >= Number(node.dataset.min)) && (c.s >= 0.45 || node.dataset.kind === "mark");
          if (follow) {
            const m = motion.current.get(follow);
            if (!m || (m.hidden && !m.path)) visible = false;
            else {
              x = m.x + 16;
              y = m.y + Number(node.dataset.dy ?? 0);
              if (follow === sel) visible = true;
              if (m.path && node.dataset.kind === "bub") visible = false;
            }
          }
          node.style.display = visible ? "" : "none";
          if (visible && node.dataset.maxw) {
            (node.firstElementChild as HTMLElement).style.maxWidth = `${Math.round((Number(node.dataset.maxw) * c.s) / ls)}px`;
          }
          if (visible) node.style.transform = `translate(${Math.round(x * c.s + ox)}px, ${Math.round(y * c.s + oy)}px) scale(${ls})`;
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // The merge celebration: confetti over the AMUX office and a jump at the desks.
  useEffect(() => {
    if (!celebrate || reducedMotion()) return;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const c = cam.current;
    const ox = wrap.clientWidth / 2 - c.x * c.s;
    const oy = wrap.clientHeight / 2 - c.y * c.s;
    const x0 = (AMUX_ROOM_RECT.x + 380) * c.s + ox;
    const y0 = (AMUX_ROOM_RECT.y + 240) * c.s + oy;
    const colors = ["#2563eb", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#f472b6"];
    let parts = Array.from({ length: 140 }, (_, i) => ({
      x: x0, y: y0, vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 9 - 3,
      c: colors[i % colors.length], r: Math.random() * 6.28, size: 4 + Math.random() * 4, life: 90 + Math.random() * 40,
    }));
    let raf = 0;
    const tick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      parts = parts.filter((p) => p.life-- > 0);
      for (const p of parts) {
        p.vy += 0.25; p.x += p.vx; p.y += p.vy; p.r += 0.2;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2); ctx.restore();
      }
      if (parts.length) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    raf = requestAnimationFrame(tick);
    for (const w of workers) {
      if (w.state !== "busy") continue;
      const el = spriteEls.current.get(w.name);
      if (!el) continue;
      el.classList.remove(s.jump);
      void el.offsetWidth;
      el.classList.add(s.jump);
    }
    return () => cancelAnimationFrame(raf);
    // Only a new celebration plays it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [celebrate]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("button,[role=button],[data-hud]")) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    wrapRef.current?.classList.add(s.dragging);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    fit.current = false;
    target.current.x -= dx / cam.current.s;
    target.current.y -= dy / cam.current.s;
    cam.current.x = target.current.x;
    cam.current.y = target.current.y;
  };
  const endDrag = () => {
    drag.current = null;
    wrapRef.current?.classList.remove(s.dragging);
  };
  const onWheel = (e: ReactWheelEvent) => {
    // Zoom with Ctrl or a pinch; a plain wheel keeps scrolling the page.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomTo(target.current.x, target.current.y, target.current.s * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  };

  const lightCfg = LIGHT[light];
  const registerSprite = (name: string) => (el: HTMLDivElement | null) => {
    if (el) spriteEls.current.set(name, el);
    else spriteEls.current.delete(name);
  };

  // Island counts for the heads.
  const islandStats = AGENT_OFFICE_CHANNELS.map((ch) => {
    const list = workers.filter((w) => w.channel === ch);
    const quotas = list.map((w) => w.quotaPercent).filter((q): q is number => q !== null);
    return {
      ch,
      total: list.length,
      busy: list.filter((w) => w.state === "busy").length,
      rest: list.filter((w) => spots.get(w.name)?.place === "lounge").length,
      zz: list.filter((w) => spots.get(w.name)?.place === "pod").length,
      bad: list.filter((w) => w.state === "error" || w.state === "lost").length,
      quota: quotas.length ? Math.round(quotas.reduce((a, b) => a + b, 0) / quotas.length) : null,
      over: layout?.overflow.island[ch] ?? 0,
    };
  });
  const busyTotal = workers.filter((w) => w.state === "busy").length;
  const lamps: FloorPt[] = [];
  if (layout) {
    for (const ch of AGENT_OFFICE_CHANNELS) {
      layout.deskOwner[ch].forEach((owner, i) => {
        if (owner && byName.get(owner)?.state === "busy") lamps.push(islandSeat(ch, i));
      });
    }
  }

  const lab = (key: string, x: number, y: number, node: ReactNode, opts: { min?: number; cls?: string; maxw?: number } = {}) => (
    <div key={key} className={cn(s.lab, opts.cls)} data-x={x} data-y={y} data-min={opts.min} data-maxw={opts.maxw}>
      {node}
    </div>
  );
  const follow = (key: string, name: string, dy: number, node: ReactNode, opts: { min?: number; kind?: string } = {}) => (
    <div key={key} className={s.lab} data-follow={name} data-dy={dy} data-min={opts.min} data-kind={opts.kind}>
      {node}
    </div>
  );

  return (
    <div
      ref={wrapRef}
      className={s.floorwrap}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={endDrag}
      onWheel={onWheel}
      data-testid="agent-office-floor"
      data-light={light}
    >
      <div ref={stageRef} className={cn(s.stage, problemsOnly && s.prob)} style={{ width: FLOOR_W, height: FLOOR_H }}>
        <div className={s.wallstrip} style={{ width: FLOOR_W, "--sky": lightCfg.sky, "--stars": lightCfg.stars } as CSSProperties}>
          {WINDOWS.map((i) => (
            <div key={i} className={s.win}>
              {[0, 1, 2].map((j) => (
                <i key={j} style={{ left: `${10 + ((i * 37 + j * 53) % 70)}%`, top: `${15 + ((i * 11 + j * 29) % 60)}%` }} />
              ))}
            </div>
          ))}
        </div>

        {/* Team rooms */}
        {teams.map((team, i) => {
          const r = teamRoomRect(i);
          const seats = teamRoomSeats(i);
          const calm = team.status !== "attention";
          return (
            <div key={team.id}>
              <div className={cn(s.room, calm && s.tw)} style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
              {seats.map((seat, j) => (
                <div
                  key={j}
                  className={cn(s.desk, team.status === "working" && j === 0 && s.deskOn, calm && s.tw)}
                  style={{ left: seat.x - 2, top: seat.y + 30, zIndex: seat.y + 60 }}
                >
                  <i className={s.mon} />
                </div>
              ))}
              {team.people.slice(0, seats.length).map((person, j) => (
                <div
                  key={person.id}
                  className={cn(s.sp, person.lead && team.status === "working" && s.type, calm && s.tw)}
                  style={{ left: seats[j].x, top: seats[j].y, zIndex: seats[j].y + 20 }}
                  role="button"
                  tabIndex={-1}
                  onClick={() => props.onSelectTeam(team.id)}
                >
                  <PixelSprite c={person.clothes} />
                </div>
              ))}
              <div className={cn(s.prop, s.plant, calm && s.tw)} style={{ left: r.x + r.w - 22, top: r.y + 32 }} />
            </div>
          );
        })}

        {/* Review room */}
        <div className={cn(s.room, s.tw)} style={rectStyle(REVIEW_ROOM_RECT)} />
        {reviewers.map((r, i) => {
          const seat = reviewSeat(i);
          return (
            <div key={r.name}>
              <div className={cn(s.desk, s.tw, r.status === "working" && s.deskOn)} style={{ left: seat.x - 2, top: seat.y + 30, zIndex: seat.y + 60 }}>
                <i className={s.mon} />
              </div>
              <div
                className={cn(s.sp, s.tw, r.status === "working" && s.type, r.dim && s.faded)}
                style={{ left: seat.x, top: seat.y, zIndex: seat.y + 20 }}
                role="button"
                tabIndex={0}
                aria-label={`${r.name} ${r.label}`}
                onClick={() => props.onSelectSeated("review", r.name)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && props.onSelectSeated("review", r.name)}
              >
                <PixelSprite c={r.clothes} />
              </div>
            </div>
          );
        })}

        {/* Decision Maker room */}
        <div className={s.room} style={rectStyle(DECISION_ROOM_RECT)} />
        {decision.map((d, i) => {
          const seat = decisionSeat(i);
          return (
            <div key={d.name}>
              <div className={cn(s.desk, d.status !== "waiting" && s.deskOn)} style={{ left: seat.x - 2, top: seat.y + 30, zIndex: seat.y + 60 }}>
                <i className={s.mon} />
              </div>
              <div
                className={cn(s.sp, d.status === "working" && s.type, d.dim && s.faded)}
                style={{ left: seat.x, top: seat.y, zIndex: seat.y + 20 }}
                role="button"
                tabIndex={0}
                aria-label={`${d.name} ${d.label}`}
                onClick={() => props.onSelectSeated("decision", d.name)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && props.onSelectSeated("decision", d.name)}
              >
                <PixelSprite c={d.clothes} />
              </div>
            </div>
          );
        })}

        {/* Operator's office */}
        <div className={cn(s.room, s.tw)} style={rectStyle(OPERATOR_ROOM_RECT)} />
        <div className={cn(s.prop, s.rug, s.tw)} style={{ left: 944, top: 250, width: 128, height: 32 }} />
        <div className={cn(s.desk, s.deskOn, s.tw)} style={{ left: OPERATOR_SEAT.x - 14, top: OPERATOR_SEAT.y + 30, width: 60, zIndex: 300 }}>
          <i className={s.mon} />
        </div>
        <div className={cn(s.sp, s.type, s.tw)} style={{ left: OPERATOR_SEAT.x, top: OPERATOR_SEAT.y, zIndex: 228 }}>
          <PixelSprite c={props.operator.clothes} />
        </div>

        {/* AMUX office */}
        <div className={cn(s.room, s.amuxroom, alarm && s.alarm)} style={rectStyle(AMUX_ROOM_RECT)} data-testid="agent-office-amux-room" />
        {alarm ? <div className={s.beacon} style={{ left: AMUX_ROOM_RECT.x + 528, top: AMUX_ROOM_RECT.y - 11 }} /> : null}
        {AGENT_OFFICE_CHANNELS.map((ch) => {
          const r = islandRect(ch);
          const stat = islandStats.find((x) => x.ch === ch)!;
          return <div key={ch} className={cn(s.island, problemsOnly && !stat.bad && !stat.zz && s.dim)} style={rectStyle(r)} />;
        })}
        {layout
          ? AGENT_OFFICE_CHANNELS.flatMap((ch) =>
              layout.deskOwner[ch].map((owner, i) => {
                const seat = islandSeat(ch, i);
                const w = owner ? byName.get(owner) : undefined;
                const tone = !w ? s.covered : w.state === "busy" ? s.deskOn : w.state === "error" || w.state === "lost" ? s.deskErr : "";
                return (
                  <div key={`${ch}-${i}`} className={cn(s.desk, tone)} style={{ left: seat.x - 2, top: seat.y + 30, zIndex: seat.y + 60 }}>
                    <i className={s.mon} />
                    {w?.state === "busy" ? <i className={s.paper} /> : null}
                  </div>
                );
              })
            )
          : null}
        <div className={cn(s.prop, s.rug)} style={{ left: 758, top: 366, width: 322, height: 184 }} />
        <div className={cn(s.prop, s.sofa)} style={{ left: 780, top: 362, width: 200, height: 22 }} />
        <div className={cn(s.prop, s.coffee)} style={{ left: 1046, top: 368, width: 22, height: 30 }} />
        <div className={cn(s.prop, s.plant)} style={{ left: 1054, top: 524 }} />
        {Array.from({ length: ZONES.pod.cap }, (_, i) => (
          <div
            key={i}
            className={s.pod}
            style={{ left: ZONES.pod.x + (i % ZONES.pod.cols) * ZONES.pod.dx - 3, top: ZONES.pod.y + Math.floor(i / ZONES.pod.cols) * ZONES.pod.dy - 2, zIndex: ZONES.pod.y }}
          />
        ))}
        <div className={cn(s.prop, s.bench)} style={{ left: 764, top: 804, width: 310, height: 12, zIndex: 900 }} />

        {/* AMUX workers */}
        {workers.map((w) => (
          <div
            key={w.name}
            ref={registerSprite(w.name)}
            className={cn(
              s.sp,
              w.state === "busy" && s.type,
              spots.get(w.name)?.place === "pod" && s.sleep,
              selected === w.name && s.sel,
              problemsOnly && !w.needsLook && s.dim
            )}
            role="button"
            tabIndex={0}
            aria-label={`${w.name} ${w.label}`}
            data-testid="agent-office-amux-person"
            data-worker-state={w.state}
            data-place={spots.get(w.name)?.place ?? "none"}
            onClick={() => props.onSelectWorker(w.name)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              props.onSelectWorker(w.name);
            }}
          >
            <PixelSprite c={w.clothes} />
            <span className={s.srOnly}>{w.name}</span>
          </div>
        ))}

        <div className={s.night} style={{ "--dark": lightCfg.dark } as CSSProperties} />
        <div className={s.lamps} style={{ "--lamp": lightCfg.lamp } as CSSProperties}>
          {lamps.map((p, i) => (
            <i key={i} style={{ left: p.x + 16, top: p.y + 30 }} />
          ))}
        </div>
      </div>

      <div ref={labelsRef} className={cn(s.labels, problemsOnly && s.prob)}>
        {teams.map((team, i) => {
          const r = teamRoomRect(i);
          const calm = team.status !== "attention";
          return [
            lab(
              `t-${team.id}`,
              r.x + 6,
              r.y + 6,
              <button type="button" className={s.rname} onClick={() => props.onSelectTeam(team.id)} data-testid={`agent-office-${team.id}-name`}>
                <i className={cn(s.dot, s[`dot_${team.status}`])} />
                <span className={s.ellip}>{team.name}</span>
              </button>,
              { cls: calm ? s.tw : undefined, maxw: r.w - 12 }
            ),
            team.line ? lab(`tb-${team.id}`, r.x + r.w / 2, r.y + 58, <div className={s.bub}>{team.line}</div>, { min: 1.05, cls: calm ? s.tw : undefined }) : null,
          ];
        })}
        {lab("review", REVIEW_ROOM_RECT.x + 6, REVIEW_ROOM_RECT.y + 6, <span className={s.rname}><i className={cn(s.dot, s[`dot_${props.reviewStatus}`])} />{copy.rooms.review}</span>, { cls: s.tw })}
        {reviewers.map((r, i) => lab(`rb-${r.name}`, reviewSeat(i).x + 16, reviewSeat(i).y - 2, <div className={s.bub}>{r.label}</div>, { min: 1.1, cls: s.tw }))}
        {lab("dm", DECISION_ROOM_RECT.x + 6, DECISION_ROOM_RECT.y + 6, <span className={s.rname}><i className={cn(s.dot, s[`dot_${props.decisionStatus}`])} />{copy.rooms.decision}</span>)}
        {decision.map((d, i) => lab(`db-${d.name}`, decisionSeat(i).x + 16, decisionSeat(i).y - 2, <div className={s.bub}>{d.label}</div>, { min: 1.05 }))}
        {lab("op", OPERATOR_ROOM_RECT.x + 6, OPERATOR_ROOM_RECT.y + 6, <span className={s.rname}>🎛️ {copy.rooms.operator}</span>, { cls: s.tw })}
        {lab("op-tag", OPERATOR_SEAT.x + 16, OPERATOR_SEAT.y + 50, <div className={s.tag}>{props.operator.name}</div>, { min: 1.05, cls: s.tw })}
        {lab(
          "amux",
          AMUX_ROOM_RECT.x + 10,
          AMUX_ROOM_RECT.y + 8,
          <span className={s.rname}>
            <i className={cn(s.dot, s[layout ? (alarm || islandStats.some((x) => x.bad) ? "dot_attention" : busyTotal ? "dot_working" : "dot_done") : "dot_attention"])} />
            {copy.rooms.amux}
            <span className={cn(s.faint, s.xtra)}>{layout ? copy.rooms.amuxCount(busyTotal, workers.length) : ` ${copy.rooms.amuxUnread}`}</span>
          </span>
        )}
        {layout
          ? islandStats.map((st) => {
              const r = islandRect(st.ch);
              return [
                lab(
                  `ih-${st.ch}`,
                  r.x + 6,
                  r.y + 6,
                  <button
                    type="button"
                    className={s.ihead}
                    onClick={() => zoomRect(r.x, r.y, ISLAND_W, ISLAND_H)}
                    aria-label={copy.island.open(copy.channels[st.ch])}
                    data-testid={`agent-office-island-${st.ch}`}
                  >
                    <ChannelIcon channel={st.ch} />
                    <b>{copy.channels[st.ch]}</b>
                    <span className={cn(s.faint, s.xtra)}>{copy.island.workers(st.total)}</span>
                    <span className={s.cnt}><i className={cn(s.dot, s.dot_working)} />{st.busy}</span>
                    <span className={s.cnt}>☕{st.rest}</span>
                    {st.zz ? <span className={s.cnt}>zZ {st.zz}</span> : null}
                    {st.bad ? <span className={cn(s.cnt, s.cntBad)}>! {st.bad}</span> : null}
                    {st.quota !== null ? (
                      <span className={cn(s.miniQ, s.xtra)} title={copy.island.quota(st.quota)}>
                        <i style={{ width: `${st.quota}%`, background: st.quota < 20 ? "var(--ba)" : st.quota < 40 ? "var(--wa)" : "var(--ok)" }} />
                      </span>
                    ) : null}
                  </button>
                ),
                st.over
                  ? lab(
                      `io-${st.ch}`,
                      r.x + r.w - 56,
                      r.y + r.h - 26,
                      <button type="button" className={s.more} onClick={props.onOverflow} title={copy.island.moreTitle}>
                        {copy.island.more(st.over)}
                      </button>
                    )
                  : null,
              ];
            })
          : null}
        {lab("z-lounge", ZONES.lounge.x - 6, 336, <span className={s.zonelab}>{copy.zones.lounge}</span>)}
        {lab("z-pod", ZONES.pod.x - 8, ZONES.pod.y + 2 * ZONES.pod.dy - 4, <span className={s.zonelab}>{copy.zones.pod}</span>)}
        {lab("z-bench", ZONES.bench.x - 8, ZONES.bench.y + 58, <span className={s.zonelab}>{copy.zones.bench}</span>)}
        {layout && layout.overflow.lounge ? lab("o-lounge", ZONES.lounge.x + 250, ZONES.lounge.y + 160, <button type="button" className={s.more} onClick={props.onOverflow} title={copy.overflowTitle}>{copy.overflow(layout.overflow.lounge)}</button>) : null}
        {layout && layout.overflow.pod ? lab("o-pod", ZONES.pod.x + 250, ZONES.pod.y + 116, <button type="button" className={s.more} onClick={props.onOverflow} title={copy.overflowTitle}>{copy.overflow(layout.overflow.pod)}</button>) : null}
        {layout && layout.overflow.bench ? lab("o-bench", ZONES.bench.x + 250, ZONES.bench.y - 18, <button type="button" className={s.more} onClick={props.onOverflow} title={copy.overflowTitle}>{copy.overflow(layout.overflow.bench)}</button>) : null}
        {layout && layout.overflow.noChannel ? lab("o-none", AMUX_ROOM_RECT.x + 380, AMUX_ROOM_RECT.y + AMUX_ROOM_RECT.h - 22, <button type="button" className={s.more} onClick={props.onOverflow}>{copy.island.noChannel(layout.overflow.noChannel)}</button>) : null}
        {workers.flatMap((w) => {
          const place = spots.get(w.name)?.place;
          const out: ReactNode[] = [];
          if (w.state === "error" || w.state === "lost") out.push(follow(`m-${w.name}`, w.name, -2, <div className={s.alert}>!</div>, { kind: "mark" }));
          else if (place === "pod") out.push(follow(`m-${w.name}`, w.name, -2, <div className={s.zz}>zZ</div>, { kind: "mark" }));
          out.push(follow(`t-${w.name}`, w.name, 48, <div className={s.tag}>{w.name}</div>, { min: 1.75 }));
          out.push(
            follow(
              `b-${w.name}`,
              w.name,
              -4,
              <div className={s.bub}>{w.state === "busy" && w.cardKey ? <b>{w.cardKey}</b> : w.label}</div>,
              { min: 2, kind: "bub" }
            )
          );
          return out;
        })}
      </div>

      <canvas ref={canvasRef} className={s.confetti} aria-hidden="true" />
      <div className={cn(s.toast, props.toast && s.toastOn, props.toast?.bad && s.toastBad)} role="status">
        {props.toast?.text ?? ""}
      </div>
      <div className={s.hud} data-hud>
        <button type="button" onClick={() => zoomTo(target.current.x, target.current.y, target.current.s * 1.35)} aria-label={copy.hud.zoomIn}>+</button>
        <button type="button" onClick={() => zoomTo(target.current.x, target.current.y, target.current.s / 1.35)} aria-label={copy.hud.zoomOut}>−</button>
        <button type="button" onClick={fitAll}>{copy.hud.fit}</button>
      </div>
    </div>
  );
}

const rectStyle = (r: { x: number; y: number; w: number; h: number }): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });
