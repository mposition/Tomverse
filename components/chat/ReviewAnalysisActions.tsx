"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "@/components/LanguageProvider";
import { useModalDialog } from "@/components/useModalDialog";
import { ReviewChatAction, useReviewResultAccess } from "./ReviewChatHandoff";
import { buildReviewAnalysisReport, reviewReportLabels, reviewReportSelection } from "@/lib/reviewAnalysisReport";
import type { ReviewChatSource } from "@/lib/reviewToChat";
import { filenameFromContentDisposition, saveBlobAsFile } from "@/lib/browserDownload";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { ProjectSaveToProject } from "@/components/projects/ProjectSaveToProject";
import "./review-analysis-actions.css";

export function ReviewAnalysisActions({ source, ready, scope = "", onClose, closeDisabled = false, disclaimer, className = "" }: {
  source: ReviewChatSource | null; ready: boolean; scope?: string; onClose: () => void;
  closeDisabled?: boolean; disclaimer?: string; className?: string;
}) {
  const { t, lang } = useLanguage();
  const access = useReviewResultAccess();
  const key = JSON.stringify([access?.identity, access?.supported, ready, scope, source]);
  const eligible = Boolean(access?.supported && access.identity?.startsWith("account:") && ready && source?.review.id &&
    source.setup.source?.question && source.review.responseMap.length >= 2 &&
    (source.kind === "quick" || (!source.review.guest && source.review.persisted !== false && source.review.result[source.reviewer])));
  const [opened, setOpened] = useState<{ key: string; mode: "share" | "export"; source: ReviewChatSource } | null>(null);
  const [format, setFormat] = useState("pdf");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [share, setShare] = useState<{ identity: string; conversationId: string; key: string; url?: string; uncertain: boolean } | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useLayoutEffect(() => {
    const invalidate = () => { generation.current++; request.current?.abort(); request.current = null; };
    invalidate();
    return invalidate;
  }, [key]);
  const open = opened?.key === key && eligible;
  const labels = useMemo(() => reviewReportLabels(t), [t]);
  const report = useMemo(() => {
    if (!open || !opened) return null;
    try { return buildReviewAnalysisReport(opened.source, labels); } catch { return null; }
  }, [open, opened, labels]);
  const shared = share && share.identity === access?.identity && share.conversationId === source?.conversationId ? share : null;
  const sharedUrl = shared?.key === key ? shared.url : undefined;
  const close = () => { request.current?.abort(); request.current = null; setOpened(null); setBusy(false); };
  const dialogRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useModalDialog({ open: Boolean(open), onClose: close, dialogRef, panelRef });

  const perform = async (action: "publish" | "revoke" | "export") => {
    if (!open || !opened || !access?.identity || request.current || (action === "publish" && (shared?.uncertain || sharedUrl))) return;
    const controller = new AbortController(); request.current = controller;
    const ticket = generation.current;
    const identity = access.identity;
    const conversationId = opened.source.conversationId;
    const current = () => ticket === generation.current && !controller.signal.aborted;
    setBusy(true); setMessage("");
    try {
      const analysis = action === "revoke" ? undefined : await reviewReportSelection(opened.source, lang);
      if (!current()) return;
      if (action === "publish") setShare({ identity, conversationId, key, uncertain: true });
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/${action === "export" ? "analysis/export" : "share"}`, {
        method: action === "revoke" ? "DELETE" : "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        ...(action === "revoke" ? {} : { body: JSON.stringify({ analysis, ...(action === "export" ? { format } : {}) }) }),
      });
      if (!current()) { await discardResponseBody(response); return; }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (!current()) return;
        if (action === "publish" && response.status < 500) setShare({ identity, conversationId, key, uncertain: false });
        setMessage(t(data.code === "UNSUPPORTED_CHARACTERS" ? "reviewActions.pdfCharacters" : "reviewActions.failed"));
        return;
      }
      if (action === "export") {
        const declaredBytes = response.headers.get("X-Export-Bytes") ?? "";
        const declaredDigest = response.headers.get("X-Export-SHA256") ?? "";
        const bytes = await response.arrayBuffer();
        if (!current()) return;
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hex = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
        if (!current()) return;
        if (!/^\d+$/.test(declaredBytes) || bytes.byteLength !== Number(declaredBytes) || hex !== declaredDigest) throw Error("INCOMPLETE_EXPORT");
        saveBlobAsFile(new Blob([bytes], { type: response.headers.get("content-type") ?? "application/octet-stream" }), filenameFromContentDisposition(response.headers.get("content-disposition"), `answer-analysis.${format}`));
      } else if (action === "publish") {
        const data = await response.json();
        if (!current()) return;
        const url = new URL(data.url);
        if (!["https:", "http:"].includes(url.protocol) || !url.pathname.startsWith("/share/")) throw Error("INVALID_SHARE_URL");
        setShare({ identity, conversationId, key, uncertain: false, url: url.href });
      } else {
        await discardResponseBody(response);
        if (!current()) return;
        setShare({ identity, conversationId, key, uncertain: false });
      }
    } catch { if (current()) setMessage(t("reviewActions.failed")); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  };
  const show = (mode: "share" | "export") => {
    if (!eligible || !source) return;
    setOpened({ key, mode, source: structuredClone(source) }); setBusy(false); setMessage("");
  };
  const copyLink = async () => {
    if (!sharedUrl) return;
    const ticket = generation.current;
    try { await navigator.clipboard.writeText(sharedUrl); if (ticket === generation.current) setMessage(t("reviewActions.copied")); }
    catch { if (ticket === generation.current) setMessage(t("reviewActions.failed")); }
  };
  return <footer className={`review-analysis-actions ${className}`} data-testid="review-analysis-actions">
    <div className="review-analysis-action-note"><p>{disclaimer}</p>
      {!ready && <p role="status">{t("reviewActions.partialUnavailable")}</p>}
      {!access?.supported && <p>{t("reviewHandoff.unsupported")}</p>}
      {open && !report && <p role="alert">{t("reviewActions.failed")}</p>}
    </div>
    <div className="review-analysis-action-buttons">
      <button type="button" disabled={!eligible} onClick={() => show("share")} data-testid="review-analysis-share">{t("reviewActions.share")}</button>
      <button type="button" disabled={!eligible} onClick={() => show("export")} data-testid="review-analysis-export">{t("reviewActions.export")}</button>
      {eligible && source && <ProjectSaveToProject testId="review-analysis-save-to-project" className="review-analysis-save"
        source={async () => ({ sourceKind: "review_result" as const, conversationId: source.conversationId, analysis: await reviewReportSelection(source, lang) })} />}
      <div className="review-analysis-primary-actions"><ReviewChatAction source={source} ready={ready} scope={scope} inline />
        <button type="button" disabled={closeDisabled} onClick={onClose}>{t("chat.close")}</button></div>
    </div>
    {open && opened && report && createPortal(<div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="review-report-dialog-title" className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 p-3">
      <div ref={panelRef} tabIndex={-1} className="flex max-h-[90dvh] w-full max-w-3xl flex-col gap-3 overflow-y-auto rounded-2xl bg-white p-4 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
        <h2 id="review-report-dialog-title" className="text-lg font-bold">{t(opened.mode === "share" ? "reviewActions.share" : "reviewActions.export")}</h2>
        <p className="text-sm">{t(opened.mode === "share" ? "reviewActions.shareIntro" : "reviewActions.exportIntro")}</p>
        {opened.mode === "share" && <p className="text-sm font-semibold">{t("reviewActions.replaceNotice")}</p>}
        <pre data-testid="review-report-preview" className="max-h-[40dvh] shrink-0 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-100 p-3 text-sm dark:bg-zinc-800">{report.text}</pre>
        {opened.mode === "export" && <label className="grid gap-1 text-sm">{t("reviewActions.format")}<select value={format} disabled={busy} onChange={event => setFormat(event.target.value)} className="min-h-11 rounded-xl border bg-transparent p-2">
          <option value="pdf">PDF (.pdf)</option><option value="docx">Word (.docx)</option><option value="txt">TXT (.txt)</option><option value="md">Markdown (.md)</option>
        </select></label>}
        {opened.mode === "share" && sharedUrl && <div className="grid gap-2"><input aria-label={t("reviewActions.copyLink")} readOnly value={sharedUrl} className="min-h-11 w-full rounded-lg border bg-transparent p-2" />
          <button type="button" className="min-h-11 rounded-xl border px-4" onClick={() => void copyLink()}>{t("reviewActions.copyLink")}</button></div>}
        {shared?.uncertain && <p role="alert">{t("reviewActions.unknown")}</p>}
        {message && <p role="status">{message}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={close} className="min-h-11 rounded-xl border px-4">{t("chat.close")}</button>
          {opened.mode === "share" && (shared?.url || shared?.uncertain) && <button type="button" disabled={busy} onClick={() => void perform("revoke")} className="min-h-11 rounded-xl border px-4">{t("reviewActions.revoke")}</button>}
          <button type="button" disabled={busy || (opened.mode === "share" && Boolean(shared?.uncertain || sharedUrl))} onClick={() => void perform(opened.mode === "share" ? "publish" : "export")} className="min-h-11 rounded-xl bg-blue-600 px-4 text-white disabled:opacity-50">{t(opened.mode === "share" ? "reviewActions.publish" : "reviewActions.export")}</button>
        </div>
      </div>
    </div>, document.body)}
  </footer>;
}
