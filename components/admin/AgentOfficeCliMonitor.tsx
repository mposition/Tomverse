"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minimize2, Pause, Play, Search, X } from "lucide-react";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useModalDialog } from "@/components/useModalDialog";
import { adminFetch, isAdminFetchAbort } from "@/lib/adminFetch";
import { shouldIssueAdminPoll } from "@/lib/adminPollTick";
import { describeAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminAgentOfficeCliMessages } from "@/lib/adminMessages/agentOfficeCliMonitor";
import { AGENT_OFFICE_CLI_POLL_MS, AGENT_OFFICE_CLI_WORKER,
  type AgentOfficeCliReading } from "@/lib/agentOfficeCliMonitorCore";
import { aestStamp } from "@/lib/agentOffice/time";
import styles from "./agentOfficeCliMonitor.module.css";

export default function AgentOfficeCliMonitor({ onClose, avatar }: { onClose: () => void; avatar?: ReactNode }) {
  const m = useAdminMessages(adminAgentOfficeCliMessages);
  const { locale } = useAdminLocale();
  const [reading, setReading] = useState<AgentOfficeCliReading | null>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [accessBlocked, setAccessBlocked] = useState(false);
  const [paused, setPaused] = useState(false);
  const [following, setFollowing] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [tab, setTab] = useState<"transcript" | "raw">("transcript");
  const [query, setQuery] = useState("");
  const [retry, setRetry] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const collapse = useCallback(() => setExpanded(false), []);
  const modal = expanded || mobile;
  useModalDialog({ open: modal, dialogRef: panelRef, panelRef,
    initialFocusRef: closeRef, onClose: expanded ? collapse : onClose });

  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (paused) return;
    let disposed = false;
    let inFlight = false;
    let blocked = false;
    const controller = new AbortController();
    const poll = async (trigger: "interval" | "event") => {
      if (blocked || !shouldIssueAdminPoll({ inFlight,
        documentVisible: document.visibilityState === "visible", trigger })) return;
      inFlight = true;
      try {
        const response = await adminFetch(`/api/admin/office/cli-monitor?worker=${AGENT_OFFICE_CLI_WORKER}`,
          { cache: "no-store", signal: controller.signal, timeoutMs: 10_000 });
        if (disposed) return;
        if (!response.ok) {
          if ([401, 403, 404, 428].includes(response.status)) {
            blocked = true;
            setAccessBlocked(true);
            setReading(null);
          } else setAccessBlocked(false);
          setFailure(describeAdminApiFailure({ status: response.status, fallback: m.failed, locale }));
          return;
        }
        const next = await response.json() as AgentOfficeCliReading;
        if (disposed) return;
        setReading(next);
        setAccessBlocked(false);
        setFailure(null);
      } catch (error) {
        if (!disposed && !isAdminFetchAbort(error)) setFailure(describeAdminApiFailure({
          status: 0, fallback: m.failed, locale,
        }));
      } finally { inFlight = false; }
    };
    void poll("event");
    const timer = window.setInterval(() => void poll("interval"), AGENT_OFFICE_CLI_POLL_MS);
    const visible = () => { if (document.visibilityState === "visible") void poll("event"); };
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; controller.abort(); window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible); };
  }, [paused, retry, locale, m.failed]);

  const snapshot = reading?.snapshot;
  useEffect(() => {
    if (following && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [snapshot, following, tab]);
  const state = accessBlocked ? "unavailable" : failure ? "stale" : reading?.state;
  const label = failure?.requiresReauthentication ? m.authenticationRequired : accessBlocked ? m.accessUnavailable :
    paused ? m.paused : state === "live" ? m.live : state === "stale" ? m.stale : m.unavailable;
  const events = (snapshot?.events ?? []).filter(event => !query || event.text.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className={modal ? styles.backdrop : styles.docked} onMouseDown={event => {
      if (event.target === event.currentTarget) { if (expanded) collapse(); else onClose(); }
    }}>
    <section ref={panelRef} className={`${styles.monitor} ${expanded ? styles.expanded : ""}`}
      role={modal ? "dialog" : "region"} aria-modal={modal || undefined}
      aria-labelledby="office-cli-title" data-testid="agent-office-cli-monitor"
      onKeyDown={event => { if (event.key === "Escape" && !modal) { event.stopPropagation(); onClose(); } }}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={styles.avatar} aria-hidden="true">{avatar ?? ">_"}</span>
          <h2 id="office-cli-title">{AGENT_OFFICE_CLI_WORKER}</h2>
          <span className={styles.status} data-state={paused ? "paused" : state ?? "unavailable"}>{label}</span>
          <div className={styles.windowControls}>
            <button type="button" onClick={() => setExpanded(!expanded)} aria-label={expanded ? m.collapse : m.expand}>
              {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </button>
            <button ref={closeRef} type="button" onClick={onClose} aria-label={m.close}><X size={18} /></button>
          </div>
        </div>
        <div className={styles.meta}><span>{m.room}</span><span className={styles.readOnly}>{m.readOnly}</span></div>
        <div className={styles.meta}>
          <select aria-label={m.session} value="current" onChange={() => {}}><option value="current">{m.current}</option></select>
          {snapshot ? <span>{m.captured} {aestStamp(snapshot.capturedAt)}</span> : null}
        </div>
      </header>
      <div className={styles.toolbar}>
        <div role="tablist" aria-label={m.title}>
          <button type="button" role="tab" aria-selected={tab === "transcript"} aria-controls="office-cli-log" id="office-cli-transcript-tab" onClick={() => setTab("transcript")}>{m.transcript}</button>
          <button type="button" role="tab" aria-selected={tab === "raw"} aria-controls="office-cli-log" id="office-cli-raw-tab" onClick={() => setTab("raw")}>{m.raw}</button>
        </div>
        <button type="button" onClick={() => setPaused(!paused)} aria-pressed={paused}>
          {paused ? <Play size={13} /> : <Pause size={13} />}{paused ? m.resume : m.pause}
        </button>
      </div>
      <label className={styles.search}><Search size={14} aria-hidden="true" />
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={m.find} aria-label={m.find} />
      </label>
      {failure ? <AdminApiFailureNotice failure={failure} onRetry={() => setRetry(value => value + 1)} returnTo="/admin/office?tab=live" /> : null}
      <div ref={logRef} className={styles.log} id="office-cli-log" role="tabpanel"
        aria-labelledby={tab === "transcript" ? "office-cli-transcript-tab" : "office-cli-raw-tab"} tabIndex={0}
        onScroll={event => { const el = event.currentTarget; setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 48); }}>
        {!reading && !failure ? <p className={styles.empty} role="status">{m.loading}</p> : null}
        {reading && !snapshot ? <p className={styles.empty}>{m.noCapture}</p> : null}
        {snapshot && tab === "transcript" && events.length === 0 ? <p className={styles.empty}>{m.empty}</p> : null}
        {snapshot && tab === "transcript" ? events.map((event, index) => (
          <div className={styles.event} data-kind={event.kind} key={`${index}-${event.kind}`}>
            <span>{m.labels[event.kind]}</span><pre>{event.text}</pre>
          </div>
        )) : null}
        {snapshot && tab === "raw" ? <pre>{!query || snapshot.rawOutput.toLowerCase().includes(query.toLowerCase()) ? snapshot.rawOutput : m.empty}</pre> : null}
      </div>
      <div className={styles.follow}>
        <span>{paused ? m.paused : state !== "live" ? label : following ? m.following : m.followPaused}</span>
        {!following ? <button type="button" onClick={() => setFollowing(true)}>{m.latest} ↓</button> : null}
        {snapshot?.truncated ? <span>{m.truncated}</span> : null}
      </div>
      <footer className={styles.footer}><p>{m.footer}</p><small>{m.masking}</small></footer>
    </section>
    </div>
  );
}
