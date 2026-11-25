import { useEffect, useRef, useState } from "react";
import { buildBatchPayloads, type ImportPreview } from "../../../../lib/externalImportPipeline";
import { externalImportSelectionDigest } from "../../../../lib/externalImportSelectionDigest";
import { EXTERNAL_IMPORT_STORAGE_LIMITS } from "../../../../lib/externalImportLimits";
import type { WorkerRequest, WorkerResponse } from "../../../../lib/workers/externalImportWorker";
import type { Language } from "../../../../lib/language";
import type { en } from "../../../../locales/en";
import type { AccountSettingsResult } from "../account-settings-contract";

type Copy = typeof en.externalImport;
type Remaining = AccountSettingsResult<"importCapacity">["remaining"];
type Receipt = {
  id: string;
  staged: Array<{ stagedConversationId: string; conversationDigest: string }>;
  duplicates: number;
  truncated: number;
  key: string;
};
const format = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (token, name: string) => String(values[name] ?? token));
const filePrivacy: Record<Language, string> = {
  en: "The export file stays on this device. Tomverse receives only the text of the conversations you select.",
  ko: "내보내기 파일은 이 기기에만 남습니다. 선택한 대화의 텍스트만 Tomverse로 전송됩니다.",
  zh: "导出文件保留在此设备上。Tomverse 只接收您选中的对话文本。",
  "zh-Hant": "匯出檔案保留在這部裝置上。Tomverse 只接收您選取的對話文字。",
  fr: "Le fichier reste sur cet appareil. Tomverse reçoit uniquement le texte des conversations que vous sélectionnez.",
  de: "Die Exportdatei bleibt auf diesem Gerät. Tomverse erhält nur den Text der ausgewählten Unterhaltungen.",
  es: "El archivo se queda en este dispositivo. Tomverse solo recibe el texto de las conversaciones que selecciones.",
  pt: "O arquivo fica neste dispositivo. O Tomverse recebe apenas o texto das conversas que você selecionar.",
};

