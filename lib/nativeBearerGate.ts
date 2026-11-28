/**
 * The proxy-side half of N1b: whether a request's bearer token may stand in for
 * the mutation-origin check, and the header hygiene that has to happen first.
 *
 * Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
 * sections 5.1, 5.2, 5.4 and 5.5, approved 2026-08-31.
 *
 * ## What this decides, and what it emphatically does not
 *
 * A `yes` means the request is a cryptographically verified mobile bearer
 * request, so it does not depend on an ambient credential and CSRF has no
 * purchase on it. That is the *only* thing it means. Ownership, account state,
 * family revocation and credit are all decided again by the route, against the
 * same token (D2). The identity headers written below are a convenience for
 * logging and correlation and are not an authorization input -- the route reads
 * the `Authorization` header itself.
 *
 * ## Why the route list is a parameter
 *
 * `N1B_BEARER_ROUTES` ships empty by approval (decision 13), so on the deployed
 * configuration every verdict here is `not_applicable` and nothing about the
 * request changes. That is the intended state: native mutations keep meeting
 * the mutation-origin check and keep being refused until routes are converted
 * one at a time, each with evidence that its identity and ownership checks read
 * the bearer rather than the cookie session (D18).
 *
 * An empty list would also make this module untestable, which is how an empty
 * list becomes an untested one. So the list is injected, the tests register a
 * route of their own, and what ships is still empty.
 *
 * Pure: the verifier is a port. No crypto, no environment, no Prisma.
 */

/**
 * The namespace proxy owns and a client may never write into.
 *
 * `x-tomverse-pathname` and `x-tomverse-search` are deliberately outside it:
 * they are routing conveniences a route already treats as raw input, and
 * folding them into the auth namespace would blur what "the client cannot set
 * this" is protecting.
 */
export const INTERNAL_AUTH_HEADER_PREFIX = "x-tomverse-auth-";

export const MOBILE_IDENTITY_HEADERS = {
  subject: `${INTERNAL_AUTH_HEADER_PREFIX}subject`,
  device: `${INTERNAL_AUTH_HEADER_PREFIX}device`,
  family: `${INTERNAL_AUTH_HEADER_PREFIX}family`,
} as const;

/**
 * Removes every header in the internal auth namespace, and says which.
 *
 * Unconditional, and before any verification -- section 5.4 is explicit that
 * overwriting on success is not enough. A verdict of `reject` or
 * `not_applicable` writes nothing, so a client-supplied header would simply
 * survive; the deletion is what makes "the client cannot set this" true in
 * every branch rather than only the happy one.
 *
 * Returns the header *names* it removed. Never the values: a forged identity
 * header is attacker-controlled text, and the useful fact for an operator is
 * that somebody tried, not what they wrote.
 */
export const stripInternalAuthHeaders = (headers: Headers): string[] => {
  const removed: string[] = [];
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith(INTERNAL_AUTH_HEADER_PREFIX)) {
      removed.push(name.toLowerCase());
      headers.delete(name);
    }
  }
  return removed;
};

export type NativeBearerIdentity = {
  subject: string;
  device: string;
  family: string;
};

export type NativeBearerVerdict =
  /** The route is not registered for N1b. Nothing was verified and nothing changes. */
  | { kind: "not_applicable" }
  /** No bearer header. The request continues down the existing cookie path. */
  | { kind: "no" }
  /** A bearer was presented and is not usable. 401, and never a cookie fallback. */
  | { kind: "reject"; failure: string }
  /** Verified. The mutation-origin check is replaced for this request. */
  | { kind: "yes"; identity: NativeBearerIdentity };

export type NativeBearerVerifier = (token: string) =>
  | { ok: true; identity: { subject: string; device: string; family: string } }
  | { ok: false; failure: string };

