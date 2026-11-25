import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { SUPPORTED_LANGUAGES } from "../../../../lib/language";
import {
  DESKTOP_AUTH_CLIENT, DESKTOP_AUTH_VALUE, DESKTOP_CALLBACK_PATH, DESKTOP_LIVE_ORIGIN, type DesktopIdentityProvider,
} from "../../../../lib/desktopAuthContract";
import type { DesktopEmailResult, DesktopLoginEmail } from "../login-contract";

const sessionResponse = z.object({
  ok: z.literal(true), accessToken: z.string().min(1).max(8_192),
  refreshToken: z.string().min(1).max(512),
  expiresIn: z.number().int().min(1).max(600),
});
const accountResponse = z.object({
  ok: z.literal(true),
  account: z.object({
    id: z.string().min(1).max(128), email: z.string().max(320).nullable(), name: z.string().max(256).nullable(),
    language: z.enum(SUPPORTED_LANGUAGES).optional(),
  }),
});

export type BrowserAccount = z.infer<typeof accountResponse>["account"];
export type BrowserSession = { account: BrowserAccount; tokens: Omit<z.infer<typeof sessionResponse>, "ok"> };

export class DesktopSessionRefused extends Error {}

async function sendRefreshCredential(path: "/api/auth/desktop/refresh" | "/api/auth/desktop/logout",
  refreshToken: string, signal: AbortSignal, origin = DESKTOP_LIVE_ORIGIN,
) {
  const response = await fetch(new URL(path, origin), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken }),
    redirect: "error", cache: "no-store", signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new DesktopSessionRefused();
    throw new Error("The Desktop session request failed.");
  }
  return response;
}

export async function refreshBrowserSession(refreshToken: string, signal: AbortSignal, origin?: string) {
  const response = await sendRefreshCredential("/api/auth/desktop/refresh", refreshToken, signal, origin);
  return sessionResponse.parse(await response.json());
}

export async function revokeBrowserSession(refreshToken: string, signal: AbortSignal, origin?: string) {
  const response = await sendRefreshCredential("/api/auth/desktop/logout", refreshToken, signal, origin);
  await response.body?.cancel().catch(() => {});
}

export async function readBrowserAccount(accessToken: string, signal: AbortSignal, origin = DESKTOP_LIVE_ORIGIN) {
  const response = await fetch(new URL("/api/auth/desktop/session", origin), {
    headers: { Authorization: "Bearer " + accessToken }, redirect: "error", cache: "no-store", signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new DesktopSessionRefused();
    throw new Error("The connected Desktop account could not be confirmed.");
  }
  return accountResponse.parse(await response.json()).account;
}

export async function signInByDesktopEmail(input: DesktopLoginEmail, version: string, signal: AbortSignal, origin = DESKTOP_LIVE_ORIGIN,
  turnstileToken?: string, language = "en"): Promise<DesktopEmailResult | { ok: true; session: BrowserSession }> {
  const response = await fetch(new URL("/api/auth/desktop/email", origin), {
    method: "POST", headers: { "Content-Type": "application/json", "Accept-Language": language },
    body: JSON.stringify(input.action === "verify" ? { ...input, appVersion: version } : { ...input, turnstileToken }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: "error", cache: "no-store",
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({})) as { code?: unknown };
    const retryAfter = Number(response.headers.get("Retry-After"));
    if (details.code === "TURNSTILE_REQUIRED" || details.code === "TURNSTILE_FAILED") return { ok: false, status: "challenge" };
    if (response.status === 429) return { ok: false, status: "retry", retryAfter: retryAfter > 0 ? Math.min(retryAfter, 86_400) : undefined };
    if (input.action === "verify" && response.status === 401 &&
      (details.code === "EMAIL_CODE_INVALID" || details.code === "EMAIL_CODE_LOCKED")) return { ok: false, status: "rejected" };
    if (response.status === 404 || response.status === 503 || details.code === "INVALID_REQUEST_ORIGIN") {
      return { ok: false, status: "unavailable" };
    }
    return { ok: false, status: "failed" };
  }
  if (input.action === "request") {
    z.object({ ok: z.literal(true) }).parse(await response.json());
    return { ok: true };
  }
  const tokens = sessionResponse.parse(await response.json());
  return { ok: true, session: { tokens, account: await readBrowserAccount(tokens.accessToken, signal, origin) } };
}

function showBrowserResult(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    Connection: "close",
  }).end(message);
}

