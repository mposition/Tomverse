import { basename, extname } from "node:path";
import {
  createProjectWorkspaceClient, ProjectWorkspaceError, type ProjectWorkspaceClient,
} from "../../../../packages/api-client/src/projectWorkspace";
import type { ApiFetch } from "../../../../packages/api-client/src/index";
import { ASSISTANT_KNOWLEDGE_LIMITS, ASSISTANT_KNOWLEDGE_TYPES, knowledgeMimeForExtension } from "../../../../lib/assistantKnowledgeLimits";
import type { DesktopProjectInput, DesktopProjectOutcome } from "../project-contract";
import type { AccountSettingsApi } from "./account-settings-api";

/**
 * Desktop project workspace on the account session.
 *
 * The project routes are not on the Desktop bearer allowlist (lib/nativeBearerGate.ts), so each call
 * goes through the same short-lived account session the settings use. The shared client from
 * packages/api-client builds every path; this module only decides which calls the renderer may name
 * and where file bytes may travel.
 */

const WORKSPACE_PATH = /^\/api\/(?:projects(?:\/|$|\?)|memories\/[A-Za-z0-9_-]{1,100}\/scope$|conversations\/[A-Za-z0-9_-]{1,100}$)/;
const MAX_PICKED_FILES = 10;
const DOWNLOAD_LIMIT = ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes;

export type PickedMaterial = { name: string; mime: string; bytes: Uint8Array };

export type ProjectIo = {
  /** Asks the person for files and reads them; null when the picker was cancelled. */
  chooseMaterialFiles(): Promise<PickedMaterial[] | null>;
  /** Writes downloaded bytes through the app's own save dialog; false when cancelled. */
  saveMaterial(load: () => Promise<{ bytes: Uint8Array; suggestedName: string; extension: string }>): Promise<boolean>;
  transport?: typeof fetch;
};

/** Account-session transport for the shared client. Anything outside the workspace routes is refused. */
export function projectTransport(settings: Pick<AccountSettingsApi, "send" | "forget">): ApiFetch {
  return async (path, init) => {
    if (!WORKSPACE_PATH.test(path)) throw new Error("This path is not a project workspace route.");
    const method = (init?.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as object : undefined;
    const response = await settings.send({ path, method, body });
    if (response.status === 401) settings.forget();
    return response;
  };
}

/**
 * File bytes go only to the storage address the workspace issued: the signed Cloudflare R2 host in
 * production, or the same loopback host as the account origin in the local fixture. Never a port,
 * credentials, or an unsigned address.
 */
export function trustedStorageUrl(raw: string, accountOrigin: string): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password) return null;
  const account = new URL(accountOrigin);
  const devLoopback = account.hostname === "127.0.0.1" && url.hostname === "127.0.0.1" && url.protocol === "http:";
  const signed = url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" && Boolean(url.searchParams.get("X-Amz-Signature"));
  const storage = url.protocol === "https:" && !url.port && /^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(url.hostname) && signed;
  return devLoopback || storage ? url : null;
}

const supportedExtensions = () => Object.values(ASSISTANT_KNOWLEDGE_TYPES).flat();

/** The media type a picked file is uploaded as, or null when the workspace does not accept it. */
export function materialMimeFor(fileName: string): string | null {
  const extension = extname(fileName).slice(1).toLowerCase();
  return extension ? knowledgeMimeForExtension(extension) : null;
}

/** Native picker for project materials; unsupported or oversized files are skipped, not uploaded. */
export async function pickMaterialFiles(io: {
  showOpenDialog(options: { title: string; properties: Array<"openFile" | "multiSelections">; filters: Array<{ name: string; extensions: string[] }> }):
    Promise<{ canceled: boolean; filePaths: string[] }>;
  readFile(path: string): Promise<Uint8Array>;
  title: string;
  filterName: string;
}): Promise<PickedMaterial[] | null> {
  const choice = await io.showOpenDialog({
    title: io.title, properties: ["openFile", "multiSelections"], filters: [{ name: io.filterName, extensions: supportedExtensions() }],
  });
  if (choice.canceled || !choice.filePaths.length) return null;
  const files: PickedMaterial[] = [];
  for (const path of choice.filePaths.slice(0, MAX_PICKED_FILES)) {
    const name = basename(path);
    const mime = materialMimeFor(name);
    if (!mime || name.length > 200) continue;
    const bytes = await io.readFile(path);
    if (!bytes.byteLength || bytes.byteLength > ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes) continue;
    files.push({ name, mime, bytes });
  }
  return files;
}