/**
 * Section 5.2, from the outside in.
 *
 * The order matters here for a different reason than it does inside the token
 * verifier. There, later steps read attacker-written claims. Here, the early
 * exits are what keep the cost of N1b proportional: an unregistered route and a
 * request with no `Authorization` header never reach the verifier at all, so
 * document requests and every route that has not been converted pay nothing.
 */
export const nativeBearerVerdict = (input: {
  pathname: string;
  authorization: string | null;
  /** Exact paths, as approved. A prefix would enrol routes nobody registered. */
  registeredRoutes: readonly string[];
  verify: NativeBearerVerifier;
}): NativeBearerVerdict => {
  if (!input.registeredRoutes.includes(input.pathname)) {
    // Not "passed". Not verified at all -- the request goes on to meet
    // whatever it would have met without N1b, mutation-origin check included.
    return { kind: "not_applicable" };
  }

  const header = input.authorization;
  if (header === null || header.trim() === "") return { kind: "no" };

  const match = /^Bearer[ ]+([^\s]+)$/i.exec(header.trim());
  if (!match?.[1]) {
    // A header that is present and is not a bearer token. Refused rather than
    // ignored: falling through here would make "send a broken Authorization
    // header" a way to get the cookie path with the CSRF check still running,
    // and then the *next* edit makes it a way to get it without.
    return { kind: "reject", failure: "malformed_authorization" };
  }

  const verdict = input.verify(match[1]);
  if (!verdict.ok) return { kind: "reject", failure: verdict.failure };
  return { kind: "yes", identity: verdict.identity };
};

/** Writes the verified identity into the namespace stripped above. */
export const applyMobileIdentityHeaders = (
  headers: Headers,
  identity: NativeBearerIdentity
) => {
  headers.set(MOBILE_IDENTITY_HEADERS.subject, identity.subject);
  headers.set(MOBILE_IDENTITY_HEADERS.device, identity.device);
  headers.set(MOBILE_IDENTITY_HEADERS.family, identity.family);
};

/** Exact native Chat enrollment; callers supply the default-off deployment flag. */
export function nativeChatBearerRoute(path: string, method: string, enabled = false): boolean {
  if (!enabled) return false;
  if (process.env.MCP_CONNECTOR_PREVIEW_ENABLED === "true" && process.env.MCP_CONNECTOR_NATIVE_ENABLED === "true") {
    if (path === "/api/mcp/connections") return ["GET", "POST"].includes(method);
    if (/^\/api\/mcp\/connections\/[A-Za-z0-9_-]{1,100}$/.test(path)) return ["PATCH", "DELETE"].includes(method);
    if (/^\/api\/mcp\/invocations\/[A-Za-z0-9_-]{1,100}$/.test(path)) return method === "POST";
  }
  if (path === "/api/user/account") return ["GET", "DELETE"].includes(method);
  if (path === "/api/user/account/export") return ["GET", "POST"].includes(method);
  if (/^\/api\/user\/account\/export\/[A-Za-z0-9_-]{32,128}$/.test(path)) return method === "GET";
  if (/^\/api\/artifacts\/[A-Za-z0-9_-]{1,100}$/.test(path)) return method === "GET";
  if (path === "/api/chat") return ["POST", "PUT", "PATCH"].includes(method);
  if (path === "/api/chat/location-intent") return method === "POST";
  if (path === "/api/conversations") return method === "GET";
  if (path === "/api/products/chat/conversations") return method === "POST";
  if (path === "/api/products/chat/capabilities") return method === "GET";
  if (path === "/api/chat/voice-transcription") return method === "POST";
  if (path === "/api/chat/voice") return method === "POST";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}$/.test(path)) return ["GET", "PATCH"].includes(method);
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/messages$/.test(path)) return method === "POST";
  if (/^\/api\/products\/chat\/attempts\/[A-Za-z0-9_-]{1,100}$/.test(path)) return method === "GET";
  return false;
}

