import {
  ProjectWorkspaceError,
  type ProjectAnswerReceipt, type ProjectMaterial, type ProjectMemory, type ProjectSearchHit, type ProjectSummary, type ProjectWorkspaceClient,
} from "@tomverse/api-client";
import type { ChatSummary, Conversation, HistoryProject } from "./chatTransport";

/** Key of the account's personal memories inside the synthetic store. */
const PERSONAL = "__personal";
type StoredProject = Omit<ProjectSummary, "conversationCount" | "materialCount" | "memoryCount" | "readyMaterialCount" | "failedMaterialCount">;
type Store = {
  projects: StoredProject[];
  materials: Record<string, ProjectMaterial[]>;
  memories: Record<string, ProjectMemory[]>;
  receipts: Record<string, NonNullable<ProjectAnswerReceipt>>;
};

/**
 * Synthetic project workspace for the explicitly selected development demo.
 * It keeps the same shapes and refusals as the server (revision conflicts,
 * delete confirmation, archived projects) so the UI paths can be exercised.
 */
export function createDemoProjects(key: string, read: () => Conversation[], write: (items: Conversation[]) => void) {
  const storeKey = `${key}:project-workspace`;
  const load = (): Store => {
    const saved = JSON.parse(localStorage.getItem(storeKey) ?? "null") as Store | null;
    if (saved) return saved;
    // Folders created before workspaces existed stay folders (context off).
    const legacy = JSON.parse(localStorage.getItem(`${key}:projects`) ?? "[]") as HistoryProject[];
    const now = new Date().toISOString();
    return { projects: legacy.map(row => stored(row.id, row.name, now, false)), materials: {}, memories: {}, receipts: {} };
  };
  const save = (store: Store) => localStorage.setItem(storeKey, JSON.stringify(store));
  const stored = (id: string, name: string, now: string, contextEnabled: boolean): StoredProject => ({ id, name, description: "", instructions: "", contextEnabled,
    memoryScope: "project_only", autoMemoryEnabled: false, revision: 1, archivedAt: null, updatedAt: now, createdAt: now });
  const conversationsOf = (id: string) => read().filter(item => item.projectId === id);
  const summary = (store: Store, row: StoredProject): ProjectSummary => {
    const files = store.materials[row.id] ?? [];
    return { ...row, conversationCount: conversationsOf(row.id).length, materialCount: files.length, memoryCount: (store.memories[row.id] ?? []).length,
      readyMaterialCount: files.filter(file => file.processingStatus === "ready").length, failedMaterialCount: files.filter(file => file.processingStatus === "failed").length };
  };
  const owned = (store: Store, id: string) => {
    const row = store.projects.find(item => item.id === id);
    if (!row) throw new ProjectWorkspaceError(404, "PROJECT_NOT_FOUND");
    return row;
  };
  const change = (id: string, edit: (row: StoredProject, store: Store) => void) => {
    const store = load(); const row = owned(store, id);
    edit(row, store); row.updatedAt = new Date().toISOString(); save(store);
    return summary(store, row);
  };
  const touch = (row: StoredProject) => { row.revision += 1; };
  const material = (name: string, bytes: number, sourceKind: ProjectMaterial["sourceKind"], processingStatus: ProjectMaterial["processingStatus"] = "ready"): ProjectMaterial => ({
    id: crypto.randomUUID(), name, mime: "text/plain", bytes, processingStatus, failureCode: processingStatus === "failed" ? "EXTRACTION_FAILED" : null,
    chunkCount: 1, createdAt: new Date().toISOString(), processedAt: new Date().toISOString(), sourceKind, sourceRef: null });
  const deletion = (store: Store, id: string) => ({ conversations: conversationsOf(id).length, materials: (store.materials[id] ?? []).length, memories: (store.memories[id] ?? []).length, revision: owned(store, id).revision });

  const base: ProjectWorkspaceClient = {
    list: async () => { const store = load(); return store.projects.map(row => summary(store, row)); },
    detail: async id => { const store = load(); return summary(store, owned(store, id)); },
    create: async input => {
      const store = load();
      if (store.projects.some(row => row.name === input.name)) throw new ProjectWorkspaceError(409, "PROJECT_NAME_TAKEN");
      const row = { ...stored(crypto.randomUUID(), input.name, new Date().toISOString(), input.contextEnabled), description: input.description ?? "", instructions: input.instructions ?? "",
        memoryScope: input.memoryScope ?? "project_only", autoMemoryEnabled: input.autoMemoryEnabled ?? false };
      store.projects.push(row); save(store); return summary(store, row);
    },
    update: async (id, expectedRevision, patch) => change(id, row => {
      if (row.revision !== expectedRevision) throw new ProjectWorkspaceError(409, "PROJECT_REVISION_CONFLICT");
      const { archived, ...settings } = patch;
      Object.assign(row, settings);
      if (archived !== undefined) row.archivedAt = archived ? row.archivedAt ?? new Date().toISOString() : null;
      touch(row);
    }),
    rename: async (id, name) => change(id, row => { row.name = name; touch(row); }),
    deletionSummary: async id => deletion(load(), id),
    remove: async (id, confirmation) => {
      const store = load(); const now = deletion(store, id);
      const contextual = now.materials > 0 || now.memories > 0;
      if (contextual && !confirmation) throw new ProjectWorkspaceError(409, "PROJECT_DELETE_CONFIRMATION_REQUIRED", now);
      if (confirmation && (confirmation.revision !== now.revision || confirmation.materials !== now.materials || confirmation.memories !== now.memories)) throw new ProjectWorkspaceError(409, "PROJECT_DELETE_STALE", now);
      write(read().map(item => item.projectId === id ? { ...item, projectId: null } : item));
      store.projects = store.projects.filter(row => row.id !== id); delete store.materials[id]; delete store.memories[id]; save(store);
      return { success: true, detachedConversations: now.conversations, deletedMaterials: now.materials, deletedMemories: now.memories };
    },
    conversations: async id => conversationsOf(id).map(item => ({ id: item.id, title: item.title, productKey: item.productKey ?? null, kind: "chat", locked: Boolean((item as ChatSummary).isLocked),
      continuation: null, messageCount: item.messages.length, updatedAt: new Date().toISOString() })),

    materials: async id => {
      const store = load();
      return { files: store.materials[id] ?? [], capacity: { limits: { maxFileBytes: 20 * 1048576, maxFilesPerProfile: 20, maxFilesPerAccount: 100 },
        remaining: { filesInProfile: 20 - (store.materials[id]?.length ?? 0), filesInAccount: 100 }, acceptedMediaTypes: ["text/plain", "application/pdf", "text/markdown"] } };
    },
    uploadMaterial: async (id, file) => {
      let created!: ProjectMaterial;
      change(id, (row, store) => { if (row.archivedAt) throw new ProjectWorkspaceError(409, "PROJECT_ARCHIVED"); created = material(file.name, file.size, "upload"); store.materials[id] = [...(store.materials[id] ?? []), created]; touch(row); });
      return { file: { id: created.id, name: created.name, processingStatus: created.processingStatus } };
    },
    addNote: async (id, title, text, clientRequestId) => {
      let created!: ProjectMaterial; let fresh = true;
      change(id, (row, store) => {
        if (row.archivedAt) throw new ProjectWorkspaceError(409, "PROJECT_ARCHIVED");
        const existing = (store.materials[id] ?? []).find(file => file.sourceRef?.clientRequestId === clientRequestId);
        if (existing) { created = existing; fresh = false; return; }
        created = { ...material(title, text.length, "note"), sourceRef: { clientRequestId } };
        store.materials[id] = [...(store.materials[id] ?? []), created]; touch(row);
      });
      return { created: fresh, file: created };
    },
    saveSource: async (id, source) => {
      let created!: ProjectMaterial;
      change(id, (row, store) => { created = material("Saved source", 1, source.sourceKind); store.materials[id] = [...(store.materials[id] ?? []), created]; touch(row); });
      return { created: true, file: created };
    },
    retryMaterial: async (id, fileId) => { change(id, (row, store) => { store.materials[id] = (store.materials[id] ?? []).map(file => file.id === fileId ? { ...file, processingStatus: "ready", failureCode: null } : file); touch(row); }); return { retried: true as const }; },
    materialLink: async (id, fileId) => { const file = (load().materials[id] ?? []).find(item => item.id === fileId); if (!file) throw new ProjectWorkspaceError(404, "PROJECT_FILE_NOT_FOUND"); return { url: `data:text/plain,${encodeURIComponent(file.name)}`, name: file.name, mime: file.mime }; },
    deleteMaterial: async (id, fileId) => { change(id, (row, store) => { store.materials[id] = (store.materials[id] ?? []).filter(file => file.id !== fileId); touch(row); }); return { deleted: true as const }; },

    memories: async id => { const memories = load().memories[id] ?? []; return { memories, total: memories.length }; },
    personalMemories: async id => { owned(load(), id); const memories = load().memories[PERSONAL] ?? []; return { memories, total: memories.length }; },
    createMemory: async (id, input) => {
      const memoryId = crypto.randomUUID();
      change(id, (row, store) => { store.memories[id] = [...(store.memories[id] ?? []), { id: memoryId, kind: input.kind, statement: input.statement, status: "active", pinned: false, revision: 1, userEdited: true, projectId: id,
        suspendedReason: null, expiresAt: null, evidence: [{ id: crypto.randomUUID(), sourceType: "manual", manualContent: input.groundsText, sourceTitle: null }] }]; touch(row); });
      return { memoryId };
    },
    editMemory: async (id, memoryId, statement) => { change(id, (_row, store) => { store.memories[id] = (store.memories[id] ?? []).map(item => item.id === memoryId ? { ...item, statement, userEdited: true, revision: item.revision + 1 } : item); }); return { ok: true as const }; },
    pinMemory: async (id, memoryId, pinned) => { change(id, (_row, store) => { store.memories[id] = (store.memories[id] ?? []).map(item => item.id === memoryId ? { ...item, pinned, revision: item.revision + 1 } : item); }); return { ok: true as const }; },
    deleteMemory: async (id, memoryId) => { change(id, (row, store) => { store.memories[id] = (store.memories[id] ?? []).filter(item => item.id !== memoryId); touch(row); }); return { outcome: "deleted" as const }; },
    moveMemory: async (memoryId, expectedRevision, target) => {
      const store = load();
      for (const [projectId, list] of Object.entries(store.memories)) {
        const found = list.find(item => item.id === memoryId);
        if (!found) continue;
        if (found.revision !== expectedRevision) throw new ProjectWorkspaceError(409, "MEMORY_ITEM_STATE");
        if (projectId === (target ?? PERSONAL)) return { moved: false, projectId: target };
        if (target && owned(store, target).archivedAt) throw new ProjectWorkspaceError(409, "PROJECT_ARCHIVED");
        if ((store.memories[target ?? PERSONAL] ?? []).some(item => item.statement === found.statement)) throw new ProjectWorkspaceError(409, "MEMORY_ITEM_CONFLICT");
        store.memories[projectId] = list.filter(item => item.id !== memoryId);
        store.memories[target ?? PERSONAL] = [...(store.memories[target ?? PERSONAL] ?? []), { ...found, projectId: target, revision: found.revision + 1 }];
        save(store); return { moved: true, projectId: target };
      }
      return { moved: false, projectId: null };
    },

    search: async (id, query) => {
      const store = load(); const needle = query.toLowerCase(); const hits: ProjectSearchHit[] = [];
      for (const item of conversationsOf(id)) for (const message of item.messages) if (message.content.toLowerCase().includes(needle))
        hits.push({ ref: `msg:${item.id}:${message.id}`, location: { kind: "message", conversationId: item.id, messageId: message.id }, title: item.title, role: message.role, snippet: message.content.slice(0, 160) });
      for (const file of store.materials[id] ?? []) if (file.name.toLowerCase().includes(needle))
        hits.push({ ref: `mat:${file.id}`, location: { kind: "material", fileId: file.id }, title: file.name, role: null, snippet: file.name });
      return { status: hits.length ? "ok" : "empty", hits: hits.slice(0, 12), incomplete: [] };
    },
    readSource: async (id, ref) => {
      const [kind, first, second] = ref.split(":");
      if (kind === "msg") {
        const message = read().find(item => item.id === first && item.projectId === id)?.messages.find(item => item.id === second);
        if (message) return { status: "ok" as const, location: { kind: "message" as const, conversationId: first, messageId: second }, title: "Conversation", role: message.role, content: message.content, createdAt: null };
      }
      if (kind === "mat") {
        const file = (load().materials[id] ?? []).find(item => item.id === first);
        if (file) return { status: "ok" as const, location: { kind: "material" as const, fileId: first }, title: file.name, role: null, content: `Synthetic content of ${file.name}`, createdAt: file.createdAt };
      }
      return { status: "unavailable" as const, reason: "not_found" };
    },
    receipt: async messageId => load().receipts[messageId] ?? null,
    moveConversation: async (conversationId, projectId) => {
      if (projectId) { const store = load(); if (owned(store, projectId).archivedAt) throw new ProjectWorkspaceError(409, "PROJECT_ARCHIVED"); }
      write(read().map(item => item.id === conversationId ? { ...item, projectId } : item));
      return { projectId };
    },
  };

  // The synthetic UI suite can switch the whole workspace off, as a server with the native switch off answers.
  const client = Object.fromEntries(Object.entries(base).map(([name, call]) => [name, (...args: unknown[]) =>
    localStorage.getItem(`${key}:projects-unavailable`) === "1" ? Promise.reject(new ProjectWorkspaceError(503, "NATIVE_ROUTE_UNAVAILABLE")) : (call as (...input: unknown[]) => Promise<unknown>)(...args)])) as ProjectWorkspaceClient;

  return {
    client,
    /** Folder-style list used by the conversation filter. */
    history: (): HistoryProject[] => { const store = load(); return store.projects.map(row => ({ id: row.id, name: row.name, conversationCount: conversationsOf(row.id).length })); },
    saveFolder: (id: string | null, name: string) => {
      const store = load(); const now = new Date().toISOString();
      if (id) { const row = owned(store, id); row.name = name; row.updatedAt = now; } else store.projects.push(stored(crypto.randomUUID(), name, now, false));
      save(store);
    },
    /** Records which sources an answer was given, as the server's receipt does. */
    recordReceipt: (projectId: string, messageId: string, references: readonly string[]) => {
      const store = load(); const row = owned(store, projectId);
      if (!row.contextEnabled) return;
      const first = (store.materials[projectId] ?? [])[0];
      const named = (ref: string) => (store.materials[projectId] ?? []).find(file => ref === `mat:${file.id}`)?.name ?? "Conversation";
      store.receipts[messageId] = { projectId, createdAt: new Date().toISOString(), sources: [
        ...references.map(ref => ({ ref, kind: ref.startsWith("mat:") ? "material" : "message", title: named(ref), via: "context" as const })),
        ...(first ? [{ ref: `mat:${first.id}`, kind: "material", title: first.name, via: "tool" as const }] : []),
      ] };
      save(store);
    },
    assertUsable: (projectId: string) => { if (owned(load(), projectId).archivedAt) throw Object.assign(Error("PROJECT_ARCHIVED"), { status: 409, code: "PROJECT_ARCHIVED" }); },
    clear: () => localStorage.removeItem(storeKey),
  };
}
