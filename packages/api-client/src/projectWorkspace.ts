import type { ApiFetch } from "./index";

/**
 * Project workspace client, shared by the web app and the native shell.
 * Framework-neutral: the transport is injected (session cookies on web, the
 * native bearer adapter on device) and nothing here decides access -- every
 * call is re-checked by the server.
 */

export type ProjectMemoryScope = "project_only" | "project_and_personal";

export type ProjectSummary = {
    id: string;
    name: string;
    description: string;
    instructions: string;
    contextEnabled: boolean;
    memoryScope: ProjectMemoryScope;
    autoMemoryEnabled: boolean;
    revision: number;
    archivedAt: string | null;
    conversationCount: number;
    materialCount: number;
    memoryCount: number;
    updatedAt: string;
    createdAt: string;
    readyMaterialCount?: number;
    failedMaterialCount?: number;
};

export type ProjectSettingsPatch = Partial<Pick<ProjectSummary, "name" | "description" | "instructions" | "contextEnabled" | "memoryScope" | "autoMemoryEnabled">> & {
    archived?: boolean;
};

export type ProjectDeletionSummary = { conversations: number; materials: number; memories: number; revision: number };

export type ProjectMaterial = {
    id: string;
    name: string;
    mime: string;
    bytes: number;
    processingStatus: "pending" | "processing" | "ready" | "failed";
    failureCode: string | null;
    chunkCount: number;
    createdAt: string;
    processedAt: string | null;
    sourceKind: "upload" | "note" | "message_attachment" | "generated_artifact" | "review_result" | "research_report";
    sourceRef: Record<string, unknown> | null;
};

export type ProjectMaterialCapacity = {
    limits: { maxFileBytes: number; maxFilesPerProfile: number; maxFilesPerAccount: number };
    remaining: Record<string, number>;
    acceptedMediaTypes: string[];
};

export type ProjectMemory = {
    id: string;
    kind: string;
    statement: string;
    status: string;
    pinned: boolean;
    revision: number;
    userEdited: boolean;
    projectId: string | null;
    suspendedReason: string | null;
    expiresAt: string | null;
    evidence: Array<{ id: string; sourceType: string; manualContent: string | null; sourceTitle: string | null; conversationId?: string | null }>;
};

export type ProjectSearchHit = {
    ref: string;
    location: { kind: "message" | "imported" | "material"; conversationId?: string; messageId?: string; fileId?: string; ordinal?: number };
    title: string;
    role: string | null;
    snippet: string;
};

export type ProjectSearchAnswer = { status: "ok" | "partial" | "empty"; hits: ProjectSearchHit[]; incomplete: string[] };

export type ProjectSourceRead =
    | { status: "ok"; location: ProjectSearchHit["location"]; title: string; role: string | null; content: string; createdAt: string | null }
    | { status: "unavailable"; reason: string };

export type ProjectConversationRow = {
    id: string;
    title: string | null;
    productKey: string | null;
    kind: string;
    locked: boolean;
    continuation: { provider: string } | null;
    messageCount: number;
    updatedAt: string;
};

export type ProjectAnswerReceipt = {
    projectId: string | null;
    sources: Array<{ ref: string; kind: string; title: string; via: "context" | "tool" }>;
    createdAt: string;
} | null;

export type MaterialSource =
    | { sourceKind: "message_attachment"; attachmentId: string }
    | { sourceKind: "generated_artifact"; artifactId: string }
    | { sourceKind: "review_result"; conversationId: string; analysis: Record<string, unknown> }
    | { sourceKind: "research_report"; runId: string };

export class ProjectWorkspaceError extends Error {
    constructor(public status: number, public code: string, public details?: unknown) {
        super(code);
        this.name = "ProjectWorkspaceError";
    }
}