/** Exact workspace calls consumed by the bundled client; no deletion or sharing. */
export function nativeWorkspaceBearerRoute(path: string, method: string, enabled = false): boolean {
  if (!enabled) return false;
  if (path === "/api/assistant-profiles") return method === "POST";
  // This static subtree is the separate assistant-package import API.
  if (path === "/api/assistant-profiles/imports" || path.startsWith("/api/assistant-profiles/imports/")) return false;
  if (/^\/api\/assistant-profiles\/[A-Za-z0-9_-]{1,100}$/.test(path)) return ["GET", "PATCH"].includes(method);
  if (/^\/api\/assistant-profiles\/[A-Za-z0-9_-]{1,100}\/versions$/.test(path)) return method === "POST";
  if (/^\/api\/assistant-profiles\/[A-Za-z0-9_-]{1,100}\/knowledge$/.test(path)) return ["GET", "POST"].includes(method);
  if (path === "/api/imports/external") return method === "POST";
  if (path === "/api/imports/external/capacity") return method === "GET";
  // Split hints for a Perplexity file the iOS import sheet is opening:
  // excerpts in, counts out, nothing stored (lib/perplexitySplitHints.ts).
  if (path === "/api/imports/external/perplexity-split") return method === "POST";
  if (/^\/api\/imports\/external\/[A-Za-z0-9_-]{1,100}\/(batches|seal|finalize)$/.test(path)) return method === "POST";
  if (path === "/api/external-conversations") return method === "GET";
  if (/^\/api\/external-conversations\/[A-Za-z0-9_-]{1,100}$/.test(path)) return method === "GET";
  if (/^\/api\/external-conversations\/[A-Za-z0-9_-]{1,100}\/continuations$/.test(path)) return method === "POST";
  return false;
}

/**
 * The folder-era history calls (list, create, rename, delete) that parity has
 * always allowed. They stay open with the project workspace switch off.
 */
export function nativeHistoryFolderBearerRoute(path: string, method: string): boolean {
  if (path === "/api/projects") return ["GET", "POST"].includes(method);
  if (/^\/api\/projects\/[A-Za-z0-9_-]{1,100}$/.test(path)) return ["PATCH", "DELETE"].includes(method);
  return false;
}

/** Exact project workspace calls consumed by the bundled client. */
export function nativeProjectWorkspaceBearerRoute(path: string, method: string): boolean {
  const id = "[A-Za-z0-9_-]{1,100}";
  if (path === "/api/chat/context") return method === "POST";
  if (path === "/api/projects") return ["GET", "POST"].includes(method);
  if (new RegExp(`^/api/projects/${id}$`).test(path)) return ["GET", "PATCH", "DELETE"].includes(method);
  if (new RegExp(`^/api/projects/${id}/conversations$`).test(path)) return method === "GET";
  if (new RegExp(`^/api/projects/${id}/materials$`).test(path)) return ["GET", "POST"].includes(method);
  if (new RegExp(`^/api/projects/${id}/materials/from-source$`).test(path)) return method === "POST";
  if (new RegExp(`^/api/projects/${id}/materials/${id}$`).test(path)) return ["GET", "POST", "DELETE"].includes(method);
  if (new RegExp(`^/api/projects/${id}/memories$`).test(path)) return ["GET", "POST"].includes(method);
  if (new RegExp(`^/api/projects/${id}/memories/${id}$`).test(path)) return ["GET", "PATCH", "DELETE"].includes(method);
  if (new RegExp(`^/api/memories/${id}/scope$`).test(path)) return method === "POST";
  if (new RegExp(`^/api/projects/${id}/(?:search|sources)$`).test(path)) return method === "POST";
  if (new RegExp(`^/api/projects/receipts/${id}$`).test(path)) return method === "GET";
  return false;
}

