"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { shouldIssueAdminPoll, type AdminPollTrigger } from "@/lib/adminPollTick";
import { adminCiAdmissionMessages } from "@/lib/adminMessages/ciAdmission";
import type { CiRunnerUsage } from "@/lib/ciRunnerUsage";
import {
  CI_ADMISSION_MAX_CAPACITY,
  ciRunnerCount,
  type CiAdmissionEntryStatus,
  type CiAdmissionEvent,
  type CiAdmissionMode,
  type CiAdmissionQueueEntry,
  type CiAdmissionState,
  type CiRunnerOwner,
} from "@/lib/ciAdmissionCore";
import { ciFixRetryable, ciFixState, type CiFixState, type CiFixView } from "@/lib/ciAdmissionFixCore";

/** `fix` is absent from a server older than the auto-fix view. */
export type CiAdmissionView = { mode: CiAdmissionMode; configured: boolean; state: CiAdmissionState; fix?: CiFixView };
type View = CiAdmissionView;

const RUNNER_REFRESH_MS = 20_000;
const VIEW_REFRESH_MS = 20_000;
const SLOW_ACTION_TIMEOUT_MS = 60_000;

/**
 * Who holds GitHub runners right now (lib/ciRunnerUsage.ts), read again every
 * 20 seconds while the page is visible and at once when it becomes visible
 * again; null until the first answer. The server shares one cached read among
 * all viewers. A read GitHub failed keeps the last good reading on screen with
 * its failure, rather than swapping the cards for the latest round's record
 * and back (2026-10-25: the running cards came and went).
 */
function useRunnerUsage(): CiRunnerUsage | null {
  // Read after the page renders, so a slow GitHub read never holds the page.
  const [usage, setUsage] = useState<CiRunnerUsage | null>(null);
  const keep = (next: CiRunnerUsage) =>
    setUsage((previous) =>
      next.status === "unavailable" && previous?.status === "ok" ? { ...previous, failure: next.failure } : next,
    );
  useEffect(() => {
    let stopped = false;
    // One request at a time, none from a background tab's timer
    // (docs/ui-contracts/admin-console-ia.md rule 11).
    let inFlight = false;
    const poll = async (trigger: AdminPollTrigger) => {
      if (!shouldIssueAdminPoll({ inFlight, documentVisible: document.visibilityState === "visible", trigger })) return;
      inFlight = true;
      try {
        const response = await adminFetch("/api/admin/ci-admission/runners", { cache: "no-store" });
        if (response.ok && !stopped) keep((await response.json()) as CiRunnerUsage);
      } catch {
        // The next tick tries again; the last reading stays on screen.
      } finally {
        inFlight = false;
      }
    };
    const first = setTimeout(() => void poll("event"), 0);
    const refresh = setInterval(() => void poll("interval"), RUNNER_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll("event");
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return usage;
}

/** A reorder in progress: by pointer (mouse, pen, touch on the handle) or by keyboard. */
type Drag = {
  number: number;
  from: number;
  over: number;
  by: "pointer" | "keyboard";
  /** Pointer only: the rows' original vertical midpoints, the grab offset and the pointer's position, list-relative. */
  midpoints: number[];
  grabOffset: number;
  pointerY: number;
  rowHeight: number;
};

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));

const clock = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const PULL_URL = "https://github.com/mposition/Tomverse/pull/";
const FIX_BADGE: Record<CiFixState, string> = {
  analysing: "bg-amber-300/15 text-amber-300",
  sent: "bg-sky-400/15 text-sky-300",
  pushed: "bg-emerald-400/15 text-emerald-400",
  not_fixed: "bg-rose-400/15 text-rose-300",
  failed: "bg-rose-400/15 text-rose-300",
  refused: "bg-rose-400/15 text-rose-300",
  not_published: "bg-rose-400/15 text-rose-300",
  exhausted: "bg-rose-400/15 text-rose-300",
};
const COMMIT_URL = "https://github.com/mposition/Tomverse/commit/";
const PAGE_PATH = "/admin/qa-release?tab=ci-admission";

type Kind = "develop" | "main" | "hotfix";
const kindOf = (entry: Pick<CiAdmissionQueueEntry, "base" | "head">): Kind =>
  entry.base !== "main" ? "develop" : entry.head.startsWith("hotfix/") ? "hotfix" : "main";
const BADGE: Record<Kind, string> = {
  develop: "bg-blue-400/15 text-blue-300",
  main: "bg-violet-400/15 text-violet-300",
  hotfix: "bg-rose-400/15 text-rose-300",
};
const SLOT: Record<Kind, string> = {
  develop: "border-blue-400/50 bg-blue-400/10",
  main: "border-violet-400/50 bg-violet-400/10",
  hotfix: "border-rose-400/50 bg-rose-400/10",
};
const EVENT_DOT: Record<CiAdmissionEvent["kind"], string> = {
  held: "bg-rose-400",
  released: "bg-emerald-400",
  admitted: "bg-emerald-400",
  dropped: "bg-zinc-500",
  cancelled: "bg-zinc-400",
  failed: "bg-amber-300",
  stopped: "bg-rose-400",
  updated: "bg-sky-400",
};

const STATUS_BADGE: Record<CiAdmissionEntryStatus, string> = {
  running: "bg-emerald-400/15 text-emerald-300",
  next: "bg-emerald-400/15 text-emerald-300",
  done: "bg-zinc-700/60 text-zinc-300",
  waiting: "bg-zinc-800 text-zinc-400",
  checking: "bg-zinc-800 text-zinc-400",
  conflict: "bg-amber-300/15 text-amber-300",
  behind: "bg-amber-300/15 text-amber-300",
  updating: "bg-sky-400/15 text-sky-300",
  hold: "bg-amber-300/15 text-amber-300",
  held: "bg-rose-400/15 text-rose-300",
};

/** One holder of runners in the running panel; `live` when its jobs were read from GitHub just now. */
type RunnerCard = { owner: CiRunnerOwner; kind: Kind; runners: number; handled: boolean; live?: false };

/** A card from the latest round's record, where no live jobs are known. */
const storedCard = (
  type: "deploy" | "pull" | "other",
  base: string | null,
  sha: string | null,
  number: number | null,
  title: string,
  runners: number,
  kind: Kind = base === "main" ? "main" : "develop",
): RunnerCard => ({
  owner: { key: `${type}:${number ?? sha ?? ""}`, title, number, base, sha, running: 0, queued: 0, startedAt: "" },
  kind,
  runners,
  handled: type !== "other",
  live: false,
});

/** Deploys first, then pull requests in line order, then everything else. */
const cardRank = (card: RunnerCard, order: readonly number[]) => {
  if (card.owner.number === null) return card.handled ? 0 : 1_000_000;
  const at = order.indexOf(card.owner.number);
  return 1 + (at < 0 ? order.length : at);
};

const moved = (order: number[], number: number, to: number) => {
  const rest = order.filter((n) => n !== number);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, number);
  return rest;
};

