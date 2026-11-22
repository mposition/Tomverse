import type { ApiFetch } from "./index";

/**
 * Deep Research (engine v2) HTTP transport, shared by Web and Native.
 *
 * A state-changing request whose response is lost is never re-sent: the
 * client reads the run back instead, so a committed write is shown and an
 * uncommitted one is not repeated without the user asking again. Every
 * server mutation is idempotent on its expected revision, which is what makes
 * that readback safe.
 */

export type ResearchAction =
  | { kind: "plan"; expectedPlanRevision: number; feedback?: string }
  | { kind: "plan-edit"; expectedPlanRevision: number; plan: unknown }
  | { kind: "approve"; planRevision: number }
  | { kind: "pause" } | { kind: "resume" } | { kind: "cancel" }
  | { kind: "budget"; expectedApprovedCredits: number; approvedCredits: number }
  | { kind: "scope"; expectedInputRevision: number; addQuestions?: string[]; excludeSourceKeys?: string[]; excludeDomains?: string[]; priorityNote?: string }
  | { kind: "revisions"; expectedReportRevision: number; revisionKind: "format" | "section_research" | "conditions" | "refresh" | "redact_public"; sectionKeys?: string[]; instruction?: string };

export class ResearchApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = "ResearchApiError"; }
}

async function readJson(response: Response) {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) throw new ResearchApiError(response.status, typeof body?.code === "string" ? body.code : "RESEARCH_UNAVAILABLE");
  return body ?? {};
}

const base = (runId: string) => `/api/chat/research/runs/${encodeURIComponent(runId)}`;
const json = (method: string, body: unknown): RequestInit => ({ method, cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export function createResearchApi(fetcher: ApiFetch) {
  const read = async (runId: string, signal?: AbortSignal) => (await readJson(await fetcher(base(runId), { cache: "no-store", signal }))).run;
  return {
    offer: async (profile: "standard" | "deep" = "standard", signal?: AbortSignal) =>
      readJson(await fetcher(`/api/chat/research/offer?profile=${profile}`, { cache: "no-store", signal })),
    create: async (payload: Record<string, unknown>) => {
      // A lost create response is retried with the same message ids; the server returns the existing run.
      return (await readJson(await fetcher("/api/chat/research/runs", json("POST", payload)))).run;
    },
    list: async (conversationId: string, signal?: AbortSignal) =>
      (await readJson(await fetcher(`/api/chat/research/runs?conversationId=${encodeURIComponent(conversationId)}`, { cache: "no-store", signal }))).runs as unknown[],
    read,
    /** Sends one action; on a lost or failed response, reads the run back instead of retrying. */
    act: async (runId: string, action: ResearchAction): Promise<{ run: unknown; readback: boolean; error?: ResearchApiError }> => {
      const { kind, ...rest } = action as ResearchAction & Record<string, unknown>;
      const { revisionKind, ...others } = rest as { revisionKind?: string };
      const body = kind === "revisions" ? { ...others, kind: revisionKind } : rest;
      try {
        const result = await readJson(await fetcher(`${base(runId)}/${kind}`, json("POST", JSON.parse(JSON.stringify(body)))));
        return { run: result.run, readback: false };
      } catch (error) {
        const run = await read(runId).catch(() => null);
        return { run, readback: true, ...(error instanceof ResearchApiError ? { error } : {}) };
      }
    },
    sources: async (runId: string, cursor?: string, visibility?: "public" | "private") =>
      readJson(await fetcher(`${base(runId)}/sources?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${visibility ? `&visibility=${visibility}` : ""}`, { cache: "no-store" })),
    evidence: async (runId: string, chunkId: string, start?: number, end?: number) =>
      readJson(await fetcher(`${base(runId)}/evidence?chunkId=${encodeURIComponent(chunkId)}${start !== undefined ? `&start=${start}` : ""}${end !== undefined ? `&end=${end}` : ""}`, { cache: "no-store" })),
    report: async (runId: string, revision?: number) =>
      readJson(await fetcher(`${base(runId)}/report${revision ? `?revision=${revision}` : ""}`, { cache: "no-store" })),
    exportFile: async (runId: string, format: "md" | "pdf" | "docx" | "csv" | "xlsx", revision?: number) => {
      const response = await fetcher(`${base(runId)}/export?format=${format}${revision ? `&revision=${revision}` : ""}`, { cache: "no-store" });
      if (!response.ok) { await response.text().catch(() => ""); throw new ResearchApiError(response.status, "RESEARCH_EXPORT_FAILED"); }
      return { blob: await response.blob(), disposition: response.headers.get("content-disposition") };
    },
    remove: async (runId: string) => readJson(await fetcher(base(runId), { method: "DELETE", cache: "no-store" })),
  };
}

export type ResearchApi = ReturnType<typeof createResearchApi>;
