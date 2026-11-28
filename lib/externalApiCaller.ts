import "server-only";
import { requireDesktopCodeBearer } from "@/lib/desktopAuthServer";
import { authenticateExternalApiKey, ExternalApiKeyError, type AuthenticatedExternalApiKey } from "@/lib/externalApiKeys";
import { DESKTOP_APP_ORIGIN, desktopCodeSessionRoute } from "@/lib/nativeBearerGate";

/**
 * Who an external API request is from, and what it is charged to.
 *
 * Two credentials reach the same caller. An API key (every tool, every route), or -- only for the coding API calls
 * Desktop Code's agent engine makes, from the Desktop origin, while TOMVERSE_DESKTOP_CODE_SESSION_ENABLED is on --
 * the account's signed-in Desktop session, through the short Code token minted for it (/api/auth/desktop/code-token,
 * accepted only on those calls; owner decision 2026-11-27, docs/policy/external-api.md section 11.2). Both
 * resolve to the account, so the plan check (externalApiAccountAccess), rate limits, the shared credit reservation,
 * concurrency and cost guardrails, settlement and the receipt are the same code. What differs is only what a key
 * adds: its own credit cap and revocation, which a session does not have; the account's credits and the existing
 * limits are what bound it.
 *
 * Neither credential is ambient. The key is a Bearer header; the Desktop session is a Bearer Code token verified
 * against its live family (requireDesktopCodeBearer), and a request that also carries a cookie is refused, never resolved
 * from it. That is the condition the coding routes' exemption from the mutation-origin check rests on
 * (lib/requestOrigin.ts, tests/externalApiBoundary.test.mjs).
 */
export type ExternalApiCaller =
    | (AuthenticatedExternalApiKey & { source: "api_key" })
    | { source: "desktop_session"; userId: string; keyId: null; keyPrefix: null; creditCap: null; familyId: string };

/** Where a request's receipt and Idempotency-Key live: under its key, or under the account's Desktop session. */
export type ExternalApiReceiptOwner = { keyId: string } | { desktopUserId: string };

export const receiptOwner = (caller: ExternalApiCaller): ExternalApiReceiptOwner =>
    caller.source === "api_key" ? { keyId: caller.keyId } : { desktopUserId: caller.userId };

/**
 * What the admission transaction re-reads under the credit lock before it binds the reservation: the key (revoked,
 * expired, its cap), or the Desktop session's family (signed out or ended since the request was authenticated).
 */
export type ExternalApiAdmissionCredential = { keyId: string } | { desktopUserId: string; desktopFamilyId: string };

export const admissionCredential = (caller: ExternalApiCaller): ExternalApiAdmissionCredential =>
    caller.source === "api_key" ? { keyId: caller.keyId } : { desktopUserId: caller.userId, desktopFamilyId: caller.familyId };

/** The scope Smart Adaptive keeps its in-memory state under: a key's id, or a value no key id can take. */
export const callerScope = (caller: ExternalApiCaller) =>
    caller.source === "api_key" ? caller.keyId : `desktop-session:${caller.userId}`;

/** Whether this request asks to be read as a Desktop session: the Desktop origin, on an enrolled path, with the switch on. */
export const desktopSessionRequest = (request: Request) =>
    request.headers.get("origin") === DESKTOP_APP_ORIGIN &&
    desktopCodeSessionRoute(new URL(request.url).pathname, request.method);

const refused = () =>
    new ExternalApiKeyError(401, "invalid_desktop_session", "A valid Tomverse Desktop session is required. Sign in to Tomverse Desktop again.");

/**
 * The caller of one request. A request that is not a Desktop session request is a key request exactly as before; a
 * Desktop session request never falls back to a key or a cookie: an invalid, expired or revoked session is a 401.
 */
export const authenticateExternalApiCaller = async (request: Request): Promise<ExternalApiCaller> => {
    if (!desktopSessionRequest(request)) {
        return { ...(await authenticateExternalApiKey(request.headers.get("authorization"))), source: "api_key" };
    }
    if (request.headers.has("cookie")) throw refused();
    const result = await requireDesktopCodeBearer(request);
    if (!result.ok) {
        await result.response.body?.cancel().catch(() => undefined);
        throw refused();
    }
    return { source: "desktop_session", userId: result.identity.userId, keyId: null, keyPrefix: null, creditCap: null,
        familyId: result.identity.familyId };
};
