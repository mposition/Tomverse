import { createHash } from "node:crypto";
import { z } from "zod";
import { EXTERNAL_IMPORT_PARSER_VERSION } from "../../../../lib/externalImportAdapters";
import {
  desktopAccountSettingsOutput,
  type DesktopAccountSettingsInput,
} from "../account-settings-contract";

const settingsCredential = z.object({
  token: z.string().max(3_500).regex(/^[\w-]+\.[\w-]*\.[\w-]+\.[\w-]+\.[\w-]+$/),
  expiresAt: z.number().int().refine((value) => value > Date.now() && value <= Date.now() + 360_000),
}).strict();

type SettingsRequest = { path: string; method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: object };

function settingsRequest(input: DesktopAccountSettingsInput): SettingsRequest {
  switch (input.action) {
    case "preferences":
      return { path: "/api/user/settings" };
    case "savePreferences":
      return {
        path: "/api/user/settings", method: "POST",
        body: { ...input.changes, ...(input.changes.timeZone ? { timeZoneSource: "user" } : {}) },
      };
    case "loginMethods":
      return { path: "/api/user/login-methods" };
    case "email":
      return { path: "/api/user/email-preferences" };
    case "saveEmail":
      return { path: "/api/user/email-preferences", method: "PATCH", body: input.changes };
    case "memory":
      return { path: "/api/memories/settings" };
    case "saveMemory":
      return { path: "/api/memories/settings", method: "PUT", body: input.values };
    case "memories":
      return { path: "/api/memories?limit=50&offset=" + input.offset };
    case "memoryDetail":
      return { path: `/api/memories/${encodeURIComponent(input.id)}` };
    case "updateMemory":
      return { path: `/api/memories/${encodeURIComponent(input.id)}`, method: "PATCH", body: input.values };
    case "addMemory":
      return { path: "/api/memories", method: "POST",
        body: { kind: input.kind, statement: input.statement, groundsText: input.groundsText } };
    case "assistants":
      return { path: "/api/assistant-profiles" };
    case "assistant":
      return { path: `/api/assistant-profiles/${encodeURIComponent(input.id)}` };
    case "saveAssistantIdentity":
      return { path: `/api/assistant-profiles/${encodeURIComponent(input.id)}`, method: "PATCH", body: input.values };
    case "publishAssistant":
      return { path: `/api/assistant-profiles/${encodeURIComponent(input.id)}/versions`, method: "POST", body: input.values };
    case "createAssistant":
      return { path: "/api/assistant-profiles", method: "POST", body: { name: input.name, description: input.description, instructions: input.instructions } };
    case "imports":
      return { path: "/api/external-conversations?limit=50&offset=" + input.offset };
    case "importRuns":
      return { path: "/api/imports/external" };
    case "importConversation":
      return { path: `/api/external-conversations/${encodeURIComponent(input.id)}?limit=100&offset=${input.offset}` };
    case "importCapacity":
      return { path: "/api/imports/external/capacity" };
    case "startImport":
      return { path: "/api/imports/external", method: "POST", body: { provider: input.provider, parserVersion: EXTERNAL_IMPORT_PARSER_VERSION } };
    case "importStatus":
      return { path: `/api/imports/external/${encodeURIComponent(input.id)}` };
    case "appendImport":
      return { path: `/api/imports/external/${encodeURIComponent(input.id)}/batches`, method: "POST", body: input.batch };
    case "sealImport":
      return { path: `/api/imports/external/${encodeURIComponent(input.id)}/seal`, method: "POST", body: {
        finalSequence: input.finalSequence, expectedStagedConversationIds: input.expectedStagedConversationIds,
        expectedDuplicateCount: input.expectedDuplicateCount,
      } };
    case "finishImport":
      return { path: `/api/imports/external/${encodeURIComponent(input.id)}/finalize`, method: "POST", body: {
        selectedConversationIds: input.selectedConversationIds, expectedImportDigest: input.expectedImportDigest, idempotencyKey: input.key,
      } };
    case "continueImport":
      return {
        path: "/api/external-conversations/" + encodeURIComponent(input.id) + "/continuations",
        method: "POST", body: { idempotencyKey: input.key },
      };
    case "reviewContinuation":
      return {
        path: "/api/conversations/" + encodeURIComponent(input.id) + "/continuation/review",
        method: "POST", body: { idempotencyKey: input.key },
      };
    case "pinConversation":
      return { path: `/api/conversations/${encodeURIComponent(input.id)}/pin`, method: "PUT",
        body: { pinned: input.pinned, seq: input.seq } };
    case "projects":
      return { path: "/api/projects" };
    case "addProject":
      return { path: "/api/projects", method: "POST", body: { name: input.name } };
    case "renameProject":
      return { path: `/api/projects/${encodeURIComponent(input.id)}`, method: "PATCH", body: { name: input.name } };
    case "removeProject":
      return { path: `/api/projects/${encodeURIComponent(input.id)}`, method: "DELETE" };
    case "moveToProject":
      return { path: `/api/conversations/${encodeURIComponent(input.id)}`, method: "PATCH", body: { projectId: input.projectId } };
    case "changeConversationLock":
      return { path: `/api/conversations/${encodeURIComponent(input.id)}`, method: "PATCH", body: input.values };
    case "shareConversation":
      return { path: `/api/conversations/${encodeURIComponent(input.id)}/share`, method: "POST" };
    case "revokeConversationShare":
      return { path: `/api/conversations/${encodeURIComponent(input.id)}/share`, method: "DELETE" };
    case "keys":
      return { path: "/api/user/api-keys" };
    case "createKey":
      return { path: "/api/user/api-keys", method: "POST",
        body: { name: input.name, creditCap: input.creditCap, expiresInDays: input.expiresInDays } };
    case "updateKey":
      return { path: "/api/user/api-keys/" + encodeURIComponent(input.id), method: "PATCH",
        body: { name: input.name, creditCap: input.creditCap } };
    case "revokeKey":
      return { path: "/api/user/api-keys/" + encodeURIComponent(input.id), method: "DELETE" };
    case "usage":
      return { path: "/api/user/usage" };
  }
}

