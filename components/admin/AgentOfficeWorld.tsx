"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { cx } from "@/components/admin/agentOfficeStyles";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAgentOfficeMessages } from "@/lib/adminMessages/agentOffice";
import type {
  AgentOfficeAmuxView,
  AgentOfficeDecisionView,
  AgentOfficeReviewView,
  AgentOfficeSeatedView,
} from "@/lib/agentOffice/live";
import {
  AGENT_OFFICE_AMUX_RECORD_HREF,
  AGENT_OFFICE_DECISION_RECORD_HREF,
  agentOfficeDept,
  agentOfficeSeatedClothes,
  type AgentOfficeSeatedRoom,
} from "@/lib/agentOffice/roster";
import type { Agent, AgentOffice, Snapshot } from "@/lib/agentOffice/sim";
import {
  AMUX_ROOM,
  DECISION_ROOM,
  REVIEW_ROOM,
  type Room,
  ENTRANCE_MAT,
  PROPS,
  ROOMS,
  TILE,
  WORLD_H,
  WORLD_W,
  roomOf,
} from "@/lib/agentOffice/world";

type Props = {
  engine: AgentOffice;
  /** The AMUX execution room, read from the real record. */
  amux: AgentOfficeAmuxView;
  /** The independent review room, read from the review server's latest report. */
  review: AgentOfficeReviewView;
  /** The Decision Maker room, read from its switches and its ledger's counts. */
  decision: AgentOfficeDecisionView;
  snap: Snapshot;
  selectedId: string | null;
  follow: boolean;
  onSelect: (agent: Agent) => void;
  /** A seated figure was clicked: its profile is read from the room's record by name. */
  onSelectSeated: (room: AgentOfficeSeatedRoom, name: string) => void;
};

type Cam = { x: number; y: number; scale: number };

/** The staff layer renders once; after that the paint loop updates the DOM directly. */
const AgentLayer = memo(function AgentLayer({
  agents,
  register,
  onPick,
  leadLabel,
  operatorLabel,
}: {
  agents: Agent[];
  register: (id: string, el: HTMLDivElement | null) => void;
  onPick: (agent: Agent) => void;
  leadLabel: string;
  operatorLabel: string;
}) {
  return (
    <>
      {agents.map((agent) => (
        <div
          key={agent.id}
          ref={(el) => register(agent.id, el)}
          onPointerUp={() => onPick(agent)}
          data-testid="agent-office-agent"
          data-agent-id={agent.id}
          style={
            {
              // Sprite-only names: a theme token set here (--accent) would be
              // shadowed for the badge, name tag and ring drawn inside it.
              "--cloth-hair": agent.hair,
              "--cloth-shirt": agent.shirt,
              "--cloth-accent": agent.accent,
              "--cloth-skin": agent.skin,
            } as CSSProperties
          }
        >
          <span className={cx("ag-bubble")} />
          <span className={cx("ag-body")}>
            <i className={cx("p-shadow")} />
            <i className={cx("p-leg l")} />
            <i className={cx("p-leg r")} />
            <i className={cx("p-torso")} />
            <i className={cx("p-arm l")} />
            <i className={cx("p-arm r")} />
            <i className={cx("p-head")}>
              <b className={cx("p-eye l")} />
              <b className={cx("p-eye r")} />
            </i>
            <i className={cx("p-hair")} />
          </span>
          <span className={cx("ag-tag")}>
            {agent.name}
            {agent.rank === "lead" ? <em>{leadLabel}</em> : null}
            {agent.rank === "operator" ? <em>{operatorLabel}</em> : null}
          </span>
        </div>
      ))}
    </>
  );
});

/**
 * Figures seated at a room's desks from a real record: the AMUX workers, the
 * reviewers and the Decision Maker instances. Not the floor's staff: each is
 * one row of its record, what it says is its real state, and a click opens
 * that record as a profile.
 */
