"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { z } from "zod";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxHierarchyMessages } from "@/lib/adminMessages/amuxHierarchy";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import type { AmuxHierarchyNodeLevel, AmuxHierarchyStep } from "@/lib/amux/cardHierarchyCore";
import { amuxVisibleInspectionText } from "@/lib/amux/adminExecutionViewCore";
import workspace from "./AmuxExecutionWorkspace.module.css";
import styles from "./amuxCardHierarchy.module.css";

const useHierarchyMessages = () => useAdminMessages(adminAmuxHierarchyMessages);
type Messages = ReturnType<typeof useHierarchyMessages>;

/** Owner request 2026-11-21: Initiative > Epic > Feature > Story > Task on a
 * card, each step opening what it names. A node opens the edit sheet; the
 * Story opens its own card. */
export function AmuxCardHierarchy({ steps, onOpenCard, onSaved }: {
  steps: AmuxHierarchyStep[]; onOpenCard: (id: string) => void;
  onSaved: () => void;
}) {
  const m = useHierarchyMessages();
  const [node, setNode] = useState<{ id: string; level: AmuxHierarchyNodeLevel } | null>(null);
  const returnRef = useRef<HTMLButtonElement | null>(null);
  // The card is read again when the sheet closes, so its result stays on screen.
  const savedRef = useRef(false);
  return <>
    <section className={styles.block} aria-label={m.heading} data-testid="amux-card-hierarchy">
      <div className={styles.blockHead}><strong>{m.heading}</strong><span>{m.hint}</span></div>
      <ol className={styles.line}>
        {steps.map((step) => <li key={step.level}>
          <HierarchyStep step={step} m={m} onOpen={(button) => {
            if (step.kind === "node") { returnRef.current = button;
              setNode({ id: step.id, level: step.level }); }
            if (step.kind === "card" && !step.current) onOpenCard(step.id);
          }} />
        </li>)}
      </ol>
    </section>
    {node && <AmuxPortfolioNodeSheet key={node.id} nodeId={node.id} level={node.level}
      m={m} onClose={() => { setNode(null);
        if (savedRef.current) { savedRef.current = false; onSaved(); }
        else returnRef.current?.focus(); }}
      onSaved={() => { savedRef.current = true; }} />}
  </>;
}

function HierarchyStep({ step, m, onOpen }: { step: AmuxHierarchyStep; m: Messages;
  onOpen: (button: HTMLButtonElement) => void }) {
  const level = m.levels[step.level];
  if (step.kind === "missing") {
    return <div className={`${styles.step} ${styles.missing}`} data-testid={`amux-hierarchy-${step.level}`}
      data-state="missing">
      <span className={styles.stepTop}>{level}</span>
      <span className={styles.stepTitle}>{step.reason === "no_story" ? m.noStory : m.unavailable}</span>
    </div>;
  }
  const title = step.title === null ? m.protectedTitle : amuxVisibleInspectionText(step.title);
  const classes = [styles.step, step.kind === "card" && step.current ? styles.current : "",
    step.archived ? styles.archived : ""].filter(Boolean).join(" ");
  const body = <>
    <span className={styles.stepTop}>{level}
      {step.kind === "card" && step.current ? <> · {m.current}</> : <em>{m.open} ↗</em>}</span>
    <span className={styles.stepTitle}>{title}</span>
    <span className={styles.stepMeta}>
      {step.number && <code>{step.number}</code>}
      {step.kind === "node" ?
        <span className={`${styles.pill} ${step.archived ? styles.pillWarn : ""}`}>
          {step.archived ? m.archived : m.active}</span> :
        <span className={`${styles.pill} ${step.archived ? styles.pillWarn :
          ["done", "cancelled"].includes(step.status) ? "" : styles.pillWork}`}>
          {step.archived ? m.archived : m.status(step.status)}</span>}
    </span>
    <span className={styles.stepMeta}>
      {step.kind === "node" ? (step.value === null ? m.noValue : m.value(step.value, step.weight)) :
        step.metric === null ? null : step.level === "story" ? m.impact(step.metric) :
          m.contribution(step.metric)}
    </span>
    {step.kind === "node" && step.archived && <span className={styles.note}>{m.archivedNote}</span>}
  </>;
  if (step.kind === "card" && step.current) {
    return <div className={classes} aria-current="page" data-testid={`amux-hierarchy-${step.level}`}
      data-state="current">{body}</div>;
  }
  return <button type="button" className={classes} data-testid={`amux-hierarchy-${step.level}`}
    data-state={step.archived ? "archived" : "active"}
    aria-label={`${step.kind === "node" && step.editable ? m.edit(level) : m.view(level)}: ${title}`}
    onClick={(event) => onOpen(event.currentTarget)}>{body}</button>;
}

