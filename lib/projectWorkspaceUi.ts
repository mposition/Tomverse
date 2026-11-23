/**
 * Pure logic behind the Project workspace UI.
 *
 * Everything here is decided without React, the DOM or the network so that the
 * behaviours that matter (what a delete confirmation echoes, what a create
 * request says about context, which references ride on a send) can be tested
 * as behaviour. The server re-checks all of it; nothing here is authority.
 */

import {
    ProjectWorkspaceError,
    projectDeletionNeedsConfirmation,
    type ProjectDeletionSummary,
    type ProjectMaterial,
    type ProjectMemory,
    type ProjectMemoryScope,
    type ProjectSearchHit,
    type ProjectSettingsPatch,
    type ProjectSummary,
    type ProjectWorkspaceClient,
} from "@tomverse/api-client";
import { MAX_PROJECT_REFERENCES } from "./projectReferences";

export { MAX_PROJECT_REFERENCES, projectReferenceFields } from "./projectReferences";

/** Mirrors lib/projectWorkspaceCore.ts PROJECT_LIMITS; the server stays the judge. */
export const PROJECT_UI_LIMITS = {
    maxNameLength: 32,
    maxDescriptionLength: 1_000,
    maxInstructionsLength: 16_000,
    maxNoteCharacters: 200_000,
    maxNoteTitleLength: 160,
} as const;

/**
 * Structural, not `instanceof`: the same error class can be loaded twice
 * (workspace package and bundled copy) and a failed check would read a
 * server-reported conflict as an unknown failure.
 */
export function asProjectWorkspaceError(error: unknown): ProjectWorkspaceError | null {
    if (error instanceof ProjectWorkspaceError) return error;
    if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "ProjectWorkspaceError" &&
        typeof (error as { code?: unknown }).code === "string" && typeof (error as { status?: unknown }).status === "number") {
        return error as ProjectWorkspaceError;
    }
    return null;
}

// ------------------------------------------------------------------ create

export type ProjectCreateForm = {
    name: string;
    description: string;
    instructions: string;
    contextEnabled: boolean;
    includePersonalMemory: boolean;
    autoMemoryEnabled: boolean;
};

/** The create screen opens with context on: a workspace that is not used is a folder. */
export const DEFAULT_PROJECT_CREATE_FORM: ProjectCreateForm = {
    name: "",
    description: "",
    instructions: "",
    contextEnabled: true,
    includePersonalMemory: false,
    autoMemoryEnabled: false,
};

/** The request a create screen sends: the context choice is always explicit. */
export function buildProjectCreateInput(form: ProjectCreateForm) {
    const memoryScope: ProjectMemoryScope = form.contextEnabled && form.includePersonalMemory ? "project_and_personal" : "project_only";
    return {
        name: form.name.trim().slice(0, PROJECT_UI_LIMITS.maxNameLength),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        ...(form.instructions.trim() ? { instructions: form.instructions.trim() } : {}),
        contextEnabled: form.contextEnabled,
        memoryScope,
        autoMemoryEnabled: form.contextEnabled && form.autoMemoryEnabled,
    };
}

export const projectNameValid = (name: string) => name.trim().length > 0 && name.trim().length <= PROJECT_UI_LIMITS.maxNameLength;

// ---------------------------------------------------------------- settings

export type ProjectSettingsDraft = {
    name: string;
    description: string;
    instructions: string;
    contextEnabled: boolean;
    includePersonalMemory: boolean;
    autoMemoryEnabled: boolean;
};

export function settingsDraftFromProject(project: ProjectSummary): ProjectSettingsDraft {
    return {
        name: project.name,
        description: project.description,
        instructions: project.instructions,
        contextEnabled: project.contextEnabled,
        includePersonalMemory: project.memoryScope === "project_and_personal",
        autoMemoryEnabled: project.autoMemoryEnabled,
    };
}