const SeatedLayer = memo(function SeatedLayer({
  room,
  kind,
  people,
  onPick,
}: {
  room: Room;
  /** Which seated room: its clothes and whose profile a click opens. */
  kind: AgentOfficeSeatedRoom;
  people: AgentOfficeSeatedView[];
  onPick: (kind: AgentOfficeSeatedRoom, name: string) => void;
}) {
  return (
    <>
      {people.slice(0, room.desks.length).map((worker, i) => {
        const seat = room.desks[i].seat;
        const clothes = agentOfficeSeatedClothes(kind, i);
        return (
          <div
            key={worker.name}
            className={cx("ag", "f-up", "a-sit", "r-member", "wk", worker.dim && "wk-off")}
            title={worker.title}
            role="button"
            tabIndex={0}
            aria-haspopup="dialog"
            aria-label={worker.title}
            onPointerUp={() => onPick(kind, worker.name)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onPick(kind, worker.name);
            }}
            data-testid={`agent-office-${room.id}-person`}
            data-worker-state={worker.state}
            style={
              {
                transform: `translate3d(${(seat.x + 0.5) * TILE}px, ${(seat.y + 0.9) * TILE}px, 0)`,
                zIndex: 200 + seat.y,
                "--cloth-hair": clothes.hair,
                "--cloth-shirt": clothes.shirt,
                "--cloth-accent": clothes.accent,
                "--cloth-skin": clothes.skin,
              } as CSSProperties
            }
          >
            <span className={cx("ag-bubble", "on")}>{worker.label}</span>
            <span className={cx("ag-body")}>
              <i className={cx("p-shadow")} />
              <i className={cx("p-leg l")} />
              <i className={cx("p-leg r")} />
              <i className={cx("p-torso")} />
              <i className={cx("p-arm l")} />
              <i className={cx("p-arm r")} />
              <i className={cx("p-head")}>
                <b className={cx("p-eye l")} />
                <b className={cx("p-eye r")} />
              </i>
              <i className={cx("p-hair")} />
            </span>
            <span className={cx("ag-tag")}>
              <i className={cx("rm-dot", worker.status)} />
              {worker.name}
            </span>
          </div>
        );
      })}
    </>
  );
});

const PropLayer = memo(function PropLayer({
  screenLabel,
  entranceLabel,
}: {
  screenLabel: string;
  entranceLabel: string;
}) {
  return (
    <>
      {PROPS.map((prop, i) => (
        <div
          key={i}
          className={cx("pr", `pr-${prop.kind}`)}
          style={{
            left: prop.x * TILE,
            top: prop.y * TILE,
            width: prop.w * TILE,
            height: prop.h * TILE,
          }}
        >
          {prop.kind === "desk" ? <i className={cx("pr-monitor")} /> : null}
          {prop.label === "screen" ? <span>{screenLabel}</span> : null}
        </div>
      ))}
      <div
        className={cx("entrance-mat")}
        style={{
          left: ENTRANCE_MAT.x * TILE,
          top: ENTRANCE_MAT.y * TILE,
          width: ENTRANCE_MAT.w * TILE,
          height: ENTRANCE_MAT.h * TILE,
        }}
      >
        {entranceLabel}
      </div>
    </>
  );
});

/**
 * The live office floor: rooms, furniture and staff, with a camera that
 * turns to the room the console was asked about. Ported from the original
 * AI OFFICE OfficeWorld; every colour and line on it is a record's.
 */