/**
 * Admin's CI admission line (lib/ciAdmissionCore.ts): who is using the slots,
 * every open pull request into develop or main in priority order, each with
 * where it stands -- rearranged by dragging the handle
 * (mouse, pen or touch) or from the keyboard -- the slot budget, and recent
 * decisions. A reorder is shown at once and saved; a refused save restores
 * the previous order.
 */
export function CiAdmissionSection({ initial, canWrite }: { initial: View; canWrite: boolean }) {
  const m = useAdminMessages(adminCiAdmissionMessages);
  const [view, setView] = useState<View>(initial);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reauthenticationRequired, setReauthenticationRequired] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [drag, setDrag] = useState<Drag | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // "Analyse again" asked in this page: the report shows the retry only once the server starts it.
  const [fixAsked, setFixAsked] = useState<ReadonlySet<number>>(() => new Set());
  const runnerUsage = useRunnerUsage();
  const listRef = useRef<HTMLOListElement>(null);
  const rowRefs = useRef(new Map<number, HTMLLIElement>());
  const handleRefs = useRef(new Map<number, HTMLButtonElement>());
  // A pointer drag follows the pointer on window: the dragged row turns into
  // the drop gap, so its handle leaves the DOM mid-drag.
  const dragRef = useRef<Drag | null>(null);
  const busyRef = useRef(false);
  const commitRef = useRef<(number: number, to: number) => void>(() => {});
  const pointerDragging = drag?.by === "pointer" ? drag.number : null;

  const load = useCallback(async () => {
    try {
      const response = await adminFetch("/api/admin/ci-admission", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      setView((await response.json()) as View);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    dragRef.current = drag;
    busyRef.current = busy;
  });

  useEffect(() => {
    if (pointerDragging === null) return;
    const onMove = (event: globalThis.PointerEvent) => {
      const current = dragRef.current;
      const list = listRef.current;
      if (!current || !list) return;
      const pointerY = event.clientY - list.getBoundingClientRect().top;
      // The target is how many of the other rows' original midpoints the pointer has passed.
      const over = current.midpoints.filter((mid, index) => index !== current.from && mid < pointerY).length;
      setDrag({ ...current, pointerY, over });
    };
    const onUp = () => {
      const current = dragRef.current;
      setDrag(null);
      if (current) commitRef.current(current.number, current.over);
    };
    const onCancel = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [pointerDragging]);

  // The line changes under webhooks: re-read it every 20 s, on the console's
  // refresh and when the tab comes back -- one request at a time, and never
  // over a drag or a save in progress.
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    const refresh = async (trigger: AdminPollTrigger) => {
      if (dragRef.current || busyRef.current) return;
      if (!shouldIssueAdminPoll({ inFlight, documentVisible: document.visibilityState === "visible", trigger })) return;
      inFlight = true;
      try {
        const response = await adminFetch("/api/admin/ci-admission", { cache: "no-store" });
        const next = response.ok ? ((await response.json()) as View) : null;
        if (next && !stopped && !dragRef.current && !busyRef.current) setView(next);
      } catch {
        // The next tick tries again; what is on screen stays.
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh("interval");
    }, VIEW_REFRESH_MS);
    const onRefresh = () => void refresh("event");
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh("event");
    };
    window.addEventListener("admin:refresh", onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("admin:refresh", onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const send = async (body: Record<string, unknown>, rollback?: View) => {
    setBusy(true);
    setNotice(null);
    setReauthenticationRequired(false);
    const restore = () => rollback && setView(rollback);
    try {
      const response = await adminFetch("/api/admin/ci-admission", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // A stop waits for a round already running; "Run a round now" waits for its own.
        timeoutMs: body.action === "stop" || body.action === "evaluate" ? SLOW_ACTION_TIMEOUT_MS : undefined,
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<View> & {
        code?: unknown;
        round?: { outcome?: string; failure?: string };
        stop?: { outcome?: string; cancelled?: number; failure?: string | null };
        fixAgain?: { outcome?: string; failure?: string };
      };
      if (response.status === 428 || payload.code === "ADMIN_REAUTHENTICATION_REQUIRED") {
        restore();
        setReauthenticationRequired(true);
        return;
      }
      if (response.status === 403) {
        restore();
        setNotice(m.forbidden);
        return;
      }
      if (response.status === 409) {
        setNotice(m.stale);
        await load();
        return;
      }
      if (!response.ok || !payload.state) {
        restore();
        // "The previous order is back" only where an order was put back.
        setNotice(rollback ? m.saveFailed : fill(m.requestFailed, { status: response.status }));
        return;
      }
      setView(payload as View);
      // What the server did beyond saving: a stop's result, or a round that
      // could not run. Silent before, which hid a missing App installation.
      const number = typeof body.number === "number" ? body.number : 0;
      const stop = payload.stop;
      const fixAgain = payload.fixAgain;
      if (fixAgain?.outcome === "requested") {
        setFixAsked((asked) => new Set(asked).add(number));
        setNotice(fill(m.fixAgainRequested, { number }));
      } else if (fixAgain?.outcome === "not_configured") {
        setNotice(m.fixAgainNotConfigured);
      } else if (fixAgain?.outcome === "failed") {
        setNotice(fill(m.fixAgainFailed, { number, failure: fixAgain.failure ?? "unknown" }));
      } else if (fixAgain) {
        setNotice(fill(m.fixAgainNotRetryable, { number }));
      } else if (stop?.outcome === "stopped") {
        setNotice(
          stop.failure
            ? fill(m.stoppedPartly, { number, failure: stop.failure })
            : fill(m.stopped, { number, cancelled: stop.cancelled ?? 0 }),
        );
      } else if (stop?.outcome === "failed") {
        setNotice(fill(m.stopFailed, { number, failure: stop.failure ?? "unknown" }));
      } else if (stop?.outcome === "not_handled") {
        setNotice(fill(m.stopNotHandled, { number }));
      } else if (stop?.outcome === "not_found") {
        setNotice(fill(m.stopNotFound, { number }));
      } else if (stop?.outcome === "not_configured") {
        setNotice(m.stopNotConfigured);
      } else if (payload.round?.outcome === "read_failed") {
        setNotice(fill(m.roundFailed, { failure: payload.round.failure ?? "unknown" }));
      } else if (payload.round?.outcome === "not_configured") {
        setNotice(m.roundNotConfigured);
      }
    } catch {
      restore();
      if (rollback) {
        setNotice(m.saveFailed);
      } else {
        // No answer is not a failure: the server may still be stopping it.
        // What it did shows in the line and the recent decisions.
        setNotice(m.noAnswer);
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const commit = (number: number, to: number) => {
    const order = view.state.queue.map((entry) => entry.number);
    const next = moved(order, number, to);
    if (next.every((n, i) => n === order[i])) return;
    const byNumber = new Map(view.state.queue.map((entry) => [entry.number, entry]));
    const before = view;
    // Shown at once; the server's answer replaces it, a refusal restores it.
    setView({ ...view, state: { ...view.state, queue: next.map((n) => byNumber.get(n)!) } });
    void send({ action: "reorder", order: next }, before);
    setAnnouncement(fill(m.dropped, { number, position: to + 1 }));
  };

  useEffect(() => {
    commitRef.current = commit;
  });

  if (failed) return <p className="text-sm text-amber-300">{m.loadFailed}</p>;

  const { state } = view;
  const order = state.queue.map((entry) => entry.number);
  const byNumber = new Map(state.queue.map((entry) => [entry.number, entry]));
  const preview = drag ? moved(order, drag.number, drag.over) : order;


  /* ---------- pointer ---------- */
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, number: number) => {
    if (!canWrite || busy || event.button !== 0 || !listRef.current) return;
    event.preventDefault();
    const listTop = listRef.current.getBoundingClientRect().top;
    const midpoints = order.map((n) => {
      const rect = rowRefs.current.get(n)?.getBoundingClientRect();
      return rect ? rect.top - listTop + rect.height / 2 : 0;
    });
    const row = rowRefs.current.get(number)?.getBoundingClientRect();
    const from = order.indexOf(number);
    setDrag({
      number,
      from,
      over: from,
      by: "pointer",
      midpoints,
      grabOffset: row ? event.clientY - row.top : 0,
      pointerY: event.clientY - listTop,
      rowHeight: row?.height ?? 64,
    });
  };

  /* ---------- keyboard ---------- */
  const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>, number: number) => {
    const pick = event.key === " " || event.key === "Enter";
    if (!drag) {
      if (!pick || busy || !canWrite) return;
      event.preventDefault();
      const from = order.indexOf(number);
      setDrag({ number, from, over: from, by: "keyboard", midpoints: [], grabOffset: 0, pointerY: 0, rowHeight: 0 });
      setAnnouncement(fill(m.pickedUp, { number, position: from + 1 }));
      return;
    }
    if (drag.by !== "keyboard" || drag.number !== number) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const over = Math.max(0, Math.min(order.length - 1, drag.over + (event.key === "ArrowUp" ? -1 : 1)));
      setDrag({ ...drag, over });
      setAnnouncement(fill(m.movedTo, { number, position: over + 1 }));
      // Keep focus on the handle as the row moves.
      requestAnimationFrame(() => handleRefs.current.get(number)?.focus());
    } else if (pick) {
      event.preventDefault();
      setDrag(null);
      commit(number, drag.over);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDrag(null);
      setAnnouncement(m.cancelled);
    }
  };

  /* ---------- pieces ---------- */
  const modePill =
    view.mode === "on" ? (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-2.5 py-1 text-xs font-medium text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        {m.modeOn}
      </span>
    ) : (
      <span className="rounded-full bg-amber-300/15 px-2.5 py-1 text-xs font-medium text-amber-300" title={view.mode === "shadow" ? m.modeShadowNote : m.modeOffNote}>
        {view.mode === "shadow" ? m.modeShadow : m.modeOff}
      </span>
    );
  const button =
    "inline-flex min-h-8 items-center justify-center rounded-lg border border-zinc-700 px-3 text-[13px] font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50";
  const minutes = (iso: string) => Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  // Runners each kind of CI needs (lib/ciAdmissionCore.ts), from the stored state.
  const unitsOf = (kind: Kind) => (kind === "develop" ? state.needs.develop : state.needs.main);
  const deployUnits = (branch: string) => (branch === "main" ? state.needs.mainPush : state.needs.developPush);
  const badgeText = (kind: Kind, n = unitsOf(kind)) => fill(kind === "develop" ? m.develop : kind === "hotfix" ? m.hotfix : m.main, { n });
  const pullKind = (number: number, base: string): Kind => {
    const entry = byNumber.get(number);
    return entry ? kindOf(entry) : base === "main" ? "main" : "develop";
  };
  // Who holds runners: read live from GitHub, counted as admission counts
  // them; until that reading arrives (or without the App), the latest round's.
  const live = runnerUsage?.status === "ok" ? runnerUsage : null;
  const cards: RunnerCard[] = live
    ? live.owners
        .map((owner): RunnerCard => {
          const handled = owner.base === "develop" || owner.base === "main";
          const kind = owner.number !== null && handled ? pullKind(owner.number, owner.base!) : owner.base === "main" ? "main" : "develop";
          const need = !handled ? 0 : owner.number !== null ? unitsOf(kind) : deployUnits(owner.base!);
          return { owner, kind, runners: ciRunnerCount(need, owner, now), handled };
        })
        // A pull request or deploy with a run in progress stays even between
        // its job waves, when it holds no runner for a few seconds.
        .filter((card) => card.runners > 0 || card.owner.number !== null || card.handled)
        .sort((a, b) => cardRank(a, order) - cardRank(b, order))
    : [
        ...(state.lastRound?.deploys ?? []).map((deploy) => storedCard("deploy", deploy.branch, deploy.sha, null, deploy.title, deploy.runners ?? deployUnits(deploy.branch))),
        ...(state.lastRound?.running ?? []).map((pull) => {
          const kind = pullKind(pull.number, pull.base);
          return storedCard("pull", pull.base, null, pull.number, pull.title, pull.runners ?? unitsOf(kind), kind);
        }),
        ...(state.lastRound?.others ? [storedCard("other", null, null, null, "", state.lastRound.others)] : []),
      ];
  const used = live ? cards.reduce((sum, card) => sum + card.runners, 0) : (state.lastRound?.used ?? 0);
  const free = Math.max(0, state.capacity - used);
  const statusText: Record<CiAdmissionEntryStatus, string> = {
    running: m.statusRunning,
    done: m.statusDone,
    next: m.statusNext,
    waiting: m.statusWaiting,
    conflict: m.statusConflict,
    behind: m.statusBehind,
    updating: m.statusUpdating,
    hold: m.statusHold,
    checking: m.statusChecking,
    held: m.statusHeld,
  };

  // A draft "next" in line whose latest release GitHub refused: each round
  // asks again and fails again, so say why rather than "being marked ready"
  // for ever (2026-10-25: #2968 and #2969 stayed "next" with runners free).
  const releaseFailure = new Map<number, string>();
  // Likewise a branch update GitHub refused: the line asks again only every
  // ten minutes, so "being updated" would stand all that while (2026-10-26:
  // a ruleset refused #3041's update for half an hour).
  const updateFailure = new Map<number, string>();
  for (const event of state.events) {
    if (event.kind === "released") releaseFailure.delete(event.number);
    else if (event.kind === "updated") updateFailure.delete(event.number);
    else if (event.kind === "failed" && event.detail?.startsWith("release:")) releaseFailure.set(event.number, event.detail.slice("release:".length));
    else if (event.kind === "failed" && event.detail?.startsWith("update_branch:")) updateFailure.set(event.number, event.detail.slice("update_branch:".length));
  }
  const failureOf = (entry: CiAdmissionQueueEntry) =>
    entry.status === "next" ? releaseFailure.get(entry.number) : entry.status === "updating" ? updateFailure.get(entry.number) : undefined;

  const rowBody = (entry: CiAdmissionQueueEntry, rank: number, floating: boolean) => {
    const kind = kindOf(entry);
    return (
      <>
        <span className="w-5 shrink-0 text-center font-mono text-sm font-medium text-zinc-400">{rank}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <a
            className="truncate text-sm font-medium text-zinc-100 hover:underline"
            href={`${PULL_URL}${entry.number}`}
            target="_blank"
            rel="noreferrer"
            tabIndex={floating ? -1 : undefined}
          >
            #{entry.number} {entry.title}
          </a>
          <span className="truncate font-mono text-xs text-zinc-400">
            {entry.head} · {entry.draft ? m.draft : m.ready} · {fill(m.waitedFor, { minutes: minutes(entry.queuedAt) })}
          </span>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
            failureOf(entry) ? "bg-rose-400/15 text-rose-300" : STATUS_BADGE[entry.status]
          }`}
          data-testid={floating ? undefined : `ci-admission-status-${entry.number}`}
          title={failureOf(entry)}
        >
          {failureOf(entry)
            ? fill(entry.status === "next" ? m.statusReleaseFailed : m.statusUpdateFailed, { failure: failureOf(entry)! })
            : statusText[entry.status]}
        </span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[kind]}`}>{badgeText(kind)}</span>
      </>
    );
  };

  // The CI auto-fix's try on each pull request's current head (lib/ciAdmissionFixCore.ts).
  const fix = view.fix;
  const fixPanel = (entry: CiAdmissionQueueEntry) => {
    const found = fix?.byPull[entry.number];
    const state = ciFixState(found, entry.headSha);
    if (!found || !state) return null;
    const retry = canWrite && ciFixRetryable(found, entry.headSha) && !fixAsked.has(entry.number);
    // A pushed fix moved the head on: the try's reason no longer describes the new head.
    const reason = state === "not_fixed" || state === "refused" || state === "sent" ? m.fixReason[found.reason ?? "none"] : null;
    const toCommits = state === "pushed" || state === "sent";
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-zinc-800 pt-2 pl-[3.25rem]" data-testid={`ci-admission-fix-${entry.number}`}>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${FIX_BADGE[state]}`} data-testid={`ci-admission-fix-state-${entry.number}`}>
          {m.fixKind[found.kind]} · {m.fixState[state]}
        </span>
        {reason ? <span className="min-w-0 text-xs text-zinc-300">{reason}</span> : null}
        <span className="font-mono text-[11px] text-zinc-500">
          {fill(m.fixAt, { minutes: minutes(found.at) })}
          {found.retried ? ` · ${m.fixRetried}` : ""}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <a
            className="text-xs font-medium text-zinc-400 hover:text-zinc-100"
            href={`${PULL_URL}${entry.number}/${toCommits ? "commits" : "checks"}`}
            target="_blank"
            rel="noreferrer"
          >
            {toCommits ? m.fixCommits : m.fixChecks} ↗
          </a>
          {retry ? (
            <button
              type="button"
              className={button}
              disabled={busy || drag !== null}
              aria-label={fill(m.fixAgainLabel, { number: entry.number })}
              onClick={() => void send({ action: "fix_again", number: entry.number })}
              data-testid={`ci-admission-fix-again-${entry.number}`}
            >
              {m.fixAgain}
            </button>
          ) : null}
        </span>
      </div>
    );
  };

  const draggedEntry = drag ? byNumber.get(drag.number) : undefined;

  return (
    <section className="flex flex-col gap-5 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-6" data-testid="ci-admission-section">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold text-zinc-100">{m.title}</h2>
        <span data-testid="ci-admission-mode">{modePill}</span>
        <button type="button" className={`${button} ml-auto`} disabled={!canWrite || busy} onClick={() => void send({ action: "evaluate" })}>
          {m.evaluate}
        </button>
      </div>
      <p className="-mt-2 text-[13px] text-zinc-400">{m.note}</p>
      {!view.configured && view.mode !== "off" ? <p className="text-sm text-amber-300">{m.notConfigured}</p> : null}

      {/* Slots */}
      <div className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4" data-testid="ci-admission-slots">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-zinc-300">{m.running}</span>
          <span className="font-mono text-[13px] font-medium text-zinc-100" data-testid="ci-admission-used">
            {fill(m.slotsUsed, { used, capacity: state.capacity })}
          </span>
          {live ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
              <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />
              {fill(m.runnerRefresh, { seconds: Math.max(0, Math.round((now - Date.parse(live.at)) / 1000)) })}
            </span>
          ) : state.lastRound ? (
            <span className="text-xs text-zinc-500">{fill(m.lastRound, { at: clock(state.lastRound.at) })}</span>
          ) : null}
          {runnerUsage?.status === "unavailable" || live?.failure ? (
            <span className="text-xs text-amber-300">
              {fill(m.runnerUnavailable, { failure: runnerUsage?.status === "unavailable" ? runnerUsage.failure : (live?.failure ?? "") })}
            </span>
          ) : null}
          <span className="ml-auto text-xs text-zinc-400">{m.budget}</span>
          <div className="inline-flex items-center rounded-lg border border-zinc-700">
            <button
              type="button"
              className="h-8 w-8 text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
              aria-label={m.decrease}
              disabled={!canWrite || busy || state.capacity <= 1}
              onClick={() => void send({ action: "set_capacity", capacity: state.capacity - 1 })}
            >
              −
            </button>
            <span className="w-10 text-center font-mono text-sm text-zinc-100" data-testid="ci-admission-capacity">
              {state.capacity}
            </span>
            <button
              type="button"
              className="h-8 w-8 text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
              aria-label={m.increase}
              disabled={!canWrite || busy || state.capacity >= CI_ADMISSION_MAX_CAPACITY}
              onClick={() => void send({ action: "set_capacity", capacity: state.capacity + 1 })}
            >
              +
            </button>
          </div>
        </div>
        {!live && state.lastRound === null ? (
          <p className="text-xs text-zinc-500">{m.noRound}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {cards.map(({ owner, kind, runners, handled, live: fresh }) => {
              const size = { flexGrow: runners, flexBasis: `${Math.max(8, runners / 2)}rem` };
              const jobs = fresh === false ? null : <span className="font-mono text-[11px] text-zinc-500">{fill(m.jobs, { running: owner.running, queued: owner.queued })}</span>;
              if (owner.number === null) {
                const sha = owner.sha ?? "";
                return handled ? (
                  <a
                    key={owner.key}
                    href={`${COMMIT_URL}${sha}`}
                    target="_blank"
                    rel="noreferrer"
                    className={`flex min-w-[10rem] flex-col gap-0.5 rounded-lg border border-dashed px-3 py-2.5 ${SLOT[kind]}`}
                    style={size}
                    data-testid={`ci-admission-deploy-${sha.slice(0, 7)}`}
                  >
                    <span className="truncate text-[13px] font-medium text-zinc-100">{owner.title || fill(m.deployTitle, { sha: sha.slice(0, 7) })}</span>
                    <span className="font-mono text-[11px] text-zinc-400">
                      {fill(m.deploy, { branch: owner.base ?? "", units: runners })} · {sha.slice(0, 7)}
                    </span>
                    {jobs}
                  </a>
                ) : (
                  <div key={owner.key} className="flex min-w-[8rem] flex-col gap-0.5 rounded-lg border border-zinc-700 bg-zinc-800/40 px-3 py-2.5" style={size}>
                    <span className="truncate text-[13px] font-medium text-zinc-300">{owner.title || m.otherTitle}</span>
                    <span className="font-mono text-[11px] text-zinc-400">{fill(m.other, { n: runners })}</span>
                    {jobs}
                  </div>
                );
              }
              const number = owner.number;
              return (
                <div
                  key={owner.key}
                  className={`flex min-w-[10rem] items-start gap-2 rounded-lg border px-3 py-2.5 ${handled ? SLOT[kind] : "border-zinc-700 bg-zinc-800/40"}`}
                  style={size}
                  data-testid={`ci-admission-running-${number}`}
                >
                  <a href={`${PULL_URL}${number}`} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[13px] font-medium text-zinc-100 hover:underline">
                      #{number} {owner.title}
                    </span>
                    <span className="font-mono text-[11px] text-zinc-400">{handled ? badgeText(kind, runners) : fill(m.other, { n: runners })}</span>
                    {jobs}
                  </a>
                  {canWrite && handled ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-md border border-rose-400/40 px-2 py-1 text-[11px] font-medium text-rose-300 hover:bg-rose-400/10 disabled:opacity-50"
                      disabled={busy}
                      aria-label={fill(m.stopLabel, { number })}
                      title={fill(m.stopLabel, { number })}
                      onClick={() => {
                        if (window.confirm(fill(m.stopConfirm, { number }))) {
                          void send({ action: "stop", number });
                        }
                      }}
                    >
                      {m.stop}
                    </button>
                  ) : null}
                </div>
              );
            })}
            {free > 0 ? (
              <div
                className="flex min-w-[8rem] flex-col gap-0.5 rounded-lg border border-dashed border-zinc-700 px-3 py-2.5"
                style={{ flexGrow: free, flexBasis: `${Math.max(8, free / 2)}rem` }}
              >
                <span className="text-[13px] font-medium text-zinc-500">{m.emptySlot}</span>
                <span className="text-[11px] text-zinc-500">{fill(m.emptySlotNote, { count: free })}</span>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {reauthenticationRequired ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-300">
          {m.reauthenticationRequired}
          <a className="font-medium underline" href={adminRecentAuthenticationHref(PAGE_PATH)}>
            {m.signInAgain}
          </a>
        </p>
      ) : null}
      {notice ? (
        <p className="text-sm text-amber-300" role="status">
          {notice}
        </p>
      ) : null}

      {/* Line */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-bold text-zinc-100">{m.waitingTitle}</h3>
          <span className="font-mono text-sm text-zinc-400">{state.queue.length}</span>
          {state.queue.length > 1 ? <span className="ml-auto text-xs text-zinc-500">{m.hint}</span> : null}
        </div>
        {fix ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-zinc-800/40 px-3 py-2 text-xs" data-testid="ci-admission-fix-summary" title={m.fixNote}>
            <span className="font-medium text-zinc-100">{m.fixTitle}</span>
            <span className={fix.connected ? "text-emerald-400" : "text-rose-300"}>
              {fix.connected && fix.receivedAt ? fill(m.fixConnected, { minutes: minutes(fix.receivedAt) }) : m.fixDisconnected}
            </span>
            <span className="text-zinc-300">
              {fix.claude?.remainingPercent != null ? fill(m.fixQuota, { percent: Math.round(fix.claude.remainingPercent) }) : m.fixQuotaUnknown}
            </span>
            {fix.queuedLastHour !== null ? <span className="text-zinc-300">{fill(m.fixQueued, { count: fix.queuedLastHour })}</span> : null}
          </div>
        ) : null}
        {state.queue.length === 0 ? (
          <p className="text-sm text-zinc-400">{m.empty}</p>
        ) : (
          <>
            <ol ref={listRef} className="relative flex flex-col gap-2" data-testid="ci-admission-queue">
              {preview.map((number, index) => {
                const entry = byNumber.get(number)!;
                const isDragged = drag?.number === number;
                if (isDragged && drag.by === "pointer") {
                  return (
                    <li
                      key={number}
                      ref={(node) => {
                        if (node) rowRefs.current.set(number, node);
                      }}
                      className="flex items-center justify-center rounded-xl border-[1.5px] border-dashed border-blue-400 bg-blue-400/5 text-xs font-medium text-blue-400"
                      style={{ height: drag.rowHeight }}
                      aria-hidden
                    >
                      {fill(m.dropHere, { rank: index + 1 })}
                    </li>
                  );
                }
                return (
                  <li
                    key={number}
                    ref={(node) => {
                      if (node) rowRefs.current.set(number, node);
                      else rowRefs.current.delete(number);
                    }}
                    className={`flex flex-col gap-2 rounded-xl border bg-zinc-950 p-3 transition-shadow ${
                      isDragged
                        ? "border-blue-400 shadow-[0_12px_28px_rgba(0,0,0,0.55)] ring-1 ring-blue-400"
                        : entry.status === "running" || entry.status === "next"
                          ? "border-emerald-400/60"
                          : "border-zinc-800"
                    }`}
                    data-testid={`ci-admission-row-${number}`}
                  >
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        ref={(node) => {
                          if (node) handleRefs.current.set(number, node);
                          else handleRefs.current.delete(number);
                        }}
                        className="flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-zinc-500 hover:text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 active:cursor-grabbing"
                        aria-label={fill(m.handle, { number })}
                        aria-pressed={isDragged}
                        disabled={!canWrite || (busy && !isDragged)}
                        onPointerDown={(event) => onPointerDown(event, number)}
                        onKeyDown={(event) => onHandleKey(event, number)}
                        onBlur={() => {
                          // Moving a row moves its handle in the DOM, which blurs it for
                          // a moment; only a focus that really went elsewhere cancels.
                          requestAnimationFrame(() => {
                            const current = dragRef.current;
                            if (current?.by !== "keyboard" || current.number !== number) return;
                            if (document.activeElement === handleRefs.current.get(number)) return;
                            setDrag(null);
                            setAnnouncement(m.cancelled);
                          });
                        }}
                        data-testid={`ci-admission-handle-${number}`}
                      >
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                          {[5, 10, 15].flatMap((cy) => [7, 13].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.5" />))}
                        </svg>
                      </button>
                      {rowBody(entry, index + 1, false)}
                      {index > 0 ? (
                        <button
                          type="button"
                          className={button}
                          disabled={!canWrite || busy || drag !== null}
                          onClick={() => void send({ action: "move_top", number })}
                        >
                          {m.moveTop}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="min-h-8 rounded-lg px-2 text-[13px] font-medium text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
                        disabled={!canWrite || busy || drag !== null}
                        onClick={() => void send({ action: "move_bottom", number })}
                      >
                        {m.remove}
                      </button>
                    </div>
                    {fixPanel(entry)}
                  </li>
                );
              })}
              {drag?.by === "pointer" && draggedEntry ? (
                <li
                  className="pointer-events-none absolute inset-x-0 z-10 flex -rotate-[0.6deg] items-center gap-3 rounded-xl border-2 border-blue-400 bg-zinc-900 p-3 shadow-[0_12px_28px_rgba(0,0,0,0.55)]"
                  style={{ top: drag.pointerY - drag.grabOffset }}
                  aria-hidden
                >
                  <span className="flex h-8 w-6 shrink-0 items-center justify-center text-zinc-400">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                      {[5, 10, 15].flatMap((cy) => [7, 13].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.5" />))}
                    </svg>
                  </span>
                  {rowBody(draggedEntry, drag.over + 1, true)}
                </li>
              ) : null}
            </ol>
            <p className="text-xs text-zinc-500">{m.removeNote}</p>
          </>
        )}
        <p className="sr-only" aria-live="assertive">
          {announcement}
        </p>
      </div>

      {/* Decisions */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-bold text-zinc-100">{m.eventsTitle}</h3>
        {state.events.length === 0 ? (
          <p className="text-sm text-zinc-400">{m.eventsEmpty}</p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-xs" data-testid="ci-admission-events">
            {[...state.events]
              .reverse()
              .slice(0, 15)
              .map((event, index) => (
                <li key={`${event.at}-${event.number}-${index}`} className="flex flex-wrap items-center gap-2.5">
                  <span className="font-mono text-zinc-500">{clock(event.at)}</span>
                  <span className={`h-1.5 w-1.5 rounded-full ${EVENT_DOT[event.kind]}`} />
                  <span className="font-mono font-medium text-zinc-300">#{event.number}</span>
                  <span className="text-zinc-300">
                    {
                      {
                        held: m.eventHeld,
                        released: m.eventReleased,
                        admitted: m.eventAdmitted,
                        dropped: m.eventDropped,
                        cancelled: m.eventCancelled,
                        failed: m.eventFailed,
                        stopped: m.eventStopped,
                        updated: m.eventUpdated,
                      }[event.kind]
                    }
                  </span>
                  {event.detail ? <span className="text-zinc-500">{event.detail}</span> : null}
                  {event.shadow ? <span className="rounded bg-amber-300/10 px-1 text-amber-300">{m.shadowTag}</span> : null}
                </li>
              ))}
          </ul>
        )}
      </div>
    </section>
  );
}