/** Native web-parity additions require their own reviewed operational activation. */
export function nativeParityBearerRoute(path: string, method: string, enabled = false, workspaceEnabled = false): boolean {
  if (!enabled) return false;
  if (nativeWorkspaceBearerRoute(path, method, workspaceEnabled)) return true;
  if (process.env.RESEARCH_PREVIEW_NATIVE_ENABLED === "true") {
    if (path === "/api/chat/research-preview/offer" || path === "/api/chat/research-preview/runs") return method === "POST" || (path.endsWith("/runs") && method === "GET");
    if (/^\/api\/chat\/research-preview\/runs\/[A-Za-z0-9_-]{1,100}$/.test(path)) return method === "GET";
    if (/^\/api\/chat\/research-preview\/runs\/[A-Za-z0-9_-]{1,100}\/(?:resume|cancel)$/.test(path)) return method === "POST";
  }
  // Project workspace in the native app: its own default-off switch, so
  // enabling parity does not enable it. The context preparation route is here
  // too, because a native send prepares context only for a project
  // conversation; every other native Chat send is unchanged.
  if (process.env.TOMVERSE_NATIVE_PROJECT_WORKSPACE_ENABLED === "true" && nativeProjectWorkspaceBearerRoute(path, method)) return true;
  // Deep Research engine v2: owner-scoped run API, behind its own default-off Native switch.
  if (process.env.RESEARCH_ENGINE_ENABLED === "true" && process.env.RESEARCH_ENGINE_NATIVE_ENABLED === "true") {
    if (path === "/api/chat/research/offer") return method === "GET";
    if (path === "/api/chat/research/runs") return method === "GET" || method === "POST";
    if (/^\/api\/chat\/research\/runs\/[A-Za-z0-9_-]{1,100}$/.test(path)) return method === "GET" || method === "DELETE";
    if (/^\/api\/chat\/research\/runs\/[A-Za-z0-9_-]{1,100}\/(?:plan|plan-edit|approve|pause|resume|cancel|finish|budget|scope|revisions)$/.test(path)) return method === "POST";
    if (/^\/api\/chat\/research\/runs\/[A-Za-z0-9_-]{1,100}\/(?:sources|evidence|report|export)$/.test(path)) return method === "GET";
  }
  // Checkout itself restricts bearer requests to complimentary internal passes.
  if (path === "/api/billing/checkout") return method === "POST";
  if (path === "/api/user/usage") return method === "GET";
  if (path === "/api/conversations/search") return method === "GET";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/continuation$/.test(path)) return method === "GET";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/continuation\/review-handoff$/.test(path)) return method === "POST";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/continuation\/review-handoff\/draft$/.test(path)) return ["GET", "PUT", "DELETE"].includes(method);
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/messages\/receipt$/.test(path)) return method === "POST";
  if (path === "/api/projects") return ["GET", "POST"].includes(method);
  if (/^\/api\/projects\/[A-Za-z0-9_-]{1,100}$/.test(path)) return ["PATCH", "DELETE"].includes(method);
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}$/.test(path)) return method === "DELETE";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/pin$/.test(path)) return method === "PUT";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/share$/.test(path)) return ["POST", "DELETE"].includes(method);
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/export$/.test(path)) return method === "GET";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/verify$/.test(path)) return method === "POST";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/generate-title$/.test(path)) return method === "POST";
  if (path === "/api/chat/preflight") return method === "POST";
  if (path === "/api/chat/deep-research/status") return method === "POST";
  if (path === "/api/products/mobile/capabilities") return method === "GET";
  if (path === "/api/user/settings") return ["GET", "POST"].includes(method);
  if (path === "/api/memories/settings") return ["GET", "PUT"].includes(method);
  if (path === "/api/assistant-profiles") return method === "GET";
  // Reporting a problem with one answer (owner approval, 2026-10-24). The
  // route attributes the report only to an assistant message the caller owns.
  if (path === "/api/feedback") return method === "POST";
  if (path === "/api/products/review/conversations" || path === "/api/review/route") return method === "POST";
  if (path === "/api/images/generations") return ["GET", "POST"].includes(method);
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/generations$/.test(path)) return method === "GET";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/image-turn$/.test(path)) return method === "POST";
  // Whether a manual-mode send with a photo asks to edit it (owner request
  // 2026-10-29: photo edits in the native apps). Routing only; the image turn
  // above is what reserves and charges.
  if (path === "/api/chat/image-intent") return method === "POST";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/compare-summary$/.test(path)) return ["GET", "POST"].includes(method);
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/comparison-reviews$/.test(path)) return ["GET", "POST"].includes(method);
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/comparison-reviews\/verify-item$/.test(path)) return method === "POST";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/comparison-reviews\/item-feedback$/.test(path)) return ["GET", "PUT", "DELETE"].includes(method);
  if (/^\/api\/images\/groups\/[A-Za-z0-9_-]{1,100}$/.test(path)) return method === "GET";
  return false;
}

