import { z } from "zod";
import {
  desktopAccountDataResult, type AccountDataStatus, type DesktopAccountDataInput, type DesktopAccountDataResult,
} from "../account-data-contract";
import type { AccountSettingsApi } from "./account-settings-api";

// File downloads and irreversible account actions that run in the main process
// on the shared Desktop account session. The renderer sends a typed action; the
// path, the save dialog and the sign-out after an account deletion stay here.

const ACCOUNT_EXPORT_MAX_BYTES = 256 * 1024 * 1024;
const FILE_MAX_BYTES = 128 * 1024 * 1024;
// Same names lib/continuationTitleContext.ts sends from the web page; imported there
// through the web-only `@/` alias, which the main-process bundle does not use.
const namingHeaders = (language: string) => ({
  "X-Tomverse-Language": language,
  "X-Tomverse-Time-Zone": Intl.DateTimeFormat().resolvedOptions().timeZone,
});
const ticketPath = /^\/api\/user\/account\/export\/[A-Za-z0-9_-]{16,256}$/;

export class AccountDataRefusal extends Error {
  constructor(readonly status: AccountDataStatus) { super("Account data action refused: " + status); }
}

export type AccountDataSave = (file: {
  suggestedName: string; extension: string; filterName: string; load: () => Promise<Uint8Array>;
}) => Promise<boolean>;

type Session = Pick<AccountSettingsApi, "send" | "forget">;

/** Status for a response that is not 2xx. Never reads the body. */
export function refusalStatus(status: number): AccountDataStatus {
  if (status === 428) return "reauth";
  if (status === 423) return "locked";
  if (status === 403) return "notIncluded";
  if (status === 404 || status === 501 || status === 503) return "unavailable";
  return "failed";
}

export async function readBoundedBody(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) throw new AccountDataRefusal("failed");
  const advertised = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw new AccountDataRefusal("failed");
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AccountDataRefusal("failed");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export const mediaType = (res: Response) => res.headers.get("content-type")?.split(";")[0].trim().toLowerCase();

export function createAccountDataApi(options: {
  settings: Session;
  save: AccountDataSave;
  /** Called after the server accepted an account deletion; signs this Desktop out. */
  afterAccountDeleted: () => Promise<void>;
  language: () => string;
  now?: () => number;
}) {
  const { settings, save } = options;
  const now = options.now ?? Date.now;
  let ticket: { path: string; expiresAt: number } | undefined;

  async function call(request: Parameters<Session["send"]>[0], accept = "application/json", timeout?: number, headers?: Record<string, string>) {
    const res = await settings.send(request, accept, timeout, headers);
    if (res.status === 401) settings.forget();
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new AccountDataRefusal(res.status === 401 ? "failed" : refusalStatus(res.status));
    }
    return res;
  }

  const day = () => new Date(now()).toISOString().slice(0, 10);

  async function run(work: () => Promise<DesktopAccountDataResult>): Promise<DesktopAccountDataResult> {
    try {
      return desktopAccountDataResult.parse(await work());
    } catch (error) {
      if (error instanceof AccountDataRefusal) return { status: error.status };
      if (error instanceof Error && error.name === "AbortError") throw error;
      return { status: "failed" };
    }
  }

  async function requestExport() {
    const res = await call({ path: "/api/user/account/export", method: "POST" });
    const body = z.object({ downloadPath: z.string(), expiresAt: z.iso.datetime() }).parse(await res.json());
    const expiresAt = Date.parse(body.expiresAt);
    if (!ticketPath.test(body.downloadPath) || !(expiresAt > now())) throw new AccountDataRefusal("failed");
    ticket = { path: body.downloadPath, expiresAt };
    return { status: "ready" as const, expiresAt: body.expiresAt };
  }

  async function saveExport() {
    const current = ticket;
    if (!current || current.expiresAt <= now()) {
      ticket = undefined;
      return { status: "expired" as const };
    }
    const saved = await save({
      suggestedName: `tomverse-account-data-${day()}.json`, extension: "json", filterName: "JSON",
      load: async () => {
        // The link is spent the moment it is fetched, whatever happens next.
        if (ticket === current) ticket = undefined;
        const res = await call({ path: current.path }, "application/json", 120_000);
        if (mediaType(res) !== "application/json") {
          await res.body?.cancel().catch(() => {});
          throw new AccountDataRefusal("failed");
        }
        const bytes = await readBoundedBody(res, ACCOUNT_EXPORT_MAX_BYTES);
        const parsed = z.object({ manifest: z.object({}).passthrough() }).passthrough().safeParse(JSON.parse(bytes.toString("utf8")));
        if (!parsed.success) throw new AccountDataRefusal("failed");
        return bytes;
      },
    });
    return { status: saved ? "saved" as const : "cancelled" as const };
  }

  async function saveAllConversations() {
    const saved = await save({
      suggestedName: "tomverse-all-conversations.txt", extension: "txt", filterName: "TXT",
      load: async () => {
        const res = await call({ path: "/api/conversations/export-all" }, "text/plain", 180_000,
          namingHeaders(options.language()));
        if (mediaType(res) !== "text/plain") {
          await res.body?.cancel().catch(() => {});
          throw new AccountDataRefusal("failed");
        }
        return readBoundedBody(res, FILE_MAX_BYTES);
      },
    });
    return { status: saved ? "saved" as const : "cancelled" as const };
  }

  async function deleteAllConversations() {
    const res = await call({ path: "/api/conversations", method: "DELETE" });
    const body = z.object({ success: z.literal(true), deleted: z.number().int().nonnegative() }).parse(await res.json());
    return { status: "deleted" as const, deleted: body.deleted };
  }

  async function deleteAccount(confirmationText: string) {
    const res = await call({ path: "/api/user/account", method: "DELETE", body: { confirm: true, confirmationText } });
    z.object({ success: z.literal(true) }).passthrough().parse(await res.json());
    ticket = undefined;
    await options.afterAccountDeleted();
    return { status: "deleted" as const };
  }

  return {
    run,
    forgetTicket: () => { ticket = undefined; },
    handle(input: DesktopAccountDataInput): Promise<DesktopAccountDataResult> {
      return run(async () => {
        switch (input.action) {
          case "requestExport": return requestExport();
          case "saveExport": return saveExport();
          case "saveAllConversations": return saveAllConversations();
          case "deleteAllConversations": return deleteAllConversations();
          case "deleteAccount": return deleteAccount(input.confirmation);
        }
      });
    },
    // Building blocks for the memory and assistant modules.
    call,
    save,
    day,
  };
}

export type AccountDataApi = ReturnType<typeof createAccountDataApi>;