function failure(error: unknown): DesktopProjectOutcome {
  if (error instanceof ProjectWorkspaceError) {
    return { ok: false, status: error.status, code: error.code, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  if (error instanceof Error && error.name === "AbortError") throw error;
  return { ok: false, status: 0, code: "PROJECT_REQUEST_FAILED" };
}

export function createProjectRunner(settings: Pick<AccountSettingsApi, "send" | "forget">, accountOrigin: string, io: ProjectIo) {
  const transport = io.transport ?? fetch;
  const upload = async (rawUrl: string, headers: Record<string, string>, file: Blob) => {
    const url = trustedStorageUrl(rawUrl, accountOrigin);
    const keys = Object.keys(headers);
    if (!url || keys.length !== 1 || keys[0].toLowerCase() !== "content-type" || headers[keys[0]] !== file.type) {
      throw new ProjectWorkspaceError(502, "PROJECT_MATERIAL_UPLOAD_FAILED");
    }
    const response = await transport(url, {
      method: "PUT", body: file, headers: { "Content-Type": file.type }, credentials: "omit", redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new ProjectWorkspaceError(502, "PROJECT_MATERIAL_UPLOAD_FAILED");
  };
  const client: ProjectWorkspaceClient = createProjectWorkspaceClient(projectTransport(settings), upload);

  async function downloadBytes(rawUrl: string) {
    const url = trustedStorageUrl(rawUrl, accountOrigin);
    if (!url) throw new ProjectWorkspaceError(502, "PROJECT_MATERIAL_DOWNLOAD_FAILED");
    const response = await transport(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new ProjectWorkspaceError(502, "PROJECT_MATERIAL_DOWNLOAD_FAILED");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > DOWNLOAD_LIMIT) {
          await reader.cancel().catch(() => {});
          throw new ProjectWorkspaceError(502, "PROJECT_MATERIAL_DOWNLOAD_FAILED");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (!length) throw new ProjectWorkspaceError(502, "PROJECT_MATERIAL_DOWNLOAD_FAILED");
    return Buffer.concat(chunks, length);
  }

  async function execute(input: DesktopProjectInput): Promise<unknown> {
    switch (input.action) {
      case "list": return client.list();
      case "detail": return client.detail(input.projectId);
      case "create": return client.create({ name: input.name, description: input.description, instructions: input.instructions,
        contextEnabled: input.contextEnabled, memoryScope: input.memoryScope, autoMemoryEnabled: input.autoMemoryEnabled });
      case "update": return client.update(input.projectId, input.expectedRevision, input.patch);
      case "rename": return client.rename(input.projectId, input.name);
      case "deletionSummary": return client.deletionSummary(input.projectId);
      case "remove": return client.remove(input.projectId, input.confirmation);
      case "conversations": return client.conversations(input.projectId);
      case "materials": return client.materials(input.projectId);
      case "uploadMaterials": {
        const picked = await io.chooseMaterialFiles();
        if (!picked) return { cancelled: true, files: [] };
        const files: Array<{ name: string; id?: string; code?: string }> = [];
        for (const item of picked) {
          try {
            const { file } = await client.uploadMaterial(input.projectId, new File([item.bytes as BlobPart], item.name, { type: item.mime }));
            files.push({ name: item.name, id: file.id });
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            files.push({ name: item.name, code: error instanceof ProjectWorkspaceError ? error.code : "PROJECT_MATERIAL_UPLOAD_FAILED" });
          }
        }
        return { cancelled: false, files };
      }
      case "downloadMaterial": {
        const link = await client.materialLink(input.projectId, input.fileId);
        return io.saveMaterial(async () => {
          const extension = extname(link.name).slice(1).toLowerCase();
          return { bytes: await downloadBytes(link.url), suggestedName: basename(link.name) || "material", extension: extension || "*" };
        });
      }
      case "addNote": return client.addNote(input.projectId, input.title, input.text, input.clientRequestId);
      case "saveSource": return client.saveSource(input.projectId, input.source, input.clientRequestId);
      case "retryMaterial": return client.retryMaterial(input.projectId, input.fileId);
      case "deleteMaterial": return client.deleteMaterial(input.projectId, input.fileId);
      case "memories": return client.memories(input.projectId);
      case "personalMemories": return client.personalMemories(input.projectId);
      case "createMemory": return client.createMemory(input.projectId, input.input);
      case "editMemory": return client.editMemory(input.projectId, input.memoryId, input.statement);
      case "pinMemory": return client.pinMemory(input.projectId, input.memoryId, input.pinned);
      case "deleteMemory": return client.deleteMemory(input.projectId, input.memoryId);
      case "moveMemory": return client.moveMemory(input.memoryId, input.expectedRevision, input.targetProjectId);
      case "search": return client.search(input.projectId, input.query);
      case "readSource": return client.readSource(input.projectId, input.ref);
      case "receipt": return client.receipt(input.messageId);
      case "moveConversation": return client.moveConversation(input.conversationId, input.projectId);
    }
  }

  return async function run(input: DesktopProjectInput): Promise<DesktopProjectOutcome> {
    try {
      return { ok: true, value: await execute(input) as never };
    } catch (error) {
      return failure(error);
    }
  };
}

export type ProjectRunner = ReturnType<typeof createProjectRunner>;