export function ExternalConversationImport({ copy, language, onClose }: {
  copy: Copy;
  language: Language;
  onClose(saved: boolean): void;
}) {
  const [capacity, setCapacity] = useState<Remaining>();
  const [preview, setPreview] = useState<ImportPreview>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [scan, setScan] = useState<number>();
  const [progress, setProgress] = useState<{ sent: number; total: number }>();
  const [receipt, setReceipt] = useState<Receipt>();
  const [finalizing, setFinalizing] = useState(false);
  const [needsReadback, setNeedsReadback] = useState(false);
  const [saved, setSaved] = useState<number>();
  const [error, setError] = useState("");
  const worker = useRef<Worker | undefined>(undefined);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    void window.desktop.accountSettings<"importCapacity">({ action: "importCapacity" }).then(result => {
      if (current) setCapacity(result.remaining);
    }, () => { if (current) setError(copy.disabledNotice); });
    return () => {
      current = false;
      mounted.current = false;
      worker.current?.terminate();
    };
  }, [copy.disabledNotice]);

  function scanFile(file: File) {
    setError(""); setScan(0); setFilter(""); setSelected(new Set()); setPreview(undefined);
    try {
      const parser = new Worker(new URL("../../../../lib/workers/externalImportWorker.ts", import.meta.url), { type: "module" });
      worker.current = parser;
      function stop() {
        parser.terminate();
        worker.current = undefined;
        setScan(undefined);
      }
      parser.onerror = () => { stop(); setError(copy.parseFailed); };
      parser.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        if (data.type === "progress") setScan(data.conversationsFound);
        if (data.type === "split_questions") parser.postMessage({ type: "split_hints", hints: null } satisfies WorkerRequest);
        if (data.type === "preview") { stop(); setPreview(data.preview); }
        if (data.type === "error") { stop(); setError(copy.parseFailed); }
      };
      parser.postMessage({ type: "parse", file } satisfies WorkerRequest);
    } catch {
      worker.current?.terminate(); worker.current = undefined;
      setScan(undefined); setError(copy.parseFailed);
    }
  }

  const rows = preview?.conversations ?? [];
  const chosen = rows.filter(row => selected.has(row.conversation.rawExternalConversationId));
  const totalBytes = chosen.reduce((sum, row) => sum + row.estimatedStoredBytes, 0);
  const totalMessages = chosen.reduce((sum, row) => sum + row.conversation.messages.length, 0);
  const overCapacity = !!capacity && (totalBytes > capacity.normalizedTextBytes ||
    chosen.length > capacity.externalConversations || totalMessages > capacity.externalMessages);
  const size = (bytes: number) => new Intl.NumberFormat(language, { style: "unit", unit: "megabyte",
    maximumFractionDigits: 2 }).format(bytes / (1024 * 1024));

  async function prepare() {
    if (!preview || !chosen.length || progress) return;
    setError("");
    try {
      const batches = buildBatchPayloads(chosen.map(row => row.conversation));
      setProgress({ sent: 0, total: batches.length });
      const { importId } = await window.desktop.accountSettings<"startImport">({ action: "startImport", provider: preview.provider });
      const staged: Receipt["staged"] = [];
      let duplicates = 0;
      for (const batch of batches) {
        if (!mounted.current) return;
        const { results } = await window.desktop.accountSettings<"appendImport">({ action: "appendImport", id: importId, batch });
        if (results.length !== batch.conversations.length) throw new Error("Incomplete import receipt.");
        for (const result of results) {
          if (result.outcome === "staged") staged.push(result);
          else duplicates++;
        }
        setProgress({ sent: batch.sequence + 1, total: batches.length });
      }
      if (!mounted.current) return;
      const seal = await window.desktop.accountSettings<"sealImport">({ action: "sealImport", id: importId,
        finalSequence: batches.length - 1, expectedStagedConversationIds: staged.map(item => item.stagedConversationId),
        expectedDuplicateCount: duplicates });
      if (mounted.current) setReceipt({ id: importId, staged, duplicates, truncated: seal.truncatedMessageCount, key: crypto.randomUUID() });
    } catch {
      if (mounted.current) setError(copy.inProgressNotResumable);
    } finally {
      if (mounted.current) setProgress(undefined);
    }
  }

  async function finalize() {
    if (!receipt?.staged.length || finalizing) return;
    setFinalizing(true); setError("");
    try {
      if (needsReadback) {
        const status = await window.desktop.accountSettings<"importStatus">({ action: "importStatus", id: receipt.id });
        if (status.status === "completed") { setSaved(status.counts.conversations); return; }
        if (status.expired || status.status !== "preview_ready") { setError(copy.stagingExpired); return; }
      }
      const expectedImportDigest = await externalImportSelectionDigest(receipt.staged.map(row => row.conversationDigest));
      if (!mounted.current) return;
      const result = await window.desktop.accountSettings<"finishImport">({
        action: "finishImport", id: receipt.id, key: receipt.key, expectedImportDigest,
        selectedConversationIds: receipt.staged.map(row => row.stagedConversationId),
      });
      if (mounted.current) setSaved(result.finalizedConversations);
    } catch {
      if (mounted.current) { setNeedsReadback(true); setError(copy.errorGeneric); }
    } finally {
      if (mounted.current) setFinalizing(false);
    }
  }

  const totals = preview?.totals;
  const warnings = totals ? [
    [totals.skippedNonConversationMessages, copy.warningSkippedMessages],
    [totals.skippedNonTextParts, copy.warningSkippedParts],
    [totals.additionalBranches, copy.warningBranches],
    [totals.skippedNestedArchives, copy.warningNestedArchives],
    [totals.missingAttachments, copy.warningMissingAttachments],
    [totals.duplicatedBranchMessages, copy.warningBranchDuplicates],
    [totals.unassignedTurns, copy.warningUnassignedTurns],
    [totals.skippedUnrecognizedAnswers, copy.warningUnrecognizedAnswers],
  ] as const : [];
  const busy = !!progress || finalizing;

  return <section className="account-settings-form account-settings-import" aria-label={copy.pageTitle}>
    <h3>{copy.pageTitle}</h3>
    {error && <p role="alert">{error}</p>}
    {saved !== undefined ? <p role="status">{format(copy.importCompleted, { count: saved })}</p> :
      receipt ? <>
        <h4>{copy.reviewTitle}</h4>
        <p>{format(copy.stagedSummary, { staged: receipt.staged.length, duplicates: receipt.duplicates })}</p>
        {!!receipt.truncated && <p>{format(copy.stagedTruncated, { count: receipt.truncated })}</p>}
        {!receipt.staged.length ? <p>{copy.allDuplicates}</p> : <div className="account-settings-actions">
          <button type="button" className="primary" disabled={finalizing} onClick={() => void finalize()}>
            {format(copy.reviewFinalizeCta, { count: receipt.staged.length })}
          </button>
        </div>}
        {finalizing && <p role="status">{copy.finalizingNotice}</p>}
      </> : progress ? <>
        <p role="status">{format(copy.preparingReviewProgress, progress)}</p>
        <p>{copy.preparingReviewNotSaved}</p>
      </> : preview ? <>
        <h4>{copy.previewTitle}</h4>
        <p>{format(copy.previewProvider, { provider: preview.provider })}</p>
        {preview.provider === "perplexity" && <p>{copy.perplexityStructureNotice}</p>}
        {warnings.some(([count]) => count > 0) && <ul aria-label={copy.warningsTitle}>{warnings.map(([count, description]) =>
          count ? <li key={description}>{format(description, { count })}</li> : null)}</ul>}
        <input type="search" value={filter} placeholder={copy.searchPlaceholder} aria-label={copy.searchPlaceholder}
          onChange={event => setFilter(event.currentTarget.value)} />
        <div className="account-settings-actions">
          <button type="button" className="soft" onClick={() => setSelected(new Set(rows.filter(row => row.importability.kind === "importable")
            .map(row => row.conversation.rawExternalConversationId)))}>{copy.selectAllNormal}</button>
          <button type="button" className="soft" onClick={() => setSelected(new Set())}>{copy.clearAllNormal}</button>
        </div>
        <div className="account-settings-import-choices">
          {rows.filter(row => row.conversation.title.toLocaleLowerCase(language).includes(filter.toLocaleLowerCase(language))).map(row => {
            const { conversation, importability } = row;
            const id = conversation.rawExternalConversationId;
            return <label key={id} className="account-settings-import-choice">
              <input type="checkbox" checked={selected.has(id)} disabled={importability.kind === "not_importable"} onChange={event => {
                const checked = event.currentTarget.checked;
                setSelected(previous => {
                  const next = new Set(previous);
                  if (checked) next.add(id); else next.delete(id);
                  return next;
                });
              }} />
              <span>{conversation.title}
                <small>{importability.kind === "requires_truncation_approval" ? copy.rowTruncationConsent :
                  importability.kind === "not_importable" ? copy.notImportableBadge :
                    format(copy.messagesCount, { count: conversation.messages.length })}</small>
              </span>
            </label>;
          })}
        </div>
        <p>{format(copy.selectionSummary, { selected: chosen.length, size: size(totalBytes) })}</p>
        {overCapacity && <p role="alert">{copy.quotaExceededWarning}</p>}
        <button type="button" className="primary" disabled={!chosen.length ||
          chosen.length > EXTERNAL_IMPORT_STORAGE_LIMITS.maxExternalConversationsPerAccount}
          onClick={() => void prepare()}>{copy.continueToReview}</button>
      </> : scan !== undefined ? <p role="status">{format(copy.parsingProgress, { conversations: scan })}</p> : <>
        <p>{copy.guideFormats}</p>
        <p>{filePrivacy[language]}</p>
        <p>{copy.guideMediaExcluded}</p>
        {capacity && <>
          <p>{format(copy.remainingSpace, { remaining: size(capacity.normalizedTextBytes) })}</p>
          <label>{copy.selectFile}<input type="file" accept=".zip,.json,.md,.markdown" onChange={event => {
            const file = event.currentTarget.files?.[0];
            if (file) scanFile(file);
          }} /></label>
        </>}
      </>}
    <div className="account-settings-actions">
      <button type="button" className="soft" disabled={busy} onClick={() => onClose(saved !== undefined)}>
        {saved !== undefined ? copy.stepDone : copy.cancel}
      </button>
    </div>
  </section>;
}