/**
 * The generated-file revision switch. Enabled by default; an explicit false
 * disables the connection, not downloads. `generatedArtifactRevisionCore`
 * re-exports it; it lives here because proxy.ts needs it and this file has no
 * imports.
 */
export const generatedArtifactRevisionEnabled = () =>
  (process.env.GENERATED_ARTIFACT_REVISION_ENABLED ?? "true") === "true";

/** Callers resolve the revision switch; Native enrollment still fails closed. */
export function nativeArtifactRevisionBearerRoute(path: string, method: string, enabled = false): boolean {
  if (!enabled) return false;
  if (path === "/api/chat") return method === "DELETE";
  return method === "GET" && /^\/api\/artifacts\/[A-Za-z0-9_-]{1,64}\/versions$/.test(path);
}

// Desktop enrollment is shared by the proxy and route-level bearer checks.
export const DESKTOP_APP_ORIGIN = "tomverse://desktop";
export const DESKTOP_CHAT_CREATE = "/api/products/chat/conversations";
export const DESKTOP_CHAT_TURN = "/api/chat";
export const DESKTOP_DEEP_RESEARCH_STATUS = "/api/chat/deep-research/status";
export const DESKTOP_VOICE_CONVERSATION = "/api/chat/voice";
export const DESKTOP_VOICE_TRANSCRIPTION = "/api/chat/voice-transcription";
export const DESKTOP_CHAT_CONTEXT = "/api/chat/context";
export const DESKTOP_REVIEW_CREATE = "/api/products/review/conversations";
export const DESKTOP_REVIEW_ROUTING = "/api/review/route";
export const DESKTOP_REVIEW_PREFLIGHT = "/api/chat/preflight";
export const DESKTOP_IMAGE_GENERATIONS = "/api/images/generations";
/**
 * Remote control (docs/ops/desktop-remote-control.md): the PC reports its running tasks and picks up remote answers.
 * Enrolled whenever Desktop authentication is on, so the bearer is verified and the route itself answers "not
 * available" while `TOMVERSE_DESKTOP_REMOTE_CONTROL_ENABLED` is off.
 */
export const DESKTOP_REMOTE_SYNC = "/api/desktop/remote/sync";

export function desktopRemoteControlEnabled() {
  return process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" && process.env.TOMVERSE_DESKTOP_REMOTE_CONTROL_ENABLED === "true";
}

/**
 * Remote control's preview of file changes: the PC may report line counts, and a few redacted changed lines when the
 * person turned that on at the PC. Off by default; while it is off the sync route removes those fields from a report.
 */
export function desktopRemotePreviewEnabled() {
  return desktopRemoteControlEnabled() && process.env.TOMVERSE_DESKTOP_REMOTE_PREVIEW_ENABLED === "true";
}

/**
 * A Code task run by the person's own Codex or Claude Code on their computer. The run touches no server route (it uses no
 * Tomverse coding API and no credits), so this only tells a Desktop build that it may offer the route. Off by default.
 */