export function createAccountSettingsApi(
  origin: string,
  authorize: () => Promise<string>,
  accountSignal: AbortSignal,
  transport: typeof fetch = fetch,
) {
  let saved: z.infer<typeof settingsCredential> | undefined;
  let renewal: Promise<z.infer<typeof settingsCredential>> | undefined;
  const signal = (timeout = 12_000) => AbortSignal.any([accountSignal, AbortSignal.timeout(timeout)]);
  accountSignal.addEventListener("abort", () => { saved = undefined; }, { once: true });

  async function credential() {
    accountSignal.throwIfAborted();
    if (saved && saved.expiresAt > Date.now() + 30_000) return saved;
    renewal ??= (async () => {
      const accessToken = await authorize();
      accountSignal.throwIfAborted();
      const res = await transport(origin + "/api/auth/desktop/settings-session", {
        method: "POST", headers: { Origin: origin, Authorization: "Bearer " + accessToken },
        redirect: "error", cache: "no-store", signal: signal(),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error("Account settings are unavailable.");
      }
      const decoded = settingsCredential.parse(await res.json());
      accountSignal.throwIfAborted();
      return saved = decoded;
    })().finally(() => { renewal = undefined; });
    return renewal;
  }

  async function send({ path, method = "GET", body }: SettingsRequest, accept = "application/json", timeout?: number) {
    const session = await credential();
    const cookie = origin.startsWith("https:") ? "__Secure-next-auth.session-token" : "next-auth.session-token";
    return transport(new URL(path, origin), {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: {
        Cookie: cookie + "=" + session.token, Origin: origin, Accept: accept,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      redirect: "error", cache: "no-store", signal: signal(timeout),
    });
  }

  async function request(input: DesktopAccountSettingsInput) {
    const res = await send(settingsRequest(input));
    if (input.action === "pinConversation") {
      accountSignal.throwIfAborted();
      if (res.status === 401) saved = undefined;
      if (res.ok || res.status === 409) {
        const value = z.object({ pinned: z.boolean(), pinSeq: z.number().int().positive() }).safeParse(await res.json());
        accountSignal.throwIfAborted();
        if (value.success) return desktopAccountSettingsOutput.pinConversation.parse({
          kind: res.ok ? "applied" : "superseded", pinned: value.data.pinned, seq: value.data.pinSeq,
        });
        return desktopAccountSettingsOutput.pinConversation.parse({ kind: res.ok ? "failed" : "refused" });
      }
      await res.body?.cancel().catch(() => {});
      return desktopAccountSettingsOutput.pinConversation.parse({
        kind: res.status === 404 ? "gone" : res.status >= 500 ? "failed" : "refused",
      });
    }
    if (!res.ok) {
      if (res.status === 401) saved = undefined;
      await res.body?.cancel().catch(() => {});
      throw new Error("Tomverse could not complete the account settings action.");
    }
    const value = desktopAccountSettingsOutput[input.action].parse(await res.json());
    accountSignal.throwIfAborted();
    return value;
  }
  async function exportConversation(id: string, includeSource: boolean) {
    const path = `/api/conversations/${encodeURIComponent(id)}/export${includeSource ? "?include=source" : ""}`;
    const res = await send({ path }, "text/plain", 120_000);
    if (!res.ok || !res.body || res.headers.get("content-type")?.split(";")[0] !== "text/plain") {
      if (res.status === 401) saved = undefined;
      await res.body?.cancel().catch(() => {});
      throw new Error("Tomverse could not download the conversation.");
    }
    const maxBytes = 128 * 1024 * 1024;
    const advertisedLength = res.headers.get("x-export-bytes");
    const advertisedHash = res.headers.get("x-export-sha256")?.toLowerCase();
    const verify = includeSource || advertisedLength !== null || advertisedHash !== undefined;
    const expectedLength = advertisedLength && /^[1-9]\d*$/.test(advertisedLength) ? Number(advertisedLength) : 0;
    if (verify && (!expectedLength || expectedLength > maxBytes || !advertisedHash || !/^[a-f0-9]{64}$/.test(advertisedHash))) {
      await res.body.cancel().catch(() => {});
      throw new Error("The conversation export verification headers are invalid.");
    }
    const hash = verify ? createHash("sha256") : null;
    const chunks: Uint8Array[] = [];
    const reader = res.body.getReader();
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > (verify ? expectedLength : maxBytes)) {
          await reader.cancel().catch(() => {});
          throw new Error("The conversation export is too large.");
        }
        hash?.update(value);
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    accountSignal.throwIfAborted();
    if (hash && (length !== expectedLength || hash.digest("hex") !== advertisedHash)) {
      throw new Error("The conversation export did not pass verification.");
    }
    return Buffer.concat(chunks, length);
  }
  return Object.assign(request, { exportConversation });
}