/** Only what changed, so an unrelated edit never rewrites a field another tab just saved. */
export function projectSettingsPatch(project: ProjectSummary, draft: ProjectSettingsDraft): ProjectSettingsPatch | null {
    const patch: ProjectSettingsPatch = {};
    const name = draft.name.trim();
    if (name !== project.name) patch.name = name;
    if (draft.description.trim() !== project.description) patch.description = draft.description.trim();
    if (draft.instructions.trim() !== project.instructions) patch.instructions = draft.instructions.trim();
    if (draft.contextEnabled !== project.contextEnabled) patch.contextEnabled = draft.contextEnabled;
    const memoryScope: ProjectMemoryScope = draft.includePersonalMemory ? "project_and_personal" : "project_only";
    if (memoryScope !== project.memoryScope) patch.memoryScope = memoryScope;
    if (draft.autoMemoryEnabled !== project.autoMemoryEnabled) patch.autoMemoryEnabled = draft.autoMemoryEnabled;
    return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Saves a settings draft. A rename alone needs no revision; any other field is
 * sent with the revision the form was loaded at, so a concurrent change from
 * another tab surfaces as a conflict instead of being overwritten.
 */
export function saveProjectSettings(client: ProjectWorkspaceClient, project: ProjectSummary, patch: ProjectSettingsPatch) {
    const keys = Object.keys(patch);
    if (keys.length === 1 && keys[0] === "name" && patch.name !== undefined) return client.rename(project.id, patch.name);
    return client.update(project.id, project.revision, patch);
}

// ------------------------------------------------------- new Chat in project

/**
 * Binds a not-yet-created conversation to its project in the create request,
 * so ownership is decided before the first answer. Product key, Assistant pin
 * and the rest of the body are left untouched.
 */
export function withProjectAttribution<T extends Record<string, unknown>>(body: T, projectId: string | null | undefined): T & { projectId?: string } {
    return projectId ? { ...body, projectId } : body;
}

/** The wording a move needs depends on whether the target answers with project context. */
export function conversationMoveEffect(from: Pick<ProjectSummary, "contextEnabled"> | null, to: Pick<ProjectSummary, "contextEnabled"> | null) {
    const toContext = Boolean(to?.contextEnabled);
    const fromContext = Boolean(from?.contextEnabled);
    if (toContext && fromContext) return "switches_context" as const;
    if (toContext) return "gains_context" as const;
    if (fromContext) return "loses_context" as const;
    return "folder_only" as const;
}

// ------------------------------------------------------------------ delete

export type ProjectDeletionPlan = { summary: ProjectDeletionSummary; needsConfirmation: boolean };

export async function loadProjectDeletionPlan(client: ProjectWorkspaceClient, projectId: string): Promise<ProjectDeletionPlan> {
    const summary = await client.deletionSummary(projectId);
    return { summary, needsConfirmation: projectDeletionNeedsConfirmation(summary) };
}

const isDeletionSummary = (value: unknown): value is ProjectDeletionSummary =>
    typeof value === "object" && value !== null &&
    ["conversations", "materials", "memories", "revision"].every((key) => typeof (value as Record<string, unknown>)[key] === "number");

export type ProjectDeleteOutcome =
    | { status: "deleted"; detachedConversations: number; deletedMaterials: number; deletedMemories: number }
    | { status: "stale"; plan: ProjectDeletionPlan };

/**
 * Deletes after the user confirmed `plan`. The confirmation the server needs
 * is exactly the summary the user saw (revision, material and memory counts);
 * when the project changed meanwhile the server answers STALE and the caller
 * shows the new summary and asks again -- the old confirmation is never reused.
 */
export async function deleteProjectAfterConfirmation(client: ProjectWorkspaceClient, projectId: string, plan: ProjectDeletionPlan): Promise<ProjectDeleteOutcome> {
    const confirmation = plan.needsConfirmation
        ? { revision: plan.summary.revision, materials: plan.summary.materials, memories: plan.summary.memories }
        : undefined;
    try {
        const result = await client.remove(projectId, confirmation);
        return { status: "deleted", detachedConversations: result.detachedConversations, deletedMaterials: result.deletedMaterials, deletedMemories: result.deletedMemories };
    } catch (error) {
        const failure = asProjectWorkspaceError(error);
        if (failure && (failure.code === "PROJECT_DELETE_STALE" || failure.code === "PROJECT_DELETE_CONFIRMATION_REQUIRED")) {
            const summary = isDeletionSummary(failure.details) ? failure.details : await client.deletionSummary(projectId);
            return { status: "stale", plan: { summary, needsConfirmation: projectDeletionNeedsConfirmation(summary) } };
        }
        throw error;
    }
}

// -------------------------------------------------------------- references

/** Adds or removes a search hit from the references of the next question. */
export function toggleProjectReference(current: readonly ProjectSearchHit[], hit: ProjectSearchHit): ProjectSearchHit[] {
    if (current.some((item) => item.ref === hit.ref)) return current.filter((item) => item.ref !== hit.ref);
    if (current.length >= MAX_PROJECT_REFERENCES) return [...current];
    return [...current, hit];
}

export const projectReferenceLimitReached = (current: readonly ProjectSearchHit[]) => current.length >= MAX_PROJECT_REFERENCES;

/** Drops references whose project is no longer the conversation's project. */
export function referencesForProject(references: readonly ProjectSearchHit[], selectedProjectId: string | null, referencesProjectId: string | null) {
    return selectedProjectId && selectedProjectId === referencesProjectId ? [...references] : [];
}

// --------------------------------------------------------------- materials

const MATERIAL_STATUS_KEYS = {
    pending: "projectWorkspace.materials.status.pending",
    processing: "projectWorkspace.materials.status.processing",
    ready: "projectWorkspace.materials.status.ready",
    failed: "projectWorkspace.materials.status.failed",
} as const;

export const materialStatusKey = (status: ProjectMaterial["processingStatus"]) => MATERIAL_STATUS_KEYS[status];

/** A reason the owner can act on, or the generic one for codes this build does not know. */
export function materialFailureKey(code: string | null) {
    const value = (code ?? "").toUpperCase();
    if (value.includes("UNSUPPORTED")) return "projectWorkspace.materials.failure.unsupported";
    if (value.includes("NO_TEXT")) return "projectWorkspace.materials.failure.noText";
    if (value.includes("UNREADABLE")) return "projectWorkspace.materials.failure.unreadable";
    if (value.includes("QUOTA")) return "projectWorkspace.materials.failure.quota";
    return "projectWorkspace.materials.failure.unknown";
}

export const materialCanRetry = (material: Pick<ProjectMaterial, "processingStatus">) => material.processingStatus === "failed";
export const materialCanDownload = (material: Pick<ProjectMaterial, "processingStatus">) => material.processingStatus !== "pending";
export const materialsNeedPolling = (materials: readonly Pick<ProjectMaterial, "processingStatus">[]) =>
    materials.some((material) => material.processingStatus === "pending" || material.processingStatus === "processing");

const SOURCE_KIND_KEYS: Record<ProjectMaterial["sourceKind"], string> = {
    upload: "projectWorkspace.materials.source.upload",
    note: "projectWorkspace.materials.source.note",
    message_attachment: "projectWorkspace.materials.source.attachment",
    generated_artifact: "projectWorkspace.materials.source.generatedFile",
    review_result: "projectWorkspace.materials.source.review",
    research_report: "projectWorkspace.materials.source.research",
};
export const materialSourceKey = (kind: ProjectMaterial["sourceKind"]) => SOURCE_KIND_KEYS[kind] ?? SOURCE_KIND_KEYS.upload;

/** A browser leaves the type empty for formats it does not recognise; the server refuses "" rather than guessing. */
export function uploadableMaterial(file: File): Blob & { name: string; type: string } {
    return file.type ? file : (new File([file], file.name, { type: "application/octet-stream" }) as Blob & { name: string; type: string });
}

export const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * One client request id per save intent. A retry of the same intent (network
 * error, double tap) reuses the id and so returns the same copy; once a save
 * succeeded the intent is released and a later save is a new copy.
 */
export function createRequestIdMemo(newId: () => string = () => crypto.randomUUID()) {
    const ids = new Map<string, string>();
    return {
        get(intentKey: string) {
            let id = ids.get(intentKey);
            if (!id) {
                id = newId();
                ids.set(intentKey, id);
            }
            return id;
        },
        release(intentKey: string) {
            ids.delete(intentKey);
        },
    };
}

/** Stable identity of "save this source into that project". */
export function materialIntentKey(projectId: string, source: { sourceKind: string } & Record<string, unknown>) {
    const { analysis, ...rest } = source as Record<string, unknown>;
    return JSON.stringify([projectId, rest, analysis ? JSON.stringify(analysis) : null]);
}

// ---------------------------------------------------------------- memories

/** Moving a memory to personal makes it usable in conversations outside the project. */
export function memoryMoveWarning(memory: Pick<ProjectMemory, "projectId">, target: string | null) {
    return target === null && memory.projectId !== null ? ("personal_wide" as const) : null;
}

export const memoryEvidenceText = (memory: Pick<ProjectMemory, "evidence">) =>
    memory.evidence
        .map((item) => item.manualContent?.trim() || item.sourceTitle?.trim() || "")
        .filter(Boolean)
        .slice(0, 3);

// ------------------------------------------------------------------ errors

const ERROR_KEYS: Record<string, string> = {
    PROJECT_ARCHIVED: "projectWorkspace.errors.archived",
    PROJECT_REVISION_CONFLICT: "projectWorkspace.errors.revisionConflict",
    PROJECT_REVISION_REQUIRED: "projectWorkspace.errors.revisionConflict",
    PROJECT_NAME_TAKEN: "projectWorkspace.errors.nameTaken",
    PROJECT_NAME_INVALID: "projectWorkspace.errors.nameInvalid",
    PROJECT_LIMIT_REACHED: "projectWorkspace.errors.limitReached",
    PROJECT_NOT_FOUND: "projectWorkspace.errors.notFound",
    PROJECT_DESCRIPTION_TOO_LONG: "projectWorkspace.errors.descriptionTooLong",
    PROJECT_INSTRUCTIONS_TOO_LONG: "projectWorkspace.errors.instructionsTooLong",
    MATERIAL_SOURCE_NOT_FOUND: "projectWorkspace.errors.sourceNotFound",
    CONVERSATION_LOCKED: "projectWorkspace.errors.locked",
    MEMORY_FEATURE_DISABLED: "projectWorkspace.errors.memoryOff",
    UPLOAD_UNAVAILABLE: "projectWorkspace.errors.uploadUnavailable",
};

/** The locale key for a failed project request; unknown failures get the generic sentence. */
export function projectErrorKey(error: unknown): string {
    const failure = asProjectWorkspaceError(error);
    if (failure) {
        if (ERROR_KEYS[failure.code]) return ERROR_KEYS[failure.code];
        if (failure.status === 401 || failure.status === 403) return "projectWorkspace.errors.signIn";
        if (failure.status === 404) return "projectWorkspace.errors.notFound";
        if (failure.status === 423) return "projectWorkspace.errors.locked";
        if (failure.status === 429) return "projectWorkspace.errors.rateLimited";
    }
    return "projectWorkspace.errors.generic";
}

export const isRevisionConflict = (error: unknown) => {
    const code = asProjectWorkspaceError(error)?.code;
    return code === "PROJECT_REVISION_CONFLICT" || code === "PROJECT_REVISION_REQUIRED";
};
export const isProjectArchivedError = (error: unknown) => asProjectWorkspaceError(error)?.code === "PROJECT_ARCHIVED";

// ------------------------------------------------------------------- misc

export const projectStatusLabelKey = (project: Pick<ProjectSummary, "contextEnabled" | "archivedAt">) =>
    project.archivedAt
        ? "projectWorkspace.status.archived"
        : project.contextEnabled
            ? "projectWorkspace.status.contextOn"
            : "projectWorkspace.status.folder";

export const interpolateCopy = (template: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);

/** Broadcast so the sidebar, the open conversation and the workspace agree on a move. */
export const CONVERSATION_PROJECT_CHANGED_EVENT = "tomverse:conversation-project-changed";
export const PROJECT_CHANGED_EVENT = "tomverse:project-changed";

export type ConversationProjectChangedDetail = { conversationId: string; projectId: string | null };

export function announceConversationProjectChanged(detail: ConversationProjectChangedDetail) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent<ConversationProjectChangedDetail>(CONVERSATION_PROJECT_CHANGED_EVENT, { detail }));
}

export function announceProjectChanged() {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(PROJECT_CHANGED_EVENT));
}