export function desktopProviderCliExecEnabled() {
  return process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" && process.env.TOMVERSE_DESKTOP_PROVIDER_CLI_EXEC_ENABLED === "true";
}

/**
 * Passkey confirmation of remote approvals (docs/ops/desktop-remote-control.md). Off by default, and only meaningful
 * while remote control itself is on. While it is off nobody is asked for a passkey and none can be registered; the
 * passkeys already registered stay where they are.
 */
export function desktopRemotePasskeyEnabled() {
  return desktopRemoteControlEnabled() && process.env.TOMVERSE_DESKTOP_REMOTE_PASSKEY_ENABLED === "true";
}

export const DESKTOP_CHAT_CAPABILITIES = "/api/products/chat/capabilities";
export const DESKTOP_CHAT_HISTORY = "/api/conversations";
/** The Plugins page's platform catalogue (static, no account data). Desktop reads it while the Desktop plugins switch is on. */
export const DESKTOP_PLUGIN_CATALOG = "/api/mcp/providers";
export const DESKTOP_CHAT_SEARCH = "/api/conversations/search";

/**
 * Desktop Code on the signed-in Desktop session instead of an API key (owner decision 2026-11-27,
 * docs/policy/external-api.md section 11.2). Default off. While it is on, exactly the coding API calls the bundled
 * agent engine makes (apps/tomverse-cli/src/gateway.ts) take the Desktop bearer from the Desktop origin; the route
 * turns it into the same account caller a key becomes (lib/externalApiCaller.ts), so the plan check, rate limits,
 * credits, concurrency and receipts are the key path's own. Tools outside Desktop keep using API keys, and so do the
 * coding API's other addresses (Responses, Anthropic Messages).
 */
export function desktopCodeSessionEnabled() {
  return process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" && process.env.TOMVERSE_DESKTOP_CODE_SESSION_ENABLED === "true";
}

export const DESKTOP_CODE_SESSION_READS: readonly string[] = ["/api/code/v1/models", "/api/code/v1/usage", "/api/code/v1/requests/status"];
/**
 * The route-only choice (docs/policy/external-api.md section 5.3, lib/externalApiRouteOnlyCore.ts): enrolled for the
 * Desktop session only while its own switch is on, so with the switch off the route is not even reachable by a session.
 */
const DESKTOP_ROUTE_ONLY_PATH = "/api/code/v1/route";
export const DESKTOP_CODE_SESSION_WRITES: readonly string[] = ["/api/code/v1/chat/completions", "/api/code/v1/web-search", DESKTOP_ROUTE_ONLY_PATH];

/** Whether this exact method and path is a coding API call a Desktop session may make now. */
export function desktopCodeSessionRoute(path: string, method: string): boolean {
  if (!desktopCodeSessionEnabled()) return false;
  if (DESKTOP_CODE_SESSION_READS.includes(path)) return method === "GET";
  if (path === DESKTOP_ROUTE_ONLY_PATH && process.env.EXTERNAL_API_ROUTE_ONLY_ENABLED !== "true") return false;
  if (DESKTOP_CODE_SESSION_WRITES.includes(path)) return method === "POST";
  return false;
}

const ownResourceRead = /^\/api\/(?:conversations|artifacts)\/[A-Za-z0-9_-]{1,128}$/;

export function desktopReadApiRoute(path: string, method: string): boolean {
  if (method === "GET" && desktopCodeSessionRoute(path, method)) return true;
  return method === "GET" && (path === DESKTOP_CHAT_CAPABILITIES || path === DESKTOP_CHAT_HISTORY ||
    path === DESKTOP_CHAT_SEARCH || ownResourceRead.test(path) ||
    (path === DESKTOP_PLUGIN_CATALOG && desktopPluginsEnabled()) ||
    /^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/continuation$/.test(path) ||
    (desktopReviewWriteEnabled() && (path === DESKTOP_IMAGE_GENERATIONS ||
      /^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/generations$/.test(path) ||
      /^\/api\/images\/(?:groups\/[A-Za-z0-9_-]{1,100}|generations\/[A-Za-z0-9_-]{1,100}\/download)$/.test(path))));
}

