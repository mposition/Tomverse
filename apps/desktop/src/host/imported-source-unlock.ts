import {
  chatImportedSource, chatImportedSourceWire, type ChatImportedSource, type ChatImportedSourceWire, type ChatSourceInput,
  type ChatUnlockImportedResult,
} from "../chat-contract";
import type { AccountSettingsApi } from "./account-settings-api";

// Unlocking a password-locked imported original inside the app.
//
// The server issues the unlock grant in one place only: the web verify route, which answers with a
// cookie. The main process calls it on the account session, keeps the grant cookie in this object's
// memory (never on disk, never sent to the renderer), and adds it to the account-session reads of that
// one conversation's original. Signing out or switching account aborts the account signal, which
// discards every grant. The renderer only ever holds the password for the moment it submits it.

type Session = Pick<AccountSettingsApi, "send" | "forget">;

const COOKIE_PREFIX = "tomverse_unlock_external_conversation_";
const GRANT_VALUE = /^(\d{1,12})\.(\d{1,9})\.[A-Za-z0-9_-]{16,128}$/;
// The server grant lasts 30 minutes; a longer claim is not one this app keeps.
const GRANT_MAX_SECONDS = 2 * 60 * 60;
const EXTERNAL_ID = /^[A-Za-z0-9_-]{1,100}$/;

type Grant = { cookie: string; expiresAt: number };

// The verify route's answer for a snapshot that has no password (app/api/external-conversations/
// [conversationId]/lock/verify/route.ts): 400 with exactly this body and no `code`. Its other 400s
// (INVALID_JSON, INVALID_REQUEST and lock errors) carry a code, and a proxy's 400 is not this JSON.
const NOT_LOCKED_ERROR = "This conversation is not locked.";

async function saysNotLocked(res: Response): Promise<boolean> {
  if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return false;
  const body: unknown = await res.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body).sort();
  const { success, error } = body as { success?: unknown; error?: unknown };
  return keys.length === 2 && keys[0] === "error" && keys[1] === "success" && success === false && error === NOT_LOCKED_ERROR;
}

const sourcePath = (id: string, offset: number | undefined) =>
  `/api/conversations/${encodeURIComponent(id)}/continuation?offset=${offset ?? "end"}&limit=50`;

/** What the renderer may see: no snapshot id, and whether a password can open this original. */
function forRenderer(page: ChatImportedSourceWire): ChatImportedSource {
  const { externalConversationId, ...source } = page.source;
  return chatImportedSource.parse({
    provider: page.provider,
    source: source.status === "locked" ? { ...source, unlockable: Boolean(externalConversationId) } : source,
  });
}

export function createImportedSourceUnlock(options: { settings: Session; signal: AbortSignal; now?: () => number }) {
  const { settings, signal } = options;
  const now = options.now ?? Date.now;
  // Which snapshot a conversation's locked original is, as the server last named it to this app.
  const targets = new Map<string, string>();
  const grants = new Map<string, Grant>();
  const clear = () => { targets.clear(); grants.clear(); };
  signal.addEventListener("abort", clear, { once: true });

  const grantFor = (externalId: string) => {
    const grant = grants.get(externalId);
    if (grant && grant.expiresAt - 5_000 <= now()) grants.delete(externalId);
    return grants.get(externalId);
  };

  async function readWithGrant(input: ChatSourceInput, grant: Grant) {
    const res = await settings.send({ path: sourcePath(input.id, input.offset) }, "application/json", 15_000, { Cookie: grant.cookie });
    if (res.status === 401) settings.forget();
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return chatImportedSourceWire.parse(await res.json());
  }

  return {
    /** Reads the original; `load` is the bearer read the app has always made. */
    async read(input: ChatSourceInput, load: () => Promise<ChatImportedSourceWire>): Promise<ChatImportedSource> {
      signal.throwIfAborted();
      const known = targets.get(input.id);
      const held = known ? grantFor(known) : undefined;
      if (known && held) {
        const page = await readWithGrant(input, held);
        signal.throwIfAborted();
        if (page && page.source.status !== "locked") return forRenderer(page);
        // The grant is spent, replaced or the lock changed: ask again from the start.
        grants.delete(known);
      }
      const page = await load();
      signal.throwIfAborted();
      if (page.source.status === "locked" && page.source.externalConversationId) targets.set(input.id, page.source.externalConversationId);
      else targets.delete(input.id);
      return forRenderer(page);
    },

    async unlock(id: string, password: string): Promise<ChatUnlockImportedResult> {
      signal.throwIfAborted();
      const target = targets.get(id);
      if (!target || !EXTERNAL_ID.test(target)) return { status: "unavailable" };
      let res: Response;
      try {
        res = await settings.send({
          path: `/api/external-conversations/${encodeURIComponent(target)}/lock/verify`, method: "POST", body: { password },
        }, "application/json", 20_000);
      } catch (error) {
        if (signal.aborted) throw error;
        // The settings session or the network is not available: nothing was decided about the password.
        return { status: "unavailable" };
      }
      signal.throwIfAborted();
      const headers = res.headers;
      const setCookies = headers.getSetCookie?.() ?? [];
      // A 400 body is read only to recognise the route's own "not locked" answer; other bodies are discarded unread.
      const notLocked = res.status === 400 && await saysNotLocked(res);
      signal.throwIfAborted();
      await res.body?.cancel().catch(() => {});
      if (res.status === 401) settings.forget();
      if (res.status === 403) return { status: "wrong" };
      if (res.status === 429) {
        const wait = Number(headers.get("retry-after"));
        return Number.isInteger(wait) && wait > 0 ? { status: "limited", retryAfterSeconds: Math.min(wait, 86_400) } : { status: "limited" };
      }
      if (res.status === 503 || res.status === 501) return { status: "unavailable" };
      // A lock that was removed meanwhile needs no grant: the next read simply succeeds. Any other 400
      // (a malformed request, a proxy's error page) decided nothing about the lock.
      if (notLocked) return { status: "unlocked" };
      if (!res.ok) return { status: "failed" };
      const name = COOKIE_PREFIX + target;
      const pair = setCookies.map((line) => line.split(";", 1)[0].trim()).find((part) => part.startsWith(name + "="));
      const value = pair?.slice(name.length + 1);
      const match = value ? GRANT_VALUE.exec(value) : null;
      const expiresAt = match ? Number(match[1]) * 1_000 : 0;
      if (!match || expiresAt <= now() || expiresAt > now() + GRANT_MAX_SECONDS * 1_000) return { status: "failed" };
      grants.set(target, { cookie: name + "=" + value, expiresAt });
      return { status: "unlocked" };
    },

    /** Forgets every grant now (sign-out and account change do this through the signal as well). */
    clear,
    /** How many unlock grants are held; for tests and diagnostics, never the grants themselves. */
    held: () => grants.size,
  };
}

export type ImportedSourceUnlock = ReturnType<typeof createImportedSourceUnlock>;
