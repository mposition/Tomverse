import type { AssistantDetail, ExternalDetail, WorkspaceTransport } from "./iosWorkspaceContract";
import type { Conversation } from "./chatTransport";

/** Development-only fixtures. The production entry never imports this module. */
export function createDemoWorkspace(key: string, addConversation: (item: Conversation) => void) {
  const initial: AssistantDetail = { id: "demo-assistant", name: "Synthetic writing assistant", currentVersion: { revision: 1, instructions: "Use plain language.", models: [], toolPolicy: { webSearch: false, deepResearch: false }, memoryPolicy: { useAccountMemory: false }, starters: [], knowledgeManifest: [] }, knowledgeFiles: [] };
  const profiles = (): AssistantDetail[] => JSON.parse(localStorage.getItem(key + ":assistants") ?? JSON.stringify([initial]));
  const saveProfiles = (rows: AssistantDetail[]) => localStorage.setItem(key + ":assistants", JSON.stringify(rows));
  const originals = (): ExternalDetail[] => JSON.parse(localStorage.getItem(key + ":imports") ?? "[]");
  const workspace: WorkspaceTransport = {
    features: async () => ({ assistantEditing: true, assistantKnowledge: true, externalImport: true }),
    assistant: async id => structuredClone(profiles().find(row => row.id === id)!),
    createAssistant: async input => { const profile = { ...structuredClone(initial), id: crypto.randomUUID(), name: input.name, currentVersion: { ...initial.currentVersion!, instructions: input.instructions, models: input.modelIds } }; saveProfiles([...profiles(), profile]); return profile; },
    saveAssistant: async (profile, input) => {
      const current = profiles().find(row => row.id === profile.id)!;
      if (current.currentVersion?.revision !== profile.currentVersion?.revision) throw Object.assign(Error("Stale revision"), { code: "ASSISTANT_PROFILE_VERSION_STALE" });
      const next = { ...current, name: input.name, currentVersion: { revision: (current.currentVersion?.revision ?? 0) + 1, instructions: input.instructions, models: input.modelIds, toolPolicy: input.toolPolicy, memoryPolicy: input.memoryPolicy, starters: input.starters, knowledgeManifest: input.knowledgeFileIds.map(fileId => ({ fileId })) } };
      saveProfiles(profiles().map(row => row.id === profile.id ? next : row)); return next;
    },
    knowledge: async id => ({ files: profiles().find(row => row.id === id)!.knowledgeFiles, capacity: { limits: { maxFileBytes: 33554432 }, remaining: { filesInProfile: 20, filesInAccount: 100, objectBytes: 524288000 }, acceptedMediaTypes: ["text/plain", "application/pdf"] } }),
    importCapacity: async () => ({ remaining: { externalConversations: 500, externalMessages: 10000, normalizedTextBytes: 52428800 } }),
    uploadKnowledge: async (id, file) => { saveProfiles(profiles().map(row => row.id === id ? { ...row, knowledgeFiles: [...row.knowledgeFiles, { id: crypto.randomUUID(), name: file.name, processingStatus: "ready" }] } : row)); },
    imports: async (offset = 0) => ({ conversations: originals().slice(offset, offset + 50), total: originals().length, continuationEnabled: true }),
    source: async id => originals().find(row => row.id === id)!,
    importText: async (provider, selected) => { const rows = originals(); for (const row of selected) rows.push({ id: crypto.randomUUID(), provider, title: row.title, locked: false, messageCount: row.messages.length, messages: row.messages.map(message => ({ id: message.rawExternalMessageId, role: message.role, content: message.content })) }); localStorage.setItem(key + ":imports", JSON.stringify(rows)); },
    continue: async (id, requestKey) => {
      const receiptKey = key + ":continuation:" + requestKey, existing = localStorage.getItem(receiptKey);
      if (existing) return { conversationId: existing };
      const source = originals().find(row => row.id === id)!, conversationId = crypto.randomUUID();
      addConversation({ id: conversationId, title: source.title, productKey: "chat", surface: "continuation", selectedModels: ["demo"], selectionMode: "auto", messages: [], imported: { provider: source.provider, importedAt: new Date().toISOString(), status: "available", offset: 0, pageSize: 100, messages: source.messages.map(message => ({ ...message, role: message.role as "user" | "assistant", sourceModelLabel: null })) } });
      localStorage.setItem(receiptKey, conversationId); return { conversationId };
    },
  };
  return { workspace, profiles };
}
