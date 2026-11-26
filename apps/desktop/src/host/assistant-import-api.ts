import { z } from "zod";
import { knowledgeFileRefusal, knowledgeMimeForExtension } from "../../../../lib/assistantKnowledgeLimits";
import {
  ASSISTANT_IMPORT_PACKAGE_EXTENSIONS, ASSISTANT_IMPORT_PACKAGE_MAX_BYTES, assistantImportOutput,
  type AssistantImportInput, type AssistantImportOutput, type AssistantImportResult,
} from "../assistant-import-contract";
import type { AccountSettingsApi } from "./account-settings-api";
import { AccountDataRefusal } from "./account-data-refusal";
import { trustedUploadUrl, type PickFile } from "./assistant-data";

// Everything the assistant package wizard asks of the server, from the main process on the
// shared Desktop account session. The wizard runs in the window and opens the package there;
// what crosses here is the reviewed content the owner approved, one typed action at a time.

type Session = Pick<AccountSettingsApi, "send" | "forget">;
type Output<Action extends AssistantImportInput["action"]> = AssistantImportOutput[Action];

const IMPORTS = "/api/assistant-profiles/imports";
const FAILED = "ASSISTANT_PACKAGE_IMPORT_FAILED";
const UPLOAD_FAILED = "ASSISTANT_PACKAGE_UPLOAD_FAILED";

const uploadPreparation = z.object({
  uploadKey: z.string().min(1).max(512), uploadUrl: z.url(),
  uploadHeaders: z.object({ "Content-Type": z.string() }).strict(),
});
const profileList = z.object({
  profiles: z.array(z.object({
    id: z.string(), name: z.string(), icon: z.string().nullable(),
    currentRevision: z.number().int().nullable(), knowledgeFileCount: z.number().int().nonnegative(),
  })),
  // An older server does not say, and then the entry point stays hidden.
  features: z.object({ packageImport: z.boolean() }).optional(),
});

/** A refusal that carries the HTTP status and the server's own code, never its message. */
class ImportRefusal extends Error {
  constructor(readonly status: number, readonly code: string) { super("Assistant import refused: " + status); }
}

const extensionOf = (name: string) => {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot <= 0 || dot === base.length - 1 ? "" : base.slice(dot + 1).toLowerCase();
};

