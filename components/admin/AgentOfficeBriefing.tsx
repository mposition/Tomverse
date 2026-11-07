"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { cn } from "@/components/admin/AgentOfficeFloor";
import s from "@/components/admin/agentOfficeFloor.module.css";
import { useAdminLocale } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import type { AdminMessageShape } from "@/lib/adminLocale";
import type { AgentOfficeFloorCopy } from "@/lib/adminMessages/agentOfficeFloor";
import { BRIEFING_LINKS, type StoredAgentOfficeBriefing } from "@/lib/agentOffice/briefing";
import { aestClock } from "@/lib/agentOffice/time";

type FloorCopy = AdminMessageShape<AgentOfficeFloorCopy>;
type Status = { enabled: boolean; modelId: string; usedToday: number; limit: number; latest: StoredAgentOfficeBriefing | null };
type Notice = "off" | "model_unavailable" | "limit" | "busy" | "failed" | "reauth" | "unread" | "reused" | null;

const ENDPOINT = "/api/admin/office/briefing";

/**
 * The owner's AI briefing card. Hidden for anyone else (the endpoint answers
 * 404). Asking may be one paid model call within the day's limit; the answer
 * is text with links to the screens the office already links.
 */
export default function AgentOfficeBriefing({ f }: { f: FloorCopy }) {
  const { locale } = useAdminLocale();
  const [status, setStatus] = useState<Status | null>(null);
  const [hidden, setHidden] = useState(false);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  // Bumped after each ask, so the card reads the count and the answer again.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    adminFetch(ENDPOINT, { cache: "no-store", credentials: "same-origin" })
      .then(async (res) => {
        if (!alive) return;
        if (res.status === 404) setHidden(true);
        else if (!res.ok) setNotice("unread");
        else {
          const body = (await res.json()) as Status;
          if (alive) setStatus(body);
        }
      })
      .catch(() => {
        if (alive) setNotice("unread");
      });
    return () => {
      alive = false;
    };
  }, [version]);

  const ask = async () => {
    setAsking(true);
    setNotice(null);
    try {
      const res = await adminFetch(ENDPOINT, {
        method: "POST",
        // The office read (20 s at most) and the model call (45 s at most).
        timeoutMs: 75_000,
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: locale === "ko" ? "ko" : "en" }),
      });
      if (res.status === 428) setNotice("reauth");
      else {
        const body = (await res.json().catch(() => null)) as { kind?: string } | null;
        const kind = body?.kind;
        if (kind === "off" || kind === "model_unavailable" || kind === "limit" || kind === "busy" || kind === "failed" || kind === "reused") {
          setNotice(kind);
        } else if (kind !== "done") setNotice("failed");
      }
    } catch {
      setNotice("failed");
    } finally {
      setAsking(false);
      setVersion((v) => v + 1);
    }
  };

  if (hidden) return null;
  const latest = status?.latest ?? null;
  const used = status ? f.briefing.used(status.usedToday, status.limit) : null;
  const message =
    notice === "limit" && status
      ? f.briefing.limit(status.limit)
      : notice === "model_unavailable"
        ? f.briefing.modelUnavailable
        : notice && notice !== "off" && notice !== "reused" && notice !== "limit"
          ? { busy: f.briefing.busy, failed: f.briefing.failed, reauth: f.briefing.reauth, unread: f.briefing.unread }[notice]
          : null;

  return (
    <section className={cn(s.card, s.brief)} data-testid="agent-office-briefing">
      <div className={s.rh}>
        <h2>✨ {f.briefing.title}</h2>
        {used ? <span className={s.faint}>{used}</span> : null}
      </div>
      {status && !status.enabled ? (
        <p className={s.roNote}>{f.briefing.off}</p>
      ) : (
        <>
          <button
            type="button"
            className={s.briefBtn}
            onClick={ask}
            disabled={asking || !status || status.usedToday >= status.limit}
            data-testid="agent-office-briefing-ask"
          >
            {asking ? f.briefing.asking : latest ? f.briefing.again : f.briefing.ask}
          </button>
          <p className={s.roNote}>{f.briefing.cost}</p>
        </>
      )}
      {message ? <p className={s.briefWarn} role="status">{message}</p> : null}
      {notice === "reused" ? <p className={s.roNote} role="status">{f.briefing.reused}</p> : null}
      {latest ? (
        <div className={s.briefBody} data-testid="agent-office-briefing-body">
          <p className={s.briefHead}>{latest.briefing.headline}</p>
          <ul>
            {latest.briefing.points.map((point, i) => (
              <li key={i} className={s[`bp_${point.severity}`]}>
                <span>{point.text}</span>
                {point.link ? (
                  <Link href={BRIEFING_LINKS[point.link]} className={s.itGo}>
                    {f.briefing.open} ›
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
          <p className={s.roNote}>{f.briefing.at(aestClock(latest.at).replace(" AEST", ""), latest.modelId)}</p>
          <p className={s.roNote}>ⓘ {f.briefing.note}</p>
        </div>
      ) : null}
    </section>
  );
}
