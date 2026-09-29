"use client";

/**
 * The tab's side of the sign-up consent choice (S4).
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 5.2 --
 * `attemptId` lives in tab-scoped `sessionStorage`, never a cookie. The server
 * keeps only the nonce's hash, so what is stored here is what proves the choice
 * is this tab's.
 *
 * Every failure here is swallowed: the choice is optional, and sign-in must go
 * on whether or not it could be stored (section 5.2: "소비 실패·만료·탭 닫힘에도
 * 계정 생성은 성공").
 */

const STORAGE_KEY = "tomverse.signupConsent.v1";
/**
 * The query parameter this tab's own sign-in lands with. The finalizer acts
 * only on a landing that carries the stored attempt's id: a session that
 * appeared some other way -- another tab, another person in the same browser --
 * is not the sign-in this choice was made for, and does not consume it.
 */
export const SIGNUP_CONSENT_MARKER_PARAM = "signupConsent";
const ESTIMATE_KEY = "tomverse.jurisdictionEstimate.v1";

type StoredAttempt = { attemptId: string; nonce: string };

const readStored = (): StoredAttempt | null => {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAttempt>;
    return typeof parsed.attemptId === "string" && typeof parsed.nonce === "string"
      ? { attemptId: parsed.attemptId, nonce: parsed.nonce }
      : null;
  } catch {
    return null;
  }
};

const forget = () => {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: nothing to forget.
  }
};

/**
 * `callbackUrl` with this attempt's marker added, so the landing of this
 * sign-in -- and only it -- finalizes the choice. Unchanged when nothing is
 * stored.
 */
export function withSignupConsentMarker(callbackUrl: string, attemptId: string | null): string {
  if (!attemptId) return callbackUrl;
  try {
    const url = new URL(callbackUrl, window.location.origin);
    if (url.origin !== window.location.origin) return callbackUrl;
    url.searchParams.set(SIGNUP_CONSENT_MARKER_PARAM, attemptId);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return callbackUrl;
  }
}

/**
 * Stores the choice made on the screen, replacing this tab's previous one, and
 * returns the attempt's id for the sign-in's callback. Bounded by a timeout so
 * a slow request cannot hold up sign-in.
 */
export async function storeSignupConsentChoice(input: {
  channel: "oauth" | "email_code";
  provider?: string;
  email?: string;
  expressOptInRequested: boolean;
  objected: boolean;
  language: string;
}): Promise<string | null> {
  const previous = readStored();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch("/api/auth/signup-consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: input.channel,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.email ? { email: input.email } : {}),
        expressOptInRequested: input.expressOptInRequested,
        objected: input.objected,
        language: input.language,
        ...(previous ? { supersede: previous } : {}),
      }),
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => null)) as
      | { ok?: boolean; attemptId?: string; nonce?: string }
      | null;
    if (response.ok && data?.ok && data.attemptId && data.nonce) {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ attemptId: data.attemptId, nonce: data.nonce })
      );
      return data.attemptId;
    }
    return null;
  } catch {
    // Optional by design; sign-in continues.
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * After this tab's own sign-in lands: hands the stored choice to the server,
 * and forgets it once the answer is final. Only a landing whose URL carries the
 * stored attempt's marker counts. The server decides whether this account may
 * consume it; an existing account's sign-in never does.
 */
export async function finalizeStoredSignupConsent(): Promise<void> {
  const stored = readStored();
  if (!stored) return;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  if (url.searchParams.get(SIGNUP_CONSENT_MARKER_PARAM) !== stored.attemptId) return;
  // The marker is spent whatever happens next: a reload must not look like a
  // fresh landing, and the address bar should not carry it.
  url.searchParams.delete(SIGNUP_CONSENT_MARKER_PARAM);
  try {
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // The URL keeps the marker; the stored choice still decides.
  }
  // 200 is a final answer: consumed, or refused for good. Anything else -- the
  // confirmation lane briefly gone (503), a rate limit, a server error, the
  // network -- rolled back and left the attempt pending, so it is tried again
  // a few times from this landing, which is the only one that may consume it.
  // After that the choice is dropped and the attempt expires on its own; the
  // account exists either way (section 5.2).
  for (const delayMs of FINALIZE_RETRY_DELAYS_MS) {
    if (delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    try {
      const response = await fetch("/api/auth/signup-consent/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stored),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 200) break;
    } catch {
      // Nothing reached the server; try again.
    }
  }
  forget();
}

const FINALIZE_RETRY_DELAYS_MS = [0, 2_000, 8_000];

/** Once per tab session: record the IP-estimated country if none is recorded. */
export async function recordJurisdictionEstimateOnce(): Promise<void> {
  try {
    if (window.sessionStorage.getItem(ESTIMATE_KEY)) return;
    window.sessionStorage.setItem(ESTIMATE_KEY, "1");
  } catch {
    return;
  }
  try {
    const response = await fetch("/api/user/jurisdiction-estimate", { method: "POST" });
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // Best effort; the next session tries again.
  }
}
