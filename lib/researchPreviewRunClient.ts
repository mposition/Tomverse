import type { ResearchPreviewRunDto } from "./researchPreviewRunTypes";
import type { Message } from "../components/chat/types";

export type ResearchPreviewRunTransport = {
  read(id: string, signal?: AbortSignal): Promise<ResearchPreviewRunDto>;
  resume(id: string): Promise<ResearchPreviewRunDto>;
  cancel(id: string): Promise<ResearchPreviewRunDto>;
};

/** Browser reads never create or resume a run, including after an unknown write. */
export const webResearchPreviewRuns: ResearchPreviewRunTransport = {
  read: (id, signal) => researchRunRequest(id, undefined, signal),
  resume: id => researchRunRequest(id, "resume"),
  cancel: id => researchRunRequest(id, "cancel"),
};

async function researchRunRequest(id: string, action?: "resume" | "cancel", signal?: AbortSignal): Promise<ResearchPreviewRunDto> {
  const response = await fetch(`/api/chat/research-preview/runs/${encodeURIComponent(id)}${action ? `/${action}` : ""}`, {
    method: action ? "POST" : "GET", cache: "no-store", signal,
  });
  const value = await response.json().catch(() => null);
  const run = value?.run;
  if (!response.ok || !run || run.id !== id) throw new Error("RESEARCH_RUN_UNAVAILABLE");
  return run;
}

export const researchRunNeedsPolling = (status: string) => status === "queued" || status === "running";

export function researchRunMessage(run: ResearchPreviewRunDto): Message {
  const message = run.message;
  return {
    id: run.assistantMessageId, role: "assistant", researchRunId: run.id,
    modelId: run.modelId, content: message?.content ?? "",
    status: message?.status === "normal" || message?.status === "incomplete" ? message.status
      : run.status === "cancelled" ? "cancelled" : run.status === "failed" || run.status === "attention" ? "error" : "pending",
    ...(message?.searchMetadata ? { searchMetadata: message.searchMetadata as Message["searchMetadata"] } : {}),
    // A delegated task's file arrives with the answer it belongs to (the server allowlist, lib/publicChatMessage.ts).
    ...(Array.isArray(message?.artifacts) && message.artifacts.length ? { artifacts: message.artifacts as Message["artifacts"] } : {}),
    createdAt: String(message?.createdAt ?? run.createdAt),
  };
}
