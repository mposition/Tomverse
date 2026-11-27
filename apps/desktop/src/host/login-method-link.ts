import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { z } from "zod";
import { DESKTOP_CALLBACK_PATH } from "../../../../lib/desktopAuthContract";
import {
  DESKTOP_LINK_CODE_MAX_LENGTH, DESKTOP_LINK_STATE_MAX_LENGTH, DESKTOP_LINK_STATE_PREFIX, type DesktopLinkProvider,
} from "../../../../lib/desktopSocialLoginCore";
import type { DesktopAccountDataResult } from "../account-data-contract";
import { showBrowserResult } from "./browser-login";

// Adding Google or Microsoft as a login method: the provider's page opens in the system browser, never in a window of
// this app. Desktop makes the PKCE pair and listens on a loopback address; the server answers with the provider URL and
// a signed state, and the provider's return reaches this listener through the server's callback. The link itself is
// then made by a second call from the account settings session, with the verifier that never left this process.

/** The only places the system browser is sent: a server answer cannot point it anywhere else. */
export const LINK_PROVIDER_HOSTS: Record<DesktopLinkProvider, string> = {
  google: "accounts.google.com",
  "azure-ad": "login.microsoftonline.com",
};

const LINK_TIMEOUT_MS = 5 * 60_000;
const started = z.object({
  ok: z.literal(true),
  url: z.string().max(4_096),
  linkState: z.string().max(DESKTOP_LINK_STATE_MAX_LENGTH).startsWith(DESKTOP_LINK_STATE_PREFIX),
});

type Call = (request: { path: string; method: "POST"; body: object }) => Promise<Response>;

function providerUrl(value: string, provider: DesktopLinkProvider) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== LINK_PROVIDER_HOSTS[provider] || url.username || url.password) {
    throw new Error("The sign-in page is not the provider's.");
  }
  return url.href;
}

export async function linkLoginMethodThroughBrowser(options: {
  call: Call;
  openExternal: (url: string) => Promise<void>;
  provider: DesktopLinkProvider;
  /** Ends the wait when the person cancels or the account session ends. */
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<DesktopAccountDataResult> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? LINK_TIMEOUT_MS)]);
  signal.throwIfAborted();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let linkState: string | undefined;
  let host = "";
  let handled = false;
  let accept!: (answer: { code?: string; error?: string }) => void;
  let reject!: (reason: unknown) => void;
  const callback = new Promise<{ code?: string; error?: string }>((resolve, rejectPromise) => { accept = resolve; reject = rejectPromise; });
  void callback.catch(() => {});

  const server = createServer({ maxHeaderSize: 4_096, requestTimeout: 5_000, headersTimeout: 5_000 }, (request, response) => {
    const target = request.url ?? "";
    if (request.method !== "GET" || request.headers.host !== host || !target.startsWith(DESKTOP_CALLBACK_PATH + "?")) {
      showBrowserResult(response, 404, "Tomverse Desktop callback not found.");
      return;
    }
    const params = new URLSearchParams(target.slice(DESKTOP_CALLBACK_PATH.length + 1));
    const state = params.get("state");
    const code = params.get("code");
    const error = params.get("error");
    const answered = code !== null ? code.length >= 1 && code.length <= DESKTOP_LINK_CODE_MAX_LENGTH && error === null
      : error !== null && /^[a-z_]{1,64}$/.test(error);
    // Exactly the state and one answer, and the state is the one this attempt was given.
    if (!linkState || !state || state.length !== linkState.length || !timingSafeEqual(Buffer.from(state), Buffer.from(linkState)) ||
        params.size !== 2 || !answered) {
      showBrowserResult(response, 400, "The Tomverse Desktop request was invalid.");
      return;
    }
    if (handled || signal.aborted) {
      showBrowserResult(response, 410, "This Tomverse Desktop request is closed.");
      return;
    }
    handled = true;
    showBrowserResult(response, 200, "You can return to Tomverse Desktop.");
    accept(code !== null ? { code } : { error: error ?? "invalid_request" });
  });
  const onAbort = () => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    server.listen({ port: 0, host: "127.0.0.1", signal });
    await once(server, "listening", { signal });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The Desktop callback could not be opened.");
    host = "127.0.0.1:" + address.port;
    const begin = started.parse(await (await options.call({
      path: "/api/user/login-methods/oauth/desktop/start", method: "POST",
      body: { provider: options.provider, redirectUri: "http://" + host + DESKTOP_CALLBACK_PATH, codeChallenge: challenge },
    })).json());
    linkState = begin.linkState;
    await Promise.race([options.openExternal(providerUrl(begin.url, options.provider)), callback]);
    const answer = await callback;
    // Declining at the provider is a choice, not a failure.
    if (answer.error !== undefined || answer.code === undefined) return { status: "cancelled" };
    await options.call({
      path: "/api/user/login-methods/oauth/desktop/complete", method: "POST",
      body: { linkState, code: answer.code, codeVerifier: verifier },
    });
    return { status: "saved" };
  } catch (error) {
    if (signal.aborted) return { status: options.signal.aborted ? "cancelled" : "expired" };
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    server.close();
    if (signal.aborted || !handled) server.closeAllConnections();
  }
}
