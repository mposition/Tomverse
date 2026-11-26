import { useId, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { buildReviewAnalysisReport, reviewReportLabels, reviewReportSelection } from "@/lib/reviewAnalysisReport";
import type { ReviewChatSource } from "@/lib/reviewToChat";
import type { ReviewExportInput } from "../chat-extras-contract";
import "./review-extras.css";

const FORMATS = [["pdf", "PDF (.pdf)"], ["docx", "Word (.docx)"], ["txt", "TXT (.txt)"], ["md", "Markdown (.md)"]] as const;

/** Saves the stored AI Review as a file. The server renders it; the save dialog is the operating system's. */
export function ReviewExport({ source, ready }: { source: ReviewChatSource | null; ready: boolean }) {
  const { t, lang } = useLanguage();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState<ReviewExportInput["format"]>("pdf");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const eligible = Boolean(ready && source?.review.id && source.setup.source?.question && source.review.responseMap.length >= 2 &&
    source.kind === "review" && !source.review.guest && source.review.persisted !== false && source.review.result[source.reviewer]);
  const report = useMemo(() => {
    if (!eligible || !source) return null;
    try { return buildReviewAnalysisReport(source, reviewReportLabels(t)); } catch { return null; }
  }, [eligible, source, t]);
  if (!eligible || !source || !report) return null;

  async function save() {
    if (!source || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const analysis = await reviewReportSelection(source, lang);
      const saved = await window.desktop.exportReviewAnalysis({ conversationId: source.conversationId, format, analysis });
      if (saved) dialog.current?.close();
    } catch {
      setMessage(t("reviewActions.failed"));
    } finally {
      setBusy(false);
    }
  }
  return <>
    <button type="button" className="soft" data-testid="desktop-review-analysis-export" onClick={() => { setMessage(""); dialog.current?.showModal(); }}>
      <Download size={15} aria-hidden="true" /> {t("reviewActions.export")}
    </button>
    <dialog ref={dialog} className="review-export-dialog" aria-labelledby={`${id}-title`} data-testid="desktop-review-export-dialog">
      <h2 id={`${id}-title`}>{t("reviewActions.export")}</h2>
      <p>{t("reviewActions.exportIntro")}</p>
      <pre data-testid="desktop-review-report-preview">{report.text}</pre>
      <label>{t("reviewActions.format")} <select value={format} disabled={busy}
        onChange={(event) => setFormat(event.currentTarget.value as ReviewExportInput["format"])}>
        {FORMATS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      {message && <p role="alert">{message}</p>}
      <div className="review-export-actions">
        <button type="button" className="soft" disabled={busy} onClick={() => dialog.current?.close()}>{t("chat.close")}</button>
        <button type="button" disabled={busy} onClick={() => void save()}>{t("reviewActions.export")}</button>
      </div>
    </dialog>
  </>;
}