export async function signInThroughBrowser(options: {
  openExternal: (url: string) => Promise<void>;
  version: string;
  provider?: DesktopIdentityProvider;
  signal: AbortSignal;
  origin?: string;
}) {
  const origin = options.origin ?? DESKTOP_LIVE_ORIGIN;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(5 * 60_000)]);
  signal.throwIfAborted();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let accept!: (session: BrowserSession) => void;
  let reject!: (reason: unknown) => void;
  const callback = new Promise<BrowserSession>((resolve, rejectPromise) => { accept = resolve; reject = rejectPromise; });
  void callback.catch(() => {});
  let host: string;
  let handled = false;

  const server = createServer({ maxHeaderSize: 4_096, requestTimeout: 5_000, headersTimeout: 5_000 }, async (request, response) => {
    const target = request.url ?? "";
    if (request.method !== "GET" || request.headers.host !== host || !target.startsWith(DESKTOP_CALLBACK_PATH + "?")) {
      showBrowserResult(response, 404, "Desktop sign-in callback not found.");
      return;
    }
    const params = new URLSearchParams(target.slice(DESKTOP_CALLBACK_PATH.length + 1));
    const grant = params.get("grant");
    const reportedState = params.get("state");
    if (!grant || !reportedState || !DESKTOP_AUTH_VALUE.test(grant) || !DESKTOP_AUTH_VALUE.test(reportedState) ||
      params.size !== 2 || !timingSafeEqual(Buffer.from(reportedState), Buffer.from(state))) {
      showBrowserResult(response, 400, "The Desktop sign-in request was invalid.");
      return;
    }
    if (handled || signal.aborted) {
      showBrowserResult(response, 410, "This Desktop sign-in request is closed.");
      return;
    }
    handled = true;
    try {
      const exchange = await fetch(new URL("/api/auth/desktop/exchange", origin), {
        method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error", cache: "no-store", signal,
        body: JSON.stringify({ clientId: DESKTOP_AUTH_CLIENT, redirectUri: "http://" + host + DESKTOP_CALLBACK_PATH,
          state, grant, codeVerifier: verifier, appVersion: options.version }),
      });
      if (!exchange.ok) {
        await exchange.body?.cancel().catch(() => {});
        throw new Error("The Desktop grant was rejected.");
      }
      const { accessToken, refreshToken, expiresIn } = sessionResponse.parse(await exchange.json());
      const account = await readBrowserAccount(accessToken, signal, origin);
      signal.throwIfAborted();
      showBrowserResult(response, 200, "Tomverse Desktop is connected. You can return to the app.");
      accept({ account, tokens: { accessToken, refreshToken, expiresIn } });
    } catch (error) {
      showBrowserResult(response, 400, "Desktop sign-in could not be completed. Restart sign-in in the app.");
      reject(error);
    }
  });
  const onAbort = () => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    server.listen({ port: 0, host: "127.0.0.1", signal });
    await once(server, "listening", { signal });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The Desktop callback could not be opened.");
    host = "127.0.0.1:" + address.port;
    const auth = new URL("/auth/desktop", origin);
    auth.search = new URLSearchParams({
      client_id: DESKTOP_AUTH_CLIENT, redirect_uri: "http://" + host + DESKTOP_CALLBACK_PATH, state,
      code_challenge: challenge, code_challenge_method: "S256",
    }).toString();
    if (options.provider) auth.searchParams.set("provider", options.provider);
    await Promise.race([options.openExternal(auth.href), callback]);
    return await callback;
  } finally {
    signal.removeEventListener("abort", onAbort);
    server.close();
    if (signal.aborted || !handled) server.closeAllConnections();
  }
}
