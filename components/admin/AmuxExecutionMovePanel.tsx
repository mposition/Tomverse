
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, Clock3, AlertCircle, ShieldCheck } from "lucide-react";
import { adminFetch } from "@/lib/adminFetch";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { useAdminMessages } from "./AdminLocaleProvider";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import styles from "./AmuxExecutionWorkspace.module.css";

export type AmuxBoardMove = { taskId: string; requestId: string; readOnly: boolean };
type MoveResult = { state?: "promoted" | "outcome_unknown" | "not_found";
  code?: string; error?: string; reason?: string; taskId?: string; receiptId?: string; requestId?: string };
export function AmuxExecutionMovePanel({ move, onWriteStarting, onMoved,
  onKnownRefusal }: {
  move: AmuxBoardMove; onWriteStarting: () => boolean;
  onMoved: () => void; onKnownRefusal: () => void;
}) {
  const m = useAdminMessages(adminAmuxExecutionMessages);
  const [phase, setPhase] = useState<"reading" | "applying" | "done" | "refused" | "unknown" | "reauth">("reading");
  const [code, setCode] = useState("");
  const [revision, setRevision] = useState<number | null>(null);
  const [writeAttempted, setWriteAttempted] = useState(false);
  const sent = useRef(false);
  const generation = useRef(0);
  const onWriteStartingRef = useRef(onWriteStarting);
  const onMovedRef = useRef(onMoved);
  const onRefusedRef = useRef(onKnownRefusal);
  useEffect(() => { onWriteStartingRef.current = onWriteStarting; },
    [onWriteStarting]);
  useEffect(() => { onMovedRef.current = onMoved; }, [onMoved]);
  useEffect(() => { onRefusedRef.current = onKnownRefusal; }, [onKnownRefusal]);

  const readback = async (current: number) => {
    try {
      const params = new URLSearchParams({ taskId: move.taskId, requestId: move.requestId });
      const response = await adminFetch("/api/admin/amux/execution-move?" + params, { cache: "no-store" });
      if (current !== generation.current) return;
      if (response.status === 428) { setPhase("reauth"); return; }
      const result = await response.json() as MoveResult;
      if (current !== generation.current) return;
      if (response.ok && result.state === "promoted" && result.taskId === move.taskId) {
        setPhase("done"); onMovedRef.current(); return;
      }
      setCode(result.code ?? result.state ?? "readback_unavailable");
      setPhase("unknown");
    } catch { if (current === generation.current) { setCode("readback_unavailable"); setPhase("unknown"); } }
  };

  useEffect(() => {
    let cancelled = false;
    const current = ++generation.current;
    queueMicrotask(() => {
      if (cancelled || sent.current) return;
      sent.current = true;
      void (async () => {
        const obsolete = () => cancelled || current !== generation.current;
        if (move.readOnly) { await readback(current); return; }
        // Fetching the card is preparation only. A lost write is followed by
        // one read-back, never by another POST.
        let attempted = false;
        try {
          const detail = await adminFetch("/api/admin/amux/execution-view?view=detail&taskId=" +
            encodeURIComponent(move.taskId), { cache: "no-store" });
          if (obsolete()) return;
          if (detail.status === 428) { onRefusedRef.current(); setPhase("reauth"); return; }
          if (!detail.ok) { onRefusedRef.current(); setCode("detail_unavailable"); setPhase("refused"); return; }
          const card = await detail.json() as { id: string; revision: number; status: string };
          if (obsolete()) return;
          if (card.id !== move.taskId || !Number.isSafeInteger(card.revision) ||
              card.revision < 0 || card.status !== "backlog") {
            onRefusedRef.current(); setCode("task_changed"); setPhase("refused"); return;
          }
          setRevision(card.revision); setPhase("applying");
          if (obsolete() || !onWriteStartingRef.current()) return;
          attempted = true; setWriteAttempted(true);
          const response = await adminFetch("/api/admin/amux/execution-move", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId: move.taskId,
              expectedRevision: card.revision, requestId: move.requestId }),
          });
          if (obsolete()) return;
          if (response.status === 428) { onRefusedRef.current(); setWriteAttempted(false); setPhase("reauth"); return; }
          const result = await response.json() as MoveResult;
          if (obsolete()) return;
          if (response.ok && result.state === "promoted" && result.taskId === move.taskId) {
            setPhase("done"); onMovedRef.current(); return;
          }
          if (result.state === "outcome_unknown" || result.code === "outcome_unknown" ||
              result.error === "outcome_unknown" ||
              (response.status >= 500 && result.error !== "candidate_unavailable")) {
            await readback(current); return;
          }
          onRefusedRef.current(); setCode(result.code ?? result.error ?? result.reason ?? "move_refused"); setPhase("refused");
        } catch {
          if (obsolete()) return;
          if (attempted) await readback(current);
          else { onRefusedRef.current(); setCode("detail_unavailable"); setPhase("refused"); }
        }
      })();
    });
    return () => { cancelled = true; generation.current += 1; };
    // The request is bound for this mount. No dependency may replay a POST.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [move.taskId, move.requestId, move.readOnly]);

  const preparing = phase === "reading" || phase === "applying";
  const currentReason = Object.prototype.hasOwnProperty.call(m.moveReasons, code)
    ? m.moveReasons[code as keyof typeof m.moveReasons] : m.moveRefused;
  return <div className={styles.detail} data-testid="amux-move-progress" aria-busy={preparing}>
    <header className={styles.detailHeader}><h3>{m.moveTitle}</h3>
      <p>{move.taskId}</p></header>
    <div className={styles.summary}><span>{m.lane.tomverse_backlog}</span>
      <ArrowRight size={18} aria-hidden="true" /><span>{m.lane.amux_backlog}</span></div>
    <p className={styles.hint}>{m.moveScope}</p>
    <ol className={styles.panel}>
      <li>{revision !== null ? <CheckCircle2 size={16} aria-hidden="true" /> :
        <Clock3 size={16} aria-hidden="true" />} {m.moveBinding}
        {revision !== null ? " · r" + revision : ""}</li>
      <li><ShieldCheck size={16} aria-hidden="true" /> {m.moveChecks}</li>
      <li role={phase === "refused" || phase === "unknown" || phase === "reauth" ? "alert" : "status"}>
        {phase === "done" ? <><CheckCircle2 size={16} aria-hidden="true" /> {m.moveDone}</> :
          preparing ? <><Clock3 size={16} aria-hidden="true" /> {phase === "reading" ? m.moveReading : m.moveApplying}</> :
          phase === "reauth" ? <Link href={adminRecentAuthenticationHref(
            "/admin/amux-execution?tab=cards&taskId=" + encodeURIComponent(move.taskId) +
            (move.readOnly || writeAttempted ? "&moveRequest=" + encodeURIComponent(move.requestId) : ""))}>{m.reauth}</Link> :
          <><AlertCircle size={16} aria-hidden="true" /> {phase === "unknown" ? m.moveUnknown : currentReason}</>}
      </li>
    </ol>
    {phase === "unknown" && <button type="button" className={styles.button}
      onClick={() => { setPhase("reading"); void readback(generation.current); }}>{m.moveReadback}</button>}
    <p className={styles.hint}>{m.moveReceipt} <code>{move.requestId}</code></p>
  </div>;
}