const randomId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export function createProjectWorkspaceClient(transport: ApiFetch, upload?: (url: string, headers: Record<string, string>, file: Blob) => Promise<void>) {
    const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
        const response = await transport(path, { cache: "no-store", ...init });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
            throw new ProjectWorkspaceError(
                response.status,
                typeof body?.code === "string" ? body.code : "PROJECT_REQUEST_FAILED",
                body?.details
            );
        }
        return body as T;
    };
    const send = (method: string, body?: unknown): RequestInit =>
        body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

    return {
        list: async () => (await call<{ projects: ProjectSummary[] }>("/api/projects")).projects,
        detail: (projectId: string) => call<ProjectSummary>(base(projectId)),
        /** A new workspace states its context choice explicitly (on by default in the create screen). */
        create: (input: { name: string; description?: string; instructions?: string; contextEnabled: boolean; memoryScope?: ProjectMemoryScope; autoMemoryEnabled?: boolean }) =>
            call<ProjectSummary>("/api/projects", send("POST", input)),
        update: (projectId: string, expectedRevision: number, patch: ProjectSettingsPatch) =>
            call<ProjectSummary>(base(projectId), send("PATCH", { ...patch, expectedRevision })),
        rename: (projectId: string, name: string) => call<ProjectSummary>(base(projectId), send("PATCH", { name })),
        deletionSummary: async (projectId: string) =>
            (await call<{ deletion: ProjectDeletionSummary }>(`${base(projectId)}?view=deletion`)).deletion,
        /** Echo the summary the user confirmed; a changed project answers PROJECT_DELETE_STALE with the new one. */
        remove: (projectId: string, confirmation?: { revision: number; materials: number; memories: number }) =>
            call<{ success: true; detachedConversations: number; deletedMaterials: number; deletedMemories: number }>(
                base(projectId), send("DELETE", confirmation ? { confirmation } : undefined)),
        conversations: async (projectId: string) =>
            (await call<{ conversations: ProjectConversationRow[] }>(`${base(projectId)}/conversations`)).conversations,

        materials: (projectId: string) =>
            call<{ files: ProjectMaterial[]; capacity: ProjectMaterialCapacity }>(`${base(projectId)}/materials`),
        uploadMaterial: async (projectId: string, file: Blob & { name: string; type: string }) => {
            if (!upload) throw new ProjectWorkspaceError(501, "UPLOAD_UNAVAILABLE");
            const prepared = await call<{ uploadKey: string; uploadUrl: string; uploadHeaders: Record<string, string> }>(
                `${base(projectId)}/materials`, send("POST", { action: "prepare", filename: file.name, mime: file.type, bytes: file.size }));
            await upload(prepared.uploadUrl, prepared.uploadHeaders, file);
            return call<{ file: { id: string; name: string; processingStatus: string } }>(
                `${base(projectId)}/materials`, send("POST", { action: "finalize", uploadKey: prepared.uploadKey, filename: file.name, mime: file.type }));
        },
        addNote: (projectId: string, title: string, text: string, clientRequestId = randomId()) =>
            call<{ created: boolean; file: ProjectMaterial }>(`${base(projectId)}/materials`, send("POST", { action: "note", clientRequestId, title, text })),
        /** A copy the project owns; retried with the same clientRequestId it returns the same copy. */
        saveSource: (projectId: string, source: MaterialSource, clientRequestId = randomId()) =>
            call<{ created: boolean; file: ProjectMaterial }>(`${base(projectId)}/materials/from-source`, send("POST", { clientRequestId, source })),
        retryMaterial: (projectId: string, fileId: string) =>
            call<{ retried: true }>(`${base(projectId)}/materials/${encodeURIComponent(fileId)}`, send("POST", { action: "retry" })),
        materialLink: (projectId: string, fileId: string) =>
            call<{ url: string; name: string; mime: string }>(`${base(projectId)}/materials/${encodeURIComponent(fileId)}`),
        deleteMaterial: (projectId: string, fileId: string) =>
            call<{ deleted: true }>(`${base(projectId)}/materials/${encodeURIComponent(fileId)}`, send("DELETE")),

        memories: async (projectId: string) =>
            (await call<{ memories: ProjectMemory[]; total: number }>(`${base(projectId)}/memories`)),
        /** Personal memories, for an explicit move into this project. */
        personalMemories: async (projectId: string) =>
            (await call<{ memories: ProjectMemory[]; total: number }>(`${base(projectId)}/memories?scope=personal`)),
        createMemory: (projectId: string, input: { kind: string; statement: string; groundsText: string }) =>
            call<{ memoryId: string }>(`${base(projectId)}/memories`, send("POST", input)),
        editMemory: (projectId: string, memoryId: string, statement: string) =>
            call<{ ok: true }>(`${base(projectId)}/memories/${encodeURIComponent(memoryId)}`, send("PATCH", { action: "edit", statement })),
        pinMemory: (projectId: string, memoryId: string, pinned: boolean) =>
            call<{ ok: true }>(`${base(projectId)}/memories/${encodeURIComponent(memoryId)}`, send("PATCH", { action: "pin", pinned })),
        deleteMemory: (projectId: string, memoryId: string) =>
            call<{ outcome: "deleted" }>(`${base(projectId)}/memories/${encodeURIComponent(memoryId)}`, send("DELETE")),
        /** targetProjectId null = personal memory (used in other conversations too). */
        moveMemory: (memoryId: string, expectedRevision: number, targetProjectId: string | null) =>
            call<{ moved: boolean; projectId: string | null }>(`/api/memories/${encodeURIComponent(memoryId)}/scope`, send("POST", { expectedRevision, targetProjectId })),

        search: (projectId: string, query: string, signal?: AbortSignal) =>
            call<ProjectSearchAnswer>(`${base(projectId)}/search`, { ...send("POST", { query }), signal }),
        readSource: (projectId: string, ref: string) =>
            call<ProjectSourceRead>(`${base(projectId)}/sources`, send("POST", { ref })).catch((error) => {
                if (error instanceof ProjectWorkspaceError && error.status === 404) return { status: "unavailable" as const, reason: "not_found" };
                throw error;
            }),
        receipt: async (messageId: string) =>
            (await call<{ receipt: ProjectAnswerReceipt }>(`/api/projects/receipts/${encodeURIComponent(messageId)}`)).receipt,
        /** Moves a conversation; only future answers change context. */
        moveConversation: (conversationId: string, projectId: string | null) =>
            call<unknown>(`/api/conversations/${encodeURIComponent(conversationId)}`, send("PATCH", { projectId })),
    };
}

export type ProjectWorkspaceClient = ReturnType<typeof createProjectWorkspaceClient>;

/** Pure: the confirmation a delete dialog must show before calling `remove`. */
export function projectDeletionNeedsConfirmation(summary: ProjectDeletionSummary) {
    return summary.materials > 0 || summary.memories > 0;
}

/** Pure: is a project usable as answer context right now? */
export function projectContextActive(project: Pick<ProjectSummary, "contextEnabled" | "archivedAt"> | null | undefined) {
    return Boolean(project && project.contextEnabled && !project.archivedAt);
}
