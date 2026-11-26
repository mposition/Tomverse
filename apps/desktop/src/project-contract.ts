import { z } from "zod";
import { MEMORY_KINDS } from "../../../lib/memoryValidatorCore";
import type {
  ProjectDeletionSummary, ProjectMaterial, ProjectMemory, ProjectSearchAnswer, ProjectSourceRead, ProjectSummary,
  ProjectAnswerReceipt, ProjectConversationRow, ProjectMaterialCapacity,
} from "../../../packages/api-client/src/projectWorkspace";

/**
 * The Desktop project workspace IPC. The renderer names an action and its typed arguments; the main
 * process maps each action to one workspace API call on the account session. No path, method or URL
 * crosses the bridge, and every identifier is checked against the server's own id shape first.
 */

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
// Mirrors lib/projectWorkspaceUi.ts PROJECT_UI_LIMITS; the server stays the judge.
const name = z.string().trim().min(1).max(32);
const clientRequestId = z.string().trim().min(8).max(80);
export const memoryScope = z.enum(["project_only", "project_and_personal"]);

export const projectSettingsPatch = z.object({
  name: name.optional(),
  description: z.string().max(1_000).optional(),
  instructions: z.string().max(16_000).optional(),
  contextEnabled: z.boolean().optional(),
  memoryScope: memoryScope.optional(),
  autoMemoryEnabled: z.boolean().optional(),
  archived: z.boolean().optional(),
}).strict();

export const projectMaterialSource = z.discriminatedUnion("sourceKind", [
  z.object({ sourceKind: z.literal("message_attachment"), attachmentId: id }).strict(),
  z.object({ sourceKind: z.literal("generated_artifact"), artifactId: id }).strict(),
  z.object({ sourceKind: z.literal("research_report"), runId: id }).strict(),
]);

export const desktopProjectInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("detail"), projectId: id }).strict(),
  z.object({
    action: z.literal("create"), name, description: z.string().max(1_000).optional(), instructions: z.string().max(16_000).optional(),
    contextEnabled: z.boolean(), memoryScope: memoryScope.optional(), autoMemoryEnabled: z.boolean().optional(),
  }).strict(),
  z.object({ action: z.literal("update"), projectId: id, expectedRevision: z.number().int().nonnegative(), patch: projectSettingsPatch }).strict(),
  z.object({ action: z.literal("rename"), projectId: id, name }).strict(),
  z.object({ action: z.literal("deletionSummary"), projectId: id }).strict(),
  z.object({
    action: z.literal("remove"), projectId: id,
    confirmation: z.object({ revision: z.number().int().nonnegative(), materials: z.number().int().nonnegative(), memories: z.number().int().nonnegative() }).strict().optional(),
  }).strict(),
  z.object({ action: z.literal("conversations"), projectId: id }).strict(),
  z.object({ action: z.literal("materials"), projectId: id }).strict(),
  z.object({ action: z.literal("uploadMaterials"), projectId: id }).strict(),
  z.object({ action: z.literal("downloadMaterial"), projectId: id, fileId: id }).strict(),
  z.object({ action: z.literal("addNote"), projectId: id, title: z.string().trim().min(1).max(160), text: z.string().min(1).max(200_000), clientRequestId }).strict(),
  z.object({ action: z.literal("saveSource"), projectId: id, source: projectMaterialSource, clientRequestId }).strict(),
  z.object({ action: z.literal("retryMaterial"), projectId: id, fileId: id }).strict(),
  z.object({ action: z.literal("deleteMaterial"), projectId: id, fileId: id }).strict(),
  z.object({ action: z.literal("memories"), projectId: id }).strict(),
  z.object({ action: z.literal("personalMemories"), projectId: id }).strict(),
  z.object({
    action: z.literal("createMemory"), projectId: id,
    input: z.object({ kind: z.enum(MEMORY_KINDS), statement: z.string().trim().min(1).max(1_000), groundsText: z.string().trim().min(1).max(2_000) }).strict(),
  }).strict(),
  z.object({ action: z.literal("editMemory"), projectId: id, memoryId: id, statement: z.string().trim().min(1).max(1_000) }).strict(),
  z.object({ action: z.literal("pinMemory"), projectId: id, memoryId: id, pinned: z.boolean() }).strict(),
  z.object({ action: z.literal("deleteMemory"), projectId: id, memoryId: id }).strict(),
  z.object({ action: z.literal("moveMemory"), memoryId: id, expectedRevision: z.number().int().nonnegative(), targetProjectId: id.nullable() }).strict(),
  z.object({ action: z.literal("search"), projectId: id, query: z.string().trim().min(1).max(500) }).strict(),
  z.object({ action: z.literal("readSource"), projectId: id, ref: z.string().min(3).max(200) }).strict(),
  z.object({ action: z.literal("receipt"), messageId: id }).strict(),
  z.object({ action: z.literal("moveConversation"), conversationId: id, projectId: id.nullable() }).strict(),
]);
export type DesktopProjectInput = z.infer<typeof desktopProjectInput>;
export type DesktopProjectAction = DesktopProjectInput["action"];

/** What each action returns when it succeeds. */
export type DesktopProjectValue = {
  list: ProjectSummary[];
  detail: ProjectSummary;
  create: ProjectSummary;
  update: ProjectSummary;
  rename: ProjectSummary;
  deletionSummary: ProjectDeletionSummary;
  remove: { success: true; detachedConversations: number; deletedMaterials: number; deletedMemories: number };
  conversations: ProjectConversationRow[];
  materials: { files: ProjectMaterial[]; capacity: ProjectMaterialCapacity };
  uploadMaterials: DesktopMaterialUploads;
  downloadMaterial: boolean;
  addNote: { created: boolean; file: ProjectMaterial };
  saveSource: { created: boolean; file: ProjectMaterial };
  retryMaterial: { retried: true };
  deleteMaterial: { deleted: true };
  memories: { memories: ProjectMemory[]; total: number };
  personalMemories: { memories: ProjectMemory[]; total: number };
  createMemory: { memoryId: string };
  editMemory: { ok: true };
  pinMemory: { ok: true };
  deleteMemory: { outcome: "deleted" };
  moveMemory: { moved: boolean; projectId: string | null };
  search: ProjectSearchAnswer;
  readSource: ProjectSourceRead;
  receipt: ProjectAnswerReceipt;
  moveConversation: unknown;
};

/** One file the user picked for upload: stored, or refused with the server's code. */
export type DesktopMaterialUploads = { cancelled: boolean; files: Array<{ name: string; id?: string; code?: string }> };

/**
 * A failed call crosses the bridge as data, not as a thrown Error, because Electron flattens an error
 * to its message and the workspace needs the status and server code to pick its wording.
 */
export type DesktopProjectOutcome<Action extends DesktopProjectAction = DesktopProjectAction> =
  | { ok: true; value: DesktopProjectValue[Action] }
  | { ok: false; status: number; code: string; details?: unknown };
