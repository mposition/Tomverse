import { z } from "zod";
import {
  ASSISTANT_KNOWLEDGE_LIMITS, ASSISTANT_KNOWLEDGE_TYPES, knowledgeFileRefusal, knowledgeMimeForExtension,
} from "../../../../lib/assistantKnowledgeLimits";
import type { DesktopAccountDataResult } from "../account-data-contract";
import { AccountDataRefusal } from "./account-data-refusal";

// Assistant files that cross the main process: the package download and knowledge uploads.

export const KNOWLEDGE_EXTENSIONS = [...new Set(Object.values(ASSISTANT_KNOWLEDGE_TYPES).flat())];
const PACKAGE_MAX_BYTES = 64 * 1024 * 1024;

const uploadPreparation = z.object({
  uploadKey: z.string().min(1).max(512), uploadUrl: z.url(),
  uploadHeaders: z.object({ "Content-Type": z.string() }).strict(),
});

export type PickedFile = { name: string; bytes: Uint8Array };
export type PickFile = (options: { extensions: readonly string[]; maxBytes: number }) => Promise<PickedFile | null>;

type Call = (request: { path: string; method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: object },
  accept?: string, timeout?: number) => Promise<Response>;

/**
 * The same destination rule the chat attachment upload applies: Tomverse storage over
 * HTTPS with a signed query, or the loopback development server.
 */
export function trustedUploadUrl(value: string, origin: string) {
  const url = new URL(value);
  const devLoopback = new URL(origin).hostname === "127.0.0.1" && url.hostname === "127.0.0.1" && url.protocol === "http:";
  const trustedStorage = url.protocol === "https:" && !url.port && /^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(url.hostname) &&
    url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" && Boolean(url.searchParams.get("X-Amz-Signature"));
  return (devLoopback || trustedStorage) && !url.username && !url.password ? url : null;
}

export function createAssistantData(options: {
  call: Call; origin: string; pickFile: PickFile;
  save: (file: { suggestedName: string; extension: string; filterName: string; load: () => Promise<Uint8Array> }) => Promise<boolean>;
  readBounded: (res: Response, maxBytes: number) => Promise<Buffer>;
  transport?: typeof fetch;
}) {
  const transport = options.transport ?? fetch;
  const profilePath = (id: string) => `/api/assistant-profiles/${encodeURIComponent(id)}`;

  async function savePackage(id: string, name: string): Promise<DesktopAccountDataResult> {
    const base = name.replace(/[^\p{L}\p{N}._ -]+/gu, " ").trim().slice(0, 80) || "assistant";
    const saved = await options.save({
      suggestedName: `${base}.zip`, extension: "zip", filterName: "ZIP",
      load: async () => {
        const res = await options.call({ path: profilePath(id) + "/export" }, "application/zip", 120_000);
        if (res.headers.get("content-type")?.split(";")[0].trim() !== "application/zip") {
          await res.body?.cancel().catch(() => {});
          throw new AccountDataRefusal("failed");
        }
        const bytes = await options.readBounded(res, PACKAGE_MAX_BYTES);
        // A zip starts with the local file header signature.
        if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new AccountDataRefusal("failed");
        return bytes;
      },
    });
    return { status: saved ? "saved" : "cancelled" };
  }

  async function uploadKnowledge(id: string): Promise<DesktopAccountDataResult> {
    const file = await options.pickFile({ extensions: KNOWLEDGE_EXTENSIONS, maxBytes: ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes });
    if (!file) return { status: "cancelled" };
    const extension = file.name.slice(file.name.lastIndexOf(".") + 1);
    const mime = knowledgeMimeForExtension(extension);
    if (!mime || knowledgeFileRefusal({ filename: file.name, mime, bytes: file.bytes.byteLength, leadingBytes: file.bytes.subarray(0, 64) })) {
      return { status: "failed", code: "ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE" };
    }
    const path = profilePath(id) + "/knowledge";
    const send = (body: object) => options.call({ path, method: "POST", body });
    const prepared = uploadPreparation.parse(await (await send({ action: "prepare", filename: file.name, mime, bytes: file.bytes.byteLength })).json());
    const url = trustedUploadUrl(prepared.uploadUrl, options.origin);
    if (!url || prepared.uploadHeaders["Content-Type"] !== mime) throw new AccountDataRefusal("failed");
    const stored = await transport(url, { method: "PUT", body: new Uint8Array(file.bytes), headers: prepared.uploadHeaders,
      credentials: "omit", redirect: "error", signal: AbortSignal.timeout(120_000) });
    await stored.body?.cancel().catch(() => {});
    if (!stored.ok) throw new AccountDataRefusal("failed");
    await (await send({ action: "finalize", uploadKey: prepared.uploadKey, filename: file.name, mime })).body?.cancel().catch(() => {});
    return { status: "uploaded" };
  }

  return { savePackage, uploadKnowledge };
}

export type AssistantData = ReturnType<typeof createAssistantData>;