function desktopChatWriteRoute(path: string, method: string): boolean {
  if (path === DESKTOP_CHAT_CREATE || path === DESKTOP_CHAT_TURN) return method === "POST";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/messages$/.test(path)) return method === "POST";
  if (["/api/conversations/search", "/api/conversations/export-all", "/api/conversations/import-guest"].includes(path)) return false;
  return (method === "PATCH" || method === "DELETE") && /^\/api\/conversations\/[A-Za-z0-9_-]{1,100}$/.test(path);
}

export function desktopChatWriteEnabled() {
  return process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" && process.env.TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED === "true";
}

export function desktopReviewWriteEnabled() {
  return process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" && process.env.TOMVERSE_DESKTOP_REVIEW_ENABLED === "true";
}

/**
 * Desktop's use of the two voice routes: dictation, and the Chat voice conversation. Enrollment only. Each route
 * keeps its own switch, budget and credit code (feature.voiceInputEnabled; VOICE_CONVERSATION_ENABLED and its key),
 * and the conversation route still refuses a Review or a locked conversation.
 */
export function desktopVoiceEnabled() {
  return desktopChatWriteEnabled() && process.env.TOMVERSE_DESKTOP_VOICE_ENABLED === "true";
}

export function desktopReviewAnalysisEnabled() {
  return desktopReviewWriteEnabled() && process.env.TOMVERSE_DESKTOP_REVIEW_ANALYSIS_ENABLED === "true";
}

export function desktopComposerToolsEnabled() {
  return desktopChatWriteEnabled() && process.env.TOMVERSE_DESKTOP_COMPOSER_TOOLS_ENABLED === "true";
}

export function desktopAttachmentEnabled() {
  return (desktopChatWriteEnabled() || desktopReviewWriteEnabled()) && process.env.TOMVERSE_DESKTOP_ATTACHMENTS_ENABLED === "true";
}

export function desktopDriveEnabled() {
  return desktopAttachmentEnabled() && process.env.TOMVERSE_DESKTOP_GOOGLE_DRIVE_ENABLED === "true";
}

export function desktopDeepResearchEnabled() {
  return desktopChatWriteEnabled() && process.env.TOMVERSE_DESKTOP_DEEP_RESEARCH_ENABLED === "true";
}

/**
 * Deep Research from a Desktop Review: one Deep Research answer is a column of the Review, put to that model alone.
 * Its own switch, default off, on top of the Review writes: the paid run is a separate decision from Chat's.
 */
export function desktopReviewDeepResearchEnabled() {
  return desktopReviewWriteEnabled() && process.env.TOMVERSE_DESKTOP_REVIEW_DEEP_RESEARCH_ENABLED === "true";
}

/**
 * Desktop's in-app plan and payment screens. A display switch only: Desktop
 * calls the same billing routes as the web through the account settings
 * session, so it stays off unless that session is enabled too.
 */
export function desktopBillingEnabled() {
  return process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" &&
    process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED === "true" &&
    process.env.TOMVERSE_DESKTOP_BILLING_ENABLED === "true";
}

/**
 * Desktop's in-app connector management and Chat connector use. A display
 * switch only: Desktop calls the same /api/mcp routes as the web through the
 * account settings session, and the connector preview switch still decides
 * whether those routes offer anything.
 */
export function desktopPluginsEnabled() {
  return process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" &&
    process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED === "true" &&
    process.env.TOMVERSE_DESKTOP_PLUGINS_ENABLED === "true";
}

/**
 * A chosen plugin in a Review, as in Chat: each model of the Review may use the connection's tools, and every action
 * that would change something outside Tomverse still waits for the person's approval. Off unless its own switch is on.
 */
