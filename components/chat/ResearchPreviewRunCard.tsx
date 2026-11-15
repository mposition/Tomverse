"use client";

import { useEffect, useRef, useState } from "react";
import type { ResearchPreviewRunDto } from "../../lib/researchPreviewRunTypes";
import { researchRunNeedsPolling, type ResearchPreviewRunTransport } from "../../lib/researchPreviewRunClient";
import { researchPreviewCopy } from "../../locales/researchPreview";
import type { Language } from "../../lib/language";

export function ResearchPreviewRunCard({ runId, conversationId, assistantMessageId, language, transport, onMessage }: {
  runId: string; conversationId: string; assistantMessageId: string; language: Language;
  transport: ResearchPreviewRunTransport;
  onMessage?: (run: ResearchPreviewRunDto) => void;
}) {
  const copy = researchPreviewCopy[language];
  const [run, setRun] = useState<ResearchPreviewRunDto | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const messageCallback = useRef(onMessage);
  useEffect(() => { messageCallback.current = onMessage; }, [onMessage]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const value = await transport.read(runId, controller.signal);
        if (controller.signal.aborted) return;
        if (value.conversationId !== conversationId || value.assistantMessageId !== assistantMessageId ||
          (value.message && (value.message.id !== assistantMessageId || value.message.role !== "assistant"))) throw new Error("RESEARCH_RUN_SCOPE_MISMATCH");
        setRun(value); setError(false);
        if (value.message) messageCallback.current?.(value);
        if (researchRunNeedsPolling(value.status)) timer = setTimeout(read, 5000);
      } catch { if (!controller.signal.aborted) setError(true); }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [runId, conversationId, assistantMessageId, transport, revision]);
  async function action(kind: "resume" | "cancel") {
    if (busy) return;
    setBusy(true); setError(false);
    try {
      const value = await transport[kind](runId);
      if (value.conversationId !== conversationId || value.assistantMessageId !== assistantMessageId ||
        (value.message && (value.message.id !== assistantMessageId || value.message.role !== "assistant"))) throw new Error("RESEARCH_RUN_SCOPE_MISMATCH");
      setRun(value); if (value.message) messageCallback.current?.(value);
      setRevision(value => value + 1);
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  const label = run ? ({ queued: copy.researchRunQueued, running: copy.researchRunRunning,
    checkpointed: copy.researchRunCheckpointed, completed: copy.researchPreviewOutcomeComplete,
    failed: copy.researchPreviewOutcomeFailed, cancelled: copy.researchPreviewOutcomeCancelled,
    attention: copy.researchRunAttention }[run.status]) : copy.researchRunLoading;
  return <div className="research-run-card" data-testid="research-run-card" data-run-status={run?.status ?? "loading"}>
    <p role="status"><strong>{copy.researchPreviewTitle}</strong> · {label}</p>
    {run && <p data-testid="research-run-counts">{copy.researchRunCounts.replace("{steps}", String(run.stepCount)).replace("{searches}", String(run.searchCount)).replace("{pages}", String(run.readCount))}</p>}
    {run?.status === "queued" && <p>{copy.researchRunQueueHint}</p>}
    {run?.status === "checkpointed" && run.canResume && <button type="button" disabled={busy || error} data-testid="research-run-resume" onClick={() => void action("resume")}>{copy.researchRunResume}</button>}
    {run && ["queued", "running", "checkpointed"].includes(run.status) && <button type="button" disabled={busy || error} data-testid="research-run-cancel" onClick={() => void action("cancel")}>{copy.researchRunCancel}</button>}
    {error && <p role="alert">{copy.researchRunReadError} <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}>{copy.researchRunRefresh}</button></p>}
  </div>;
}
