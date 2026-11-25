import { randomUUID } from "node:crypto";
import { createResearchApi, ResearchApiError, type ResearchAction } from "../../../../packages/api-client/src/research";
import { filenameFromContentDisposition, type ApiFetch } from "../../../../packages/api-client/src/index";
import { researchBriefSchema } from "../../../../lib/researchEngineContract";
import type { DesktopResearchInput, DesktopResearchOutcome, ResearchStep } from "../research-contract";
import type { AccountSettingsApi } from "./account-settings-api";

/**
 * Desktop Research (engine v2 and Preview) on the account session.
 *
 * Neither route family is on the Desktop bearer allowlist, so each call is made with the short-lived
 * account session cookie, exactly as the web does. A paid or state-changing request whose outcome is
 * unknown is never sent again: the shared client reads the run back, and a Preview start looks the
 * run up by its response identity before reporting a failure.
 */

const RESEARCH_PATH = /^\/api\/chat\/research(?:-preview)?\/(?:offer|runs)(?:[/?]|$)/;
const EXPORT_LIMIT = 64 * 1024 * 1024;

export type ResearchChat = {
  /** Creates the conversation when there is none, saves the question there and returns the saved ids. */
  saveQuestion(input: { conversationId?: string; requestId: string; question: string; modelId: string }): Promise<{ conversationId: string; sourceUserMessageId: string }>;
};

export type ResearchIo = {
  /** Writes exported bytes through the app's save dialog; false when cancelled. */
  saveExport(load: () => Promise<{ bytes: Uint8Array; suggestedName: string; extension: string }>): Promise<boolean>;
  chat: ResearchChat;
  newId?: () => string;
};

export function researchTransport(settings: Pick<AccountSettingsApi, "send" | "forget">): ApiFetch {
  return async (path, init) => {
    if (!RESEARCH_PATH.test(path) || path.includes("..")) throw new Error("This path is not a Research route.");
    const method = (init?.method ?? "GET") as "GET" | "POST" | "DELETE";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as object : undefined;
    const timeout = path.includes("/export?") ? 120_000 : method === "GET" ? undefined : 30_000;
    const response = await settings.send({ path, method, body }, "*/*", timeout);
    if (response.status === 401) settings.forget();
    return response;
  };
}

/** The shared client's action for a Desktop step; revisions rename `revisionKind` the way the client expects. */
export function researchActionFor(step: ResearchStep): ResearchAction {
  return step.kind === "scope" ? { kind: "scope", expectedInputRevision: step.expectedInputRevision, addQuestions: step.addQuestions } : step;
}

function failure(error: unknown): DesktopResearchOutcome {
  if (error instanceof ResearchApiError) return { ok: false, status: error.status, code: error.code };
  if (error instanceof Error && error.name === "AbortError") throw error;
  return { ok: false, status: 0, code: "RESEARCH_UNAVAILABLE" };
}

export function createResearchRunner(settings: Pick<AccountSettingsApi, "send" | "forget">, io: ResearchIo) {
  const fetcher = researchTransport(settings);
  const api = createResearchApi(fetcher);
  const newId = io.newId ?? randomUUID;
  const json = (method: string, body: unknown): RequestInit => ({ method, cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  async function call(path: string, init?: RequestInit) {
    const response = await fetcher(path, { cache: "no-store", ...init });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new ResearchApiError(response.status, typeof body?.code === "string" ? body.code : "RESEARCH_UNAVAILABLE");
    return body ?? {};
  }

  async function startPreview(input: Extract<DesktopResearchInput, { action: "previewStart" }>["input"]): Promise<DesktopResearchOutcome> {
    const saved = await io.chat.saveQuestion({ conversationId: input.conversationId, requestId: input.requestId, question: input.question, modelId: input.modelId });
    const assistantMessageId = newId();
    try {
      const { run } = await call("/api/chat/research-preview/runs", json("POST", {
        conversationId: saved.conversationId, sourceUserMessageId: saved.sourceUserMessageId, assistantMessageId, modelId: input.modelId,
        ...(input.locale ? { locale: input.locale } : {}),
      })) as { run: never };
      return { ok: true, value: { run, conversationId: saved.conversationId } as never };
    } catch (error) {
      // The request may have been accepted before the response was lost: look the run up, never send it again.
      const found = await call(`/api/chat/research-preview/runs?assistantMessageId=${encodeURIComponent(assistantMessageId)}`).catch(() => null) as { runs?: unknown[] } | null;
      const run = found?.runs?.[0];
      if (run) return { ok: true, value: { run, conversationId: saved.conversationId } as never };
      return { ...failure(error), conversationId: saved.conversationId } as DesktopResearchOutcome;
    }
  }

  async function execute(input: DesktopResearchInput): Promise<unknown> {
    switch (input.action) {
      case "offer": return api.offer(input.profile);
      case "create": {
        // The brief is parsed again here so the request carries exactly the schema's defaults.
        const payload = { ...input.payload, brief: researchBriefSchema.parse(input.payload.brief) };
        return api.create(payload);
      }
      case "runs": return (await call(`/api/chat/research-preview/runs?conversationId=${encodeURIComponent(input.conversationId)}`)).runs;
      case "read": return api.read(input.runId);
      case "act": {
        const result = await api.act(input.runId, researchActionFor(input.step));
        return { run: result.run ?? null, readback: result.readback, ...(result.error ? { error: { status: result.error.status, code: result.error.code } } : {}) };
      }
      case "sources": return api.sources(input.runId, input.cursor);
      case "evidence": return api.evidence(input.runId, input.chunkId, input.start, input.end);
      case "report": return api.report(input.runId, input.revision);
      case "export": {
        const file = await api.exportFile(input.runId, input.format, input.revision);
        if (file.blob.size > EXPORT_LIMIT) throw new ResearchApiError(413, "RESEARCH_EXPORT_FAILED");
        return io.saveExport(async () => ({
          bytes: new Uint8Array(await file.blob.arrayBuffer()),
          suggestedName: filenameFromContentDisposition(file.disposition, `research.${input.format}`), extension: input.format,
        }));
      }
      case "remove": return api.remove(input.runId);
      case "previewOffer": return call("/api/chat/research-preview/offer", json("POST", { ...input.input, ...(input.input.conversationId ? {} : { selectionMode: "manual" }) }));
      case "previewStart": return startPreview(input.input);
      case "previewRead": return (await call(`/api/chat/research-preview/runs/${encodeURIComponent(input.runId)}`)).run;
      case "previewAct": return (await call(`/api/chat/research-preview/runs/${encodeURIComponent(input.runId)}/${input.step}`, { method: "POST" })).run;
    }
  }

  return async function run(input: DesktopResearchInput): Promise<DesktopResearchOutcome> {
    try {
      const value = await execute(input);
      // A preview start answers with its own outcome, including a refusal that still saved the question.
      if (input.action === "previewStart") return value as DesktopResearchOutcome;
      return { ok: true, value: value as never };
    } catch (error) {
      return failure(error);
    }
  };
}

export type ResearchRunner = ReturnType<typeof createResearchRunner>;