export function desktopReviewPluginEnabled() {
  return desktopPluginsEnabled() && process.env.TOMVERSE_DESKTOP_REVIEW_PLUGIN_ENABLED === "true";
}

/**
 * Desktop's plugins from a zip file, an address of a zip file, an npm package or a private GitHub repository, and the marketplace
 * Desktop carries. It touches no route: these downloads run on the person's own computer after the person confirms each one, so this
 * is only the kill switch Desktop reads as the `desktopPluginSources` capability. It needs the Desktop session, not the connector
 * preview, because local plugins do not use the connector routes.
 */
export function desktopPluginSourcesEnabled() {
  return process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" &&
    process.env.TOMVERSE_DESKTOP_PLUGIN_SOURCES_ENABLED === "true";
}

const DESKTOP_CHAT_TURN_FIELDS: ReadonlySet<string> = new Set(["messages", "modelId", "conversationId", "assistantMessageId",
  "sourceUserMessageId", "reasoningEffort", "webSearchMode", "admissionToken", "contextBundle", "deepResearchDepth", "currentLocation"]);

/**
 * Whether the body of a Desktop turn may carry this field. The device position is the person's own choice for each
 * message ("Current location"), as on the web. A chosen plugin needs the plugins switch; the route keeps it to Chat.
 */
export function desktopChatTurnField(key: string): boolean {
  return DESKTOP_CHAT_TURN_FIELDS.has(key) || (key === "mcpConnectionId" && desktopPluginsEnabled()) || (key === "promptRefinerDecision" && desktopPromptRefinerEnabled());
}

export function desktopWriteApiRoute(path: string, method: string): boolean {
  if (method === "POST" && desktopCodeSessionRoute(path, method)) return true;
  if (path === DESKTOP_REMOTE_SYNC) return (method === "POST" || method === "DELETE") && process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true";
  if (path === DESKTOP_DEEP_RESEARCH_STATUS) return method === "POST" && (desktopDeepResearchEnabled() || desktopReviewDeepResearchEnabled());
  if (path === DESKTOP_CHAT_CONTEXT) return method === "POST" && (desktopChatWriteEnabled() || desktopReviewWriteEnabled());
  if (path === DESKTOP_VOICE_CONVERSATION || path === DESKTOP_VOICE_TRANSCRIPTION) return method === "POST" && desktopVoiceEnabled();
  if (path === DESKTOP_CHAT_TURN && ["PUT", "PATCH", "DELETE"].includes(method) && desktopAttachmentEnabled()) return true;
  if (desktopChatWriteEnabled() && desktopChatWriteRoute(path, method)) return true;
  if (!desktopReviewWriteEnabled()) return false;
  if (desktopReviewAnalysisEnabled() && /^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/comparison-reviews$/.test(path)) {
    return method === "GET" || method === "POST";
  }
  if (path === DESKTOP_CHAT_CREATE || method === "DELETE") return false;
  return desktopChatWriteRoute(path, method) || (method === "POST" &&
    [DESKTOP_REVIEW_CREATE, DESKTOP_REVIEW_ROUTING, DESKTOP_REVIEW_PREFLIGHT, DESKTOP_IMAGE_GENERATIONS].includes(path));
}

/**
 * Desktop's use of the Prompt Refiner, Chat only. Enrollment: a Desktop turn may carry the server-held decision the
 * Auto send preparation returned. The release authority, kill switch, budget and one-time consume stay the
 * server's own (lib/promptRefinerChatExecutionStore.ts); this switch does not widen any of them. Desktop prepares
 * the draft and the scope through the account settings session, so that session has to be enabled too.
 */
export function desktopPromptRefinerEnabled() {
  return desktopChatWriteEnabled() && process.env.TOMVERSE_DESKTOP_ACCOUNT_SETTINGS_ENABLED === "true" &&
    process.env.TOMVERSE_DESKTOP_PROMPT_REFINER_ENABLED === "true";
}