export default function AgentOfficeWorld({
  engine,
  amux,
  review,
  decision,
  snap,
  selectedId,
  follow,
  onSelect,
  onSelectSeated,
}: Props) {
  const m = useAdminMessages(adminAgentOfficeMessages);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const agentRefs = useRef(new Map<string, HTMLDivElement>());
  const camRef = useRef<Cam>({ x: WORLD_W / 2, y: WORLD_H / 2, scale: 0.5 });
  const targetRef = useRef<Cam>({ x: WORLD_W / 2, y: WORLD_H / 2, scale: 0.5 });
  const selectedRef = useRef<string | null>(selectedId);
  const dragRef = useRef({ on: false, px: 0, py: 0, moved: false });
  const [zoom, setZoom] = useState<"fit" | "close">("fit");

  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  const hotRoom = useMemo(() => {
    if (snap.spotlight) return snap.spotlight; // a room the operator asked about wins
    const working = Object.entries(snap.deptStatus).find(([, status]) => status === "working");
    return working?.[0] ?? null;
  }, [snap.spotlight, snap.deptStatus]);

  /** Where the camera looks when zoomed in: the room asked about, else a room at work. */
  const focus = useMemo(() => {
    if (!hotRoom) return null;
    const room = roomOf(hotRoom);
    return { x: (room.x + room.w / 2) * TILE, y: (room.y + room.h / 2) * TILE };
  }, [hotRoom]);

  const register = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) agentRefs.current.set(id, el);
    else agentRefs.current.delete(id);
  }, []);

  const onPick = useCallback(
    (agent: Agent) => {
      if (!dragRef.current.moved) onSelect(agent);
    },
    [onSelect]
  );
  const onPickSeated = useCallback(
    (kind: AgentOfficeSeatedRoom, name: string) => {
      if (!dragRef.current.moved) onSelectSeated(kind, name);
    },
    [onSelectSeated]
  );

  // Camera target
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const compute = () => {
      const rect = viewport.getBoundingClientRect();
      const fit = Math.min(rect.width / WORLD_W, rect.height / WORLD_H);
      if (zoom === "fit") {
        targetRef.current = { x: WORLD_W / 2, y: WORLD_H / 2, scale: fit };
        return;
      }
      const scale = Math.max(fit * 1.9, 0.95);
      targetRef.current = follow && focus ? { ...focus, scale } : { ...targetRef.current, scale };
    };

    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [zoom, follow, focus]);

  // Paint loop
  useEffect(() => {
    let raf = 0;
    const compactClass = cx("compact");
    const paint = () => {
      const viewport = viewportRef.current;
      const stage = stageRef.current;
      if (viewport && stage) {
        const cam = camRef.current;
        const target = targetRef.current;
        cam.x += (target.x - cam.x) * 0.07;
        cam.y += (target.y - cam.y) * 0.07;
        cam.scale += (target.scale - cam.scale) * 0.08;

        const rect = viewport.getBoundingClientRect();
        const ox = rect.width / 2 - cam.x * cam.scale;
        const oy = rect.height / 2 - cam.y * cam.scale;
        stage.style.transform = `translate3d(${ox}px, ${oy}px, 0) scale(${cam.scale})`;
        if (stage.classList.contains(compactClass) !== cam.scale < 0.62) {
          stage.classList.toggle(compactClass, cam.scale < 0.62);
        }

        const picked = selectedRef.current;
        for (const agent of engine.agents) {
          const el = agentRefs.current.get(agent.id);
          if (!el) continue;

          el.style.transform = `translate3d(${(agent.x + 0.5 + agent.jitter) * TILE}px, ${
            (agent.y + 0.9) * TILE
          }px, 0)`;
          el.style.zIndex = String(200 + Math.round(agent.y));

          const cls = cx("ag", `f-${agent.facing}`, "a-sit", `r-${agent.rank}`, agent.id === picked && "selected");
          if (el.className !== cls) el.className = cls;

          const bubble = el.firstElementChild as HTMLElement;
          const text = agent.speech ?? "";
          if (bubble.dataset.text !== text) {
            bubble.dataset.text = text;
            bubble.textContent = text;
            bubble.className = cx("ag-bubble", text && "on");
          }
        }
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  // No pointer capture: capturing would swallow clicks on the HUD and on staff.
  const onPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-world-hud]")) return;
    dragRef.current = { on: true, px: e.clientX, py: e.clientY, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag.on) return;
    const dx = e.clientX - drag.px;
    const dy = e.clientY - drag.py;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    drag.px = e.clientX;
    drag.py = e.clientY;
    const scale = camRef.current.scale || 1;
    targetRef.current = {
      ...targetRef.current,
      x: clamp(targetRef.current.x - dx / scale, 0, WORLD_W),
      y: clamp(targetRef.current.y - dy / scale, 0, WORLD_H),
    };
  };
  const onPointerUp = () => {
    dragRef.current.on = false;
    window.setTimeout(() => {
      dragRef.current.moved = false;
    }, 0);
  };

  const roomName = (id: string) => engine.roomName(id);

  return (
    <div className={cx("world-frame")} data-testid="agent-office-world">
      <div
        className={cx("world-viewport")}
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <div className={cx("world-stage")} ref={stageRef} style={{ width: WORLD_W, height: WORLD_H }}>
          <div className={cx("world-floor")} />

          {ROOMS.map((room) => {
            const isAmux = room.kind === "amux";
            const isReview = room.kind === "review";
            const isDecision = room.kind === "decision";
            const real = isAmux ? amux : isReview ? review : isDecision ? decision : null;
            const liveDept = real ? null : engine.liveDept(room.id);
            // Every room that reads a record links it: a team room while it is live.
            const recordHref = isAmux
              ? AGENT_OFFICE_AMUX_RECORD_HREF
              : isDecision
                ? AGENT_OFFICE_DECISION_RECORD_HREF
                : liveDept
                  ? (agentOfficeDept(room.id)?.recordHref ?? null)
                  : null;
            const recordLabel = isAmux ? m.rooms.amuxRecord : isDecision ? m.rooms.decisionRecord : m.rooms.recordOf(roomName(room.id));
            const recordTitle = real ? real.summary : (liveDept?.line ?? "");
            const status = real ? real.status : snap.deptStatus[room.id];
            return (
              <div
                key={room.id}
                className={cx("rm", `rm-${room.kind}`, status, hotRoom === room.id && "hot")}
                style={{
                  left: room.x * TILE,
                  top: room.y * TILE,
                  width: room.w * TILE,
                  height: room.h * TILE,
                }}
              >
                <span className={cx("rm-head")}>
                  <b>
                    {room.icon}{" "}
                    {isAmux ? m.rooms.amux : isReview ? m.rooms.review : isDecision ? m.rooms.decision : roomName(room.id)}
                  </b>
                  {real || engine.liveDept(room.id) ? <em className={cx("live-chip")}>{m.real.chip}</em> : null}
                  {status ? (
                    <i
                      className={cx("rm-dot", status)}
                      title={real ? real.summary : (engine.liveDept(room.id)?.badge ?? m.deptStatus[status])}
                    />
                  ) : null}
                  {recordHref ? (
                    <Link
                      href={recordHref}
                      className={cx("rm-link")}
                      aria-label={recordLabel}
                      title={recordTitle}
                      data-testid={`agent-office-${room.id}-record`}
                    >
                      ↗
                    </Link>
                  ) : null}
                </span>
                <span className={cx("rm-code")}>{room.short}</span>
                {real?.note ? (
                  <span className={cx("rm-note")} data-testid={`agent-office-${room.id}-note`}>
                    {real.note}
                  </span>
                ) : null}
                {room.doors.map((door) => (
                  <span
                    key={`${door.x}-${door.y}`}
                    className={cx("rm-door")}
                    style={{ left: (door.x - room.x) * TILE, top: (door.y - room.y) * TILE }}
                  />
                ))}
              </div>
            );
          })}

          <PropLayer screenLabel={m.rooms.screen} entranceLabel={m.rooms.entrance} />
          <SeatedLayer room={AMUX_ROOM} kind="amux" people={amux.workers} onPick={onPickSeated} />
          <SeatedLayer room={REVIEW_ROOM} kind="review" people={review.reviewers} onPick={onPickSeated} />
          <SeatedLayer room={DECISION_ROOM} kind="decision" people={decision.members} onPick={onPickSeated} />
          <AgentLayer
            agents={engine.agents}
            register={register}
            onPick={onPick}
            leadLabel={m.world.lead}
            operatorLabel={m.world.operator}
          />
        </div>

        <div className={cx("world-hud")} data-world-hud="">
          <button type="button" className={cx(zoom === "fit" && "on")} onClick={() => setZoom("fit")}>
            {m.world.fit}
          </button>
          <button type="button" className={cx(zoom === "close" && "on")} onClick={() => setZoom("close")}>
            {m.world.close}
          </button>
        </div>
        <div className={cx("world-hint")}>{m.world.hint}</div>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