const nodeRead = z.object({ id: z.string(), level: z.enum(["initiative", "epic", "feature"]),
  state: z.string(), revision: z.number().int(), displayPrefix: z.string().nullable(),
  content: z.object({ title: z.string(), description: z.string() }).nullable(),
  editable: z.boolean(), contentEditable: z.boolean(),
  assessment: z.object({ version: z.number().int(), value: z.number().int().nullable(),
    uncertainty: z.string(), reasonCode: z.string(), evidenceAsOf: z.string(),
    bound: z.boolean() }).nullable() });
type NodeRead = z.infer<typeof nodeRead>;

const previewRead = z.object({ confirmationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  contentChanged: z.boolean(), revisionAfter: z.number().int(),
  priorValue: z.number().nullable(), nextValue: z.number(),
  tasks: z.array(z.object({ taskId: z.string(), displayKey: z.string().nullable(),
    currentScore: z.number().nullable(), projectedScore: z.number().nullable() })) });
type PreviewRead = z.infer<typeof previewRead>;

const saveRead = z.object({ state: z.literal("saved"),
  tasks: z.array(z.object({ taskId: z.string(), state: z.enum(["scored", "skipped"]) })) });

const WEIGHT: Record<AmuxHierarchyNodeLevel, number> = { initiative: 4, epic: 3, feature: 2 };
const UNCERTAINTY = ["low", "medium", "high"] as const;
const REASONS = ["new_evidence", "operator_override", "major_event"] as const;
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
/** A picked day means its start in local time, never a future instant. */
const dayStart = (day: string) => {
  const at = new Date(`${day}T00:00:00`);
  return Number.isFinite(at.getTime()) && at.getTime() <= Date.now() ? at.toISOString() : null;
};

/** A save whose answer was lost. Its confirmation binds the node's latest
 * assessment, so of it and any later save from the same state only one can
 * ever be written (tests/integration/amux-portfolio-node-edit.db.test.ts).
 * It is kept per node for this tab, so closing the sheet never forgets it. */
type Sent = { requestId: string };
const pendingKey = (nodeId: string) => `amux-node-edit-pending:${nodeId}`;
const readPending = (nodeId: string): Sent | null => {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(pendingKey(nodeId)) ?? "null");
    return value && typeof value.requestId === "string" ? { requestId: value.requestId } : null;
  } catch { return null; }
};
const writePending = (nodeId: string, sent: Sent | null) => {
  try {
    if (sent) window.sessionStorage.setItem(pendingKey(nodeId), JSON.stringify(sent));
    else window.sessionStorage.removeItem(pendingKey(nodeId));
  } catch { /* the server-side binding still refuses a duplicate */ }
};

type Draft = { title: string; description: string; value: number;
  uncertainty: typeof UNCERTAINTY[number]; reason: string; day: string };

