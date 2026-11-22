"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { ResearchPreviewRunDto } from "../../lib/researchPreviewRunTypes";
import type { ResearchPreviewMetadata } from "../../lib/researchPreviewMetadata";
import { researchRunNeedsPolling, type ResearchPreviewRunTransport } from "../../lib/researchPreviewRunClient";
import { researchPreviewCopy } from "../../locales/researchPreview";
import type { Language } from "../../lib/language";
import { ProjectSaveToProject } from "../projects/ProjectSaveToProject";

type RunAction = "resume" | "cancel";
type RunCardState = {
  scopeKey: string;
  transport: ResearchPreviewRunTransport;
  run?: ResearchPreviewRunDto;
  error?: boolean;
  busy?: boolean;
};

export function ResearchPreviewRunCard({ runId, conversationId, assistantMessageId, language, transport, onMessage, reportOutcome }: {
  runId: string; conversationId: string; assistantMessageId: string; language: Language;
  transport: ResearchPreviewRunTransport;
  onMessage?: (run: ResearchPreviewRunDto) => void;
  reportOutcome?: ResearchPreviewMetadata["outcome"];
}) {
  const copy = researchPreviewCopy[language];
  const scopeKey = JSON.stringify([runId, conversationId, assistantMessageId]);
  const [state, setState] = useState<RunCardState>();
  const { run, error, busy } = state?.scopeKey === scopeKey && state.transport === transport ? state : {};
  const controls = useRef<{ action: (kind: RunAction) => Promise<void>; refresh: () => void } | null>(null);
  const messageCallback = useRef(onMessage);
  useLayoutEffect(() => { messageCallback.current = onMessage; }, [onMessage]);

  useLayoutEffect(() => {
    let active = true;
    let actionPending = false;
    let poll: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function update(next: Partial<Pick<RunCardState, "run" | "error" | "busy">>) {
      setState(previous => ({
        ...(previous?.scopeKey === scopeKey && previous.transport === transport ? previous : {}),
        ...next, scopeKey, transport,
      }));
    }
    function stopPolling() {
      poll?.abort();
      clearTimeout(timer);
    }
    function publish(value: ResearchPreviewRunDto) {
      if (value.id !== runId || value.conversationId !== conversationId || value.assistantMessageId !== assistantMessageId ||
        (value.message && (value.message.id !== assistantMessageId || value.message.role !== "assistant"))) {
        throw new Error("RESEARCH_RUN_SCOPE_MISMATCH");
      }
      update({ run: value, error: false });
      if (researchRunNeedsPolling(value.status)) timer = setTimeout(read, 5000);
      if (value.message) messageCallback.current?.(value);
    }
    async function read() {
      stopPolling();
      const controller = new AbortController();
      poll = controller;
      try {
        const value = await transport.read(runId, controller.signal);
        if (active && !controller.signal.aborted) publish(value);
      } catch {
        if (active && !controller.signal.aborted) update({ error: true });
      }
    }
    controls.current = {
      async action(kind) {
        if (actionPending) return;
        actionPending = true;
        stopPolling();
        update({ busy: true, error: false });
        try {
          const value = await transport[kind](runId);
          if (active) publish(value);
        } catch {
          // A lost response can follow a committed action. Read back without retrying the write.
          if (active) await read();
        } finally {
          actionPending = false;
          if (active) update({ busy: false });
        }
      },
      refresh() { if (!actionPending) void read(); },
    };
    void read();
    return () => {
      active = false;
      stopPolling();
      controls.current = null;
    };
  }, [runId, conversationId, assistantMessageId, scopeKey, transport]);

  const label = run ? ({ queued: copy.researchRunQueued, running: copy.researchRunRunning,
    checkpointed: copy.researchRunCheckpointed, completed: copy.researchRunCompleted,
    failed: copy.researchPreviewOutcomeFailed, cancelled: copy.researchPreviewOutcomeCancelled,
    attention: copy.researchRunAttention }[run.status]) : copy.researchRunLoading;
  const reportLabel = reportOutcome && ({
    complete: copy.researchReportComplete,
    partial: copy.researchReportPartial,
    insufficient_evidence: copy.researchReportInsufficient,
    failed: undefined,
    cancelled: undefined,
  }[reportOutcome]);
  return <div className="research-run-card" data-testid="research-run-card" data-run-status={run?.status ?? "loading"}>
    <p role="status"><strong>{copy.researchPreviewTitle}</strong> · {label}</p>
    {reportLabel && <p data-testid="research-preview-result" data-outcome={reportOutcome}>{reportLabel}</p>}
    {run && <p data-testid="research-run-counts">{copy.researchRunCounts.replace("{steps}", String(run.stepCount)).replace("{searches}", String(run.searchCount)).replace("{pages}", String(run.readCount))}</p>}
    {run?.status === "queued" && <p>{copy.researchRunQueueHint}</p>}
    {run?.status === "checkpointed" && run.canResume && <button type="button" disabled={busy || error} data-testid="research-run-resume" onClick={() => void controls.current?.action("resume")}>{copy.researchRunResume}</button>}
    {run && ["queued", "running", "checkpointed"].includes(run.status) && <button type="button" disabled={busy || error} data-testid="research-run-cancel" onClick={() => void controls.current?.action("cancel")}>{copy.researchRunCancel}</button>}
    {run?.status === "completed" && <ProjectSaveToProject testId="research-save-to-project" source={{ sourceKind: "research_report", runId }} />}
    {error && <p role="alert">{copy.researchRunReadError} <button type="button" disabled={busy} onClick={() => controls.current?.refresh()}>{copy.researchRunRefresh}</button></p>}
  </div>;
}
