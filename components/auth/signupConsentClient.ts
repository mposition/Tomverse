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
 * Stores the choice made on the screen, replacing this tab's previous one.
 * Bounded by a timeout so a slow request cannot hold up sign-in.
 */
export async function storeSignupConsentChoice(input: {
  channel: "oauth" | "email_code";
  provider?: string;
  email?: string;
  expressOptInRequested: boolean;
  objected: boolean;
  language: string;
}): Promise<void> {
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
    }
  } catch {
    // Optional by design; sign-in continues.
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * After sign-in: hands the stored choice to the server once, then forgets it.
 * The server decides whether this account may consume it; an existing
 * account's sign-in never does.
 */
export async function finalizeStoredSignupConsent(): Promise<void> {
  const stored = readStored();
  if (!stored) return;
  try {
    const response = await fetch("/api/auth/signup-consent/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stored),
    });
    // Any answer is final for this tab: consumed, refused or disabled. Only a
    // network failure keeps the choice for the next page.
    await response.body?.cancel().catch(() => undefined);
    forget();
  } catch {
    // Kept for the next page load, until it expires server-side.
  }
}

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