function AmuxPortfolioNodeSheet({ nodeId, level, m, onClose, onSaved }: {
  nodeId: string; level: AmuxHierarchyNodeLevel; m: Messages;
  onClose: () => void; onSaved: () => void;
}) {
  const [read, setRead] = useState<NodeRead | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<{ data: PreviewRead; payload: object; requestId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  /** A save whose outcome is not known yet. */
  const [unknown, setUnknownState] = useState<Sent | null>(() =>
    typeof window === "undefined" ? null : readPending(nodeId));
  const setUnknown = (sent: Sent | null) => { setUnknownState(sent); writePending(nodeId, sent); };
  /** Bumped after a save, so the sheet reads the node's new revision. */
  const [reload, setReload] = useState(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  /** Why the node could not be read, as a code the current locale words. */
  const [loadFailure, setLoadFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await adminFetch(`/api/admin/amux/portfolio?kind=node&nodeId=${encodeURIComponent(nodeId)}`,
          { cache: "no-store" });
        if (cancelled) return;
        if (response.status === 428) { setReauth(true); return; }
        const json: unknown = await response.json().catch(() => null);
        const parsed = nodeRead.safeParse(json);
        if (!response.ok || !parsed.success) { setLoadFailure(errorCode(json)); return; }
        setRead(parsed.data);
        setDraft({ title: parsed.data.content?.title ?? "",
          description: parsed.data.content?.description ?? "",
          value: parsed.data.assessment?.value ?? 3,
          uncertainty: (UNCERTAINTY as readonly string[]).includes(parsed.data.assessment?.uncertainty ?? "") ?
            parsed.data.assessment!.uncertainty as Draft["uncertainty"] : "medium",
          reason: parsed.data.assessment ? "operator_override" : "initial", day: today() });
      } catch { if (!cancelled) setLoadFailure("unavailable"); }
    })();
    return () => { cancelled = true; };
  }, [nodeId, reload]);
  // Focus once, when the node first arrives; a re-read after a save keeps
  // the owner where they are.
  const focused = useRef(false);
  useEffect(() => { if (read && !focused.current) { focused.current = true;
    headingRef.current?.focus(); } }, [read]);

  const change = (next: Partial<Draft>) => {
    if (unknown) return;
    setDraft((prior) => prior ? { ...prior, ...next } : prior);
    setPreview(null); setDone(null); setError(null);
  };
  const post = (body: unknown) => adminFetch("/api/admin/amux/portfolio", { method: "POST",
    cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const review = async () => {
    if (!read || !draft || busy) return;
    const evidenceAsOf = dayStart(draft.day);
    const textChanged = read.contentEditable && read.content !== null &&
      (draft.title.trim() !== read.content.title || draft.description.trim() !== read.content.description);
    if (!evidenceAsOf || (textChanged && draft.title.trim() === "")) { setError(m.failed("invalid_input")); return; }
    const requestId = crypto.randomUUID();
    const payload = { id: crypto.randomUUID(), requestId, nodeId: read.id,
      expectedRevision: read.revision,
      content: textChanged ? { title: draft.title.trim(), description: draft.description } : null,
      value: draft.value, uncertainty: draft.uncertainty, reasonCode: draft.reason, evidenceAsOf };
    setBusy(true); setError(null);
    try {
      const response = await post({ action: "preview_node_edit", payload });
      if (response.status === 428) { setReauth(true); return; }
      const json: unknown = await response.json().catch(() => null);
      const parsed = previewRead.safeParse(json);
      if (!response.ok || !parsed.success) { setError(m.failed(errorCode(json))); return; }
      setPreview({ data: parsed.data, payload, requestId });
    } catch { setError(m.failed("unavailable")); } finally { setBusy(false); }
  };

  const save = async () => {
    if (!preview || busy) return;
    setBusy(true); setError(null);
    const sent = { requestId: preview.requestId };
    // Remembered before sending: a closed tab or sheet still finds it.
    setUnknown(sent);
    try {
      const response = await post({ action: "save_node_edit",
        approval: { payload: preview.payload, confirmationDigest: preview.data.confirmationDigest } });
      if (response.status === 428) { setReauth(true); return; }
      const json: unknown = await response.json().catch(() => null);
      const parsed = saveRead.safeParse(json);
      if (response.ok && parsed.success) {
        setUnknown(null);
        const scored = parsed.data.tasks.filter((task) => task.state === "scored").length;
        setDone(m.saved(scored, parsed.data.tasks.length - scored)); setPreview(null);
        onSaved(); setReload((value) => value + 1); return;
      }
      // A named refusal was rolled back. An unknown outcome, an unreadable
      // answer or a lost response is read back, never retried (agent foundation).
      const code = errorCode(json);
      if (!response.ok && code !== "outcome_unknown" && code !== "unavailable") {
        setUnknown(null); setError(m.failed(code)); setPreview(null); return;
      }
      await readBack(sent);
    } catch {
      await readBack(sent);
    } finally { setBusy(false); }
  };

  /** approved: written. not_found: no record yet, and a new save is safe,
   * because the lost one is then refused if it ever arrives. Anything else
   * keeps the outcome unknown and the save closed. */
  const readBack = async ({ requestId }: Sent) => {
    setError(m.failed("outcome_unknown"));
    try {
      const back = await adminFetch(`/api/admin/amux/portfolio?kind=assessment&requestId=${requestId}`,
        { cache: "no-store" });
      if (back.status === 428) { setReauth(true); return; }
      const state = back.ok ?
        (await back.json().catch(() => null) as { state?: string } | null)?.state : null;
      if (state === "approved") {
        setUnknown(null); setPreview(null); setError(null); setDone(m.unknownSaved); onSaved();
        setReload((value) => value + 1);
      } else if (state === "not_found") {
        setUnknown(null); setPreview(null); setError(m.unknownNotSaved);
        setReload((value) => value + 1);
      } else setError(m.unknownPending);
    } catch { setError(m.unknownPending); }
  };

  // A save this tab lost earlier for this node is checked before anything else.
  const resumed = useRef(false);
  useEffect(() => {
    if (!read || resumed.current) return;
    resumed.current = true;
    // The unknown state already holds it (its initial value).
    const pending = readPending(nodeId);
    if (pending) void readBack(pending);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the first read
  }, [read]);

  const levelName = m.levels[level];
  const prior = read?.assessment?.value ?? null;
  const readOnly = !read?.editable;
  const locked = readOnly || unknown !== null;
  return <div className={styles.layer} role="presentation" onClick={(event) => {
    if (event.target === event.currentTarget) onClose(); }}>
    <section className={styles.sheet} role="dialog" aria-modal="false" aria-labelledby="amux-node-sheet-title"
      data-testid="amux-node-sheet" onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header className={styles.sheetHead}>
        <div>
          <p>{read?.editable === false ? m.view(levelName) : m.edit(levelName)}
            {read && <> · {read.displayPrefix ?? `#${read.id.replace(/-/g, "").slice(0, 6)}`} · rev {read.revision}</>}</p>
          <h4 id="amux-node-sheet-title" ref={headingRef} tabIndex={-1}>
            {read?.content ? amuxVisibleInspectionText(read.content.title) : levelName}</h4>
        </div>
        <button type="button" className={workspace.iconButton} aria-label={m.close} onClick={onClose}>
          <X size={16} aria-hidden="true" /></button>
      </header>
      {reauth && <div role="alert" className={workspace.notice}>
        <Link href={adminRecentAuthenticationHref(window.location.pathname + window.location.search)}>{m.reauth}</Link></div>}
      {!read && !reauth && !loadFailure && <p role="status" className={styles.status}>{m.loading}</p>}
      {read && draft && <>
        {readOnly && <p className={styles.note}>{m.readOnlyArchived}</p>}
        <label className={styles.field}><span>{m.title}</span>
          <input type="text" value={draft.title} maxLength={200}
            disabled={locked || !read.contentEditable || busy}
            onChange={(event) => change({ title: event.target.value })} /></label>
        <div className={styles.field}><label htmlFor="amux-node-description">{m.description}</label>
          <textarea id="amux-node-description" value={draft.description} maxLength={4000}
            aria-describedby="amux-node-description-note"
            disabled={locked || !read.contentEditable || busy}
            onChange={(event) => change({ description: event.target.value })} />
          <small id="amux-node-description-note">{read.contentEditable ? m.contentNote : m.contentLocked}</small></div>
        <div className={styles.sectionHead}><strong>{m.scoreHeading}</strong>
          <span>{m.scoreHint(WEIGHT[level])}</span></div>
        <Segments legend={m.valueLabel} name="value" disabled={locked || busy}
          options={[0, 1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) }))}
          selected={String(draft.value)} onChange={(value) => change({ value: Number(value) })}
          note={read.assessment && !read.assessment.bound ? `${m.valueNote(prior)} ${m.unbound}` : m.valueNote(prior)} />
        <Segments legend={m.uncertainty} name="uncertainty" disabled={locked || busy}
          options={UNCERTAINTY.map((value) => ({ value, label: m.uncertaintyOptions[value] }))}
          selected={draft.uncertainty} onChange={(value) => change({ uncertainty: value as Draft["uncertainty"] })} />
        <Segments legend={m.reason} name="reason" disabled={locked || busy || !read.assessment}
          options={(read.assessment ? REASONS : ["initial"] as const).map((value) =>
            ({ value, label: m.reasonOptions[value] }))}
          selected={draft.reason} onChange={(value) => change({ reason: value })} />
        <div className={styles.field}><label htmlFor="amux-node-evidence">{m.evidenceAsOf}</label>
          <input id="amux-node-evidence" type="date" value={draft.day} max={today()}
            aria-describedby="amux-node-evidence-note" disabled={locked || busy}
            onChange={(event) => change({ day: event.target.value })} />
          <small id="amux-node-evidence-note">{m.evidenceNote}</small></div>
        {preview && <div className={styles.impact} data-testid="amux-node-preview">
          <strong>{m.previewHeading(preview.data.tasks.length)}</strong>
          <p>{preview.data.contentChanged ? m.revision(preview.data.revisionAfter) : m.noRevision}</p>
          {preview.data.tasks.length > 0 && <ul>{preview.data.tasks.map((task) =>
            <li key={task.taskId}>{m.estimate(task.displayKey ?? task.taskId.slice(0, 8),
              task.currentScore, task.projectedScore)}</li>)}</ul>}
          <p>{m.previewNote}</p>
        </div>}
        {error && <p role="alert" className={styles.note}>{error}</p>}
        {done && <p role="status" className={styles.status}>{done}</p>}
        <div className={styles.actions}>
          <button type="button" className={workspace.button} onClick={onClose}>{m.cancel}</button>
          {!readOnly && unknown && <button type="button" className={`${workspace.button} ${styles.primary}`}
            disabled={busy} onClick={() => { setBusy(true); void readBack(unknown).finally(() => setBusy(false)); }}
            data-testid="amux-node-readback">{m.checkAgain}</button>}
          {!locked && (preview ?
            <button type="button" className={`${workspace.button} ${styles.primary}`} disabled={busy}
              onClick={() => void save()} data-testid="amux-node-save">{m.save}</button> :
            <button type="button" className={`${workspace.button} ${styles.primary}`} disabled={busy}
              onClick={() => void review()} data-testid="amux-node-review">{m.preview}</button>)}
        </div>
        <small className={styles.status}>{m.ownerOnly}</small>
      </>}
      {loadFailure && !read && <p role="alert" className={styles.note}>{m.failed(loadFailure)}</p>}
    </section>
  </div>;
}

function Segments({ legend, name, options, selected, onChange, disabled, note }: {
  legend: string; name: string; options: Array<{ value: string; label: string }>;
  selected: string; onChange: (value: string) => void; disabled: boolean; note?: string;
}) {
  return <fieldset className={styles.field}><legend>{legend}</legend>
    <div className={styles.segments}>{options.map((option) =>
      <label key={option.value}><input type="radio" name={`amux-node-${name}`} value={option.value}
        checked={selected === option.value} disabled={disabled}
        onChange={() => onChange(option.value)} /><span>{option.label}</span></label>)}</div>
    {note && <small>{note}</small>}
  </fieldset>;
}

function errorCode(json: unknown) {
  return json && typeof json === "object" && "error" in json &&
    typeof (json as { error: unknown }).error === "string" ? (json as { error: string }).error : "unavailable";
}
