import type { AssistantDetail, WorkspaceTransport } from "./iosWorkspaceContract";
import type { MobileCapabilities } from "./chatTransport";
import { buildBatchPayloads } from "../../../lib/externalImportPipeline";
import { EXTERNAL_IMPORT_PARSER_VERSION } from "../../../lib/externalImportAdapters";
import { externalImportSelectionDigest } from "../../../lib/externalImportSelectionDigest";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
const json = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const profilePath = (id: string) => `/api/assistant-profiles/${encodeURIComponent(id)}`;

/** Uses the existing credential transport; no cookie fallback or new bearer enrollment. */
export function createWorkspaceTransport(request: Request, capabilities: () => Promise<MobileCapabilities>, upload: (url: string, headers: Record<string, string>, file: File) => Promise<void>): WorkspaceTransport {
  const features: WorkspaceTransport["features"] = async () => {
    const value = (await capabilities()).workspace;
    return { assistantEditing: value?.assistantEditing === true, assistantKnowledge: value?.assistantKnowledge === true, externalImport: value?.externalImport === true };
  };
  async function requireFeature(key: keyof Awaited<ReturnType<typeof features>>) {
    if (!(await features())[key]) throw Error("NATIVE_WORKSPACE_UNAVAILABLE");
  }
  const assistant = async (id: string) => {
    await requireFeature("assistantEditing");
    return (await request<{ profile: AssistantDetail }>(profilePath(id), { cache: "no-store" })).profile;
  };
  return {
    features, assistant,
    createAssistant: async input => {
      await requireFeature("assistantEditing");
      // Create returns identity only; read the published revision before using it.
      const created = await request<{ profile: { id: string } }>("/api/assistant-profiles", json(input));
      return assistant(created.profile.id);
    },
    saveAssistant: async (profile, input) => {
      await requireFeature("assistantEditing");
      // Version first: a stale response never changes the identity either.
      await request(`${profilePath(profile.id)}/versions`, json({ expectedRevision: profile.currentVersion?.revision ?? null, instructions: input.instructions, modelIds: input.modelIds, toolPolicy: input.toolPolicy, memoryPolicy: input.memoryPolicy, starters: input.starters, knowledgeFileIds: input.knowledgeFileIds }));
      if (input.name !== profile.name) await request(profilePath(profile.id), json({ name: input.name }, "PATCH"));
      return assistant(profile.id);
    },
    knowledge: async id => { await requireFeature("assistantKnowledge"); return (await request<import("./iosWorkspaceContract").KnowledgeListing>(`${profilePath(id)}/knowledge`, { cache: "no-store" })); },
    uploadKnowledge: async (id, file) => {
      await requireFeature("assistantKnowledge");
      const path = `${profilePath(id)}/knowledge`, mime = file.type || "application/octet-stream";
      const prepared = await request<{ uploadKey: string; uploadUrl: string; uploadHeaders: Record<string, string> }>(path, json({ action: "prepare", filename: file.name, mime, bytes: file.size }));
      await upload(prepared.uploadUrl, prepared.uploadHeaders, file);
      await request(path, json({ action: "finalize", uploadKey: prepared.uploadKey, filename: file.name, mime }));
    },
    importCapacity: async () => { await requireFeature("externalImport"); return request("/api/imports/external/capacity", { cache: "no-store" }); },
    imports: async (offset = 0) => { await requireFeature("externalImport"); return request(`/api/external-conversations?offset=${offset}&limit=50`, { cache: "no-store" }); },
    source: async id => { await requireFeature("externalImport"); return request(`/api/external-conversations/${encodeURIComponent(id)}`, { cache: "no-store" }); },
    importText: async (provider, selected) => {
      await requireFeature("externalImport");
      const payloads = buildBatchPayloads(selected);
      if (!payloads.length) throw Error("EXTERNAL_IMPORT_EMPTY");
      const created = await request<{ importId: string }>("/api/imports/external", json({ provider, parserVersion: EXTERNAL_IMPORT_PARSER_VERSION }));
      const path = `/api/imports/external/${encodeURIComponent(created.importId)}`;
      const staged: Array<{ stagedConversationId: string; conversationDigest: string }> = []; let duplicates = 0;
      // Never retry an unknown write. The UI requires readback before a new attempt.
      for (const payload of payloads) {
        const receipt = await request<{ results: Array<{ outcome: string; stagedConversationId?: string; conversationDigest: string }> }>(`${path}/batches`, json(payload));
        for (const result of receipt.results) {
          if (result.outcome === "staged" && result.stagedConversationId) staged.push({ stagedConversationId: result.stagedConversationId, conversationDigest: result.conversationDigest });
          else if (result.outcome === "duplicate") duplicates++;
          else throw Error("EXTERNAL_IMPORT_RECEIPT_INVALID");
        }
      }
      await request(`${path}/seal`, json({ finalSequence: payloads.length - 1, expectedStagedConversationIds: staged.map(row => row.stagedConversationId), expectedDuplicateCount: duplicates }));
      if (staged.length) await request(`${path}/finalize`, json({ idempotencyKey: crypto.randomUUID(), selectedConversationIds: staged.map(row => row.stagedConversationId), expectedImportDigest: await externalImportSelectionDigest(staged.map(row => row.conversationDigest)) }));
    },
    continue: async (id, idempotencyKey) => { await requireFeature("externalImport"); return request(`/api/external-conversations/${encodeURIComponent(id)}/continuations`, json({ idempotencyKey })); },
  };
}