export function createAssistantImportApi(options: {
  settings: Session; origin: string; pickFile: PickFile; transport?: typeof fetch;
}) {
  const transport = options.transport ?? fetch;
  const importPath = (id: string) => `${IMPORTS}/${encodeURIComponent(id)}`;

  /** The response, or an `ImportRefusal` carrying the status and the server's code. */
  async function call(request: Parameters<Session["send"]>[0], timeout?: number, acceptConflict = false) {
    const res = await options.settings.send(request, "application/json", timeout);
    if (res.status === 401) options.settings.forget();
    if (res.ok || (acceptConflict && res.status === 409)) return res;
    const code = res.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json"
      ? await res.json().then((body: { code?: unknown }) => typeof body?.code === "string" ? body.code.slice(0, 120) : undefined, () => undefined)
      : undefined;
    await res.body?.cancel().catch(() => {});
    throw new ImportRefusal(res.status, code ?? `HTTP_${res.status}`);
  }

  async function targets(): Promise<Output<"targets">> {
    const parsed = profileList.parse(await (await call({ path: "/api/assistant-profiles" })).json());
    return { enabled: parsed.features?.packageImport === true, targets: parsed.profiles.map(({ id, name, icon, currentRevision, knowledgeFileCount }) =>
      ({ id, name, icon, currentRevision, knowledgeFileCount })) };
  }

  async function pickPackage(): Promise<Output<"pickPackage">> {
    let file;
    try {
      file = await options.pickFile({ extensions: ASSISTANT_IMPORT_PACKAGE_EXTENSIONS, maxBytes: ASSISTANT_IMPORT_PACKAGE_MAX_BYTES });
    } catch (error) {
      // The dialog refuses a file past the limit before reading it, which the wizard shows as its own refusal.
      if (error instanceof AccountDataRefusal && error.code === "FILE_TOO_LARGE") {
        return { kind: "refused", code: "ASSISTANT_PACKAGE_TOO_LARGE", name: "", size: ASSISTANT_IMPORT_PACKAGE_MAX_BYTES + 1 };
      }
      throw error;
    }
    if (!file) return { kind: "cancelled" };
    const name = file.name.slice(-260);
    if (!(ASSISTANT_IMPORT_PACKAGE_EXTENSIONS as readonly string[]).includes(extensionOf(file.name))) {
      return { kind: "refused", code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED", name, size: file.bytes.byteLength };
    }
    if (file.bytes.byteLength > ASSISTANT_IMPORT_PACKAGE_MAX_BYTES) {
      return { kind: "refused", code: "ASSISTANT_PACKAGE_TOO_LARGE", name, size: file.bytes.byteLength };
    }
    return { kind: "picked", name, bytes: file.bytes };
  }

  async function create(body: Extract<AssistantImportInput, { action: "create" }>["body"]) {
    return assistantImportOutput.create.parse(await (await call({ path: IMPORTS, method: "POST", body })).json());
  }

  /** One reviewed document: reserve the key, put the object straight to storage, then register it. */
  async function upload(id: string, filename: string, bytes: Uint8Array) {
    const mime = knowledgeMimeForExtension(extensionOf(filename));
    if (!mime || knowledgeFileRefusal({ filename, mime, bytes: bytes.byteLength, leadingBytes: bytes.subarray(0, 64) })) {
      throw new ImportRefusal(415, "ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE");
    }
    const path = importPath(id) + "/knowledge";
    const prepared = uploadPreparation.parse(await (await call({ path, method: "POST", body: { action: "prepare", filename, mime, bytes: bytes.byteLength } })).json());
    const url = trustedUploadUrl(prepared.uploadUrl, options.origin);
    if (!url || prepared.uploadHeaders["Content-Type"] !== mime) throw new ImportRefusal(0, UPLOAD_FAILED);
    const stored = await transport(url, { method: "PUT", body: new Uint8Array(bytes), headers: prepared.uploadHeaders,
      credentials: "omit", redirect: "error", signal: AbortSignal.timeout(120_000) });
    await stored.body?.cancel().catch(() => {});
    if (!stored.ok) throw new ImportRefusal(stored.status, UPLOAD_FAILED);
    const file = await call({ path, method: "POST", body: { action: "finalize", uploadKey: prepared.uploadKey, filename, mime } });
    return assistantImportOutput.upload.parse(await file.json());
  }

  async function publish(id: string, body: Extract<AssistantImportInput, { action: "publish" }>["body"]) {
    // A document still being read answers 409 with the counts, which is a state to wait out, not a refusal.
    const res = await call({ path: importPath(id) + "/publish", method: "POST", body }, 30_000, true);
    if (res.status === 409) {
      const conflict: unknown = await res.json().catch(() => null);
      const waiting = assistantImportOutput.publish.safeParse(conflict);
      if (waiting.success && waiting.data.outcome === "not_ready") return waiting.data;
      const code = (conflict as { code?: unknown } | null)?.code;
      throw new ImportRefusal(409, typeof code === "string" ? code.slice(0, 120) : "HTTP_409");
    }
    return assistantImportOutput.publish.parse(await res.json());
  }

  async function run<Action extends AssistantImportInput["action"]>(work: () => Promise<Output<Action>>): Promise<AssistantImportResult<Action>> {
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      if (error instanceof ImportRefusal) return { ok: false, status: error.status, code: error.code };
      if (error instanceof AccountDataRefusal) return { ok: false, status: 0, code: error.code ?? FAILED };
      if (error instanceof Error && error.name === "AbortError") throw error;
      return { ok: false, status: 0, code: FAILED };
    }
  }

  return {
    /** The result is typed by the action the window named; the main process hands it back unchanged. */
    handle(input: AssistantImportInput): Promise<AssistantImportResult<AssistantImportInput["action"]>> {
      switch (input.action) {
        case "targets": return run<"targets">(targets);
        case "pickPackage": return run<"pickPackage">(pickPackage);
        case "create": return run<"create">(() => create(input.body));
        case "upload": return run<"upload">(() => upload(input.importId, input.filename, input.bytes));
        case "read": return run<"read">(async () => assistantImportOutput.read.parse(await (await call({ path: importPath(input.importId) })).json()));
        case "publish": return run<"publish">(() => publish(input.importId, input.body));
        case "cancel": return run<"cancel">(async () => {
          await (await call({ path: importPath(input.importId), method: "DELETE" })).body?.cancel().catch(() => {});
          return {};
        });
      }
    },
  };
}

export type AssistantImportApi = ReturnType<typeof createAssistantImportApi>;
