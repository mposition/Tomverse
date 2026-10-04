"use client";

import { CURRENT_CONSENT_COPY_VERSION } from "@/lib/emailConsentCopy";

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

/**
 * One slot per channel. An OAuth click on the code step must not replace the
 * email attempt the code in the inbox is bound to; if the OAuth round trip is
 * abandoned, the code still finds its attempt.
 */
const STORAGE_KEY = "tomverse.signupConsent.v2";
/**
 * The query parameter this tab's own sign-in lands with. The finalizer acts
 * only on a landing that carries the stored attempt's id: a session that
 * appeared some other way -- another tab, another person in the same browser --
 * is not the sign-in this choice was made for, and does not consume it.
 */
export const SIGNUP_CONSENT_MARKER_PARAM = "signupConsent";
const ESTIMATE_KEY = "tomverse.jurisdictionEstimate.v1";

type Channel = "oauth" | "email_code";

/**
 * What the tab keeps for one attempt: the proof (id and nonce) and the choice
 * it recorded, so a reload shows the choice that is actually stored rather
 * than the screen's unticked defaults.
 */
type StoredAttempt = {
  attemptId: string;
  nonce: string;
  expiresAt: number;
  optIn: boolean;
  objected: boolean;
  email?: string;
  /** The OAuth provider the attempt is bound to; another provider needs its own. */
  provider?: string;
  /** The language the screen showed, which names the notice wording recorded. */
  language?: string;
  /** The consent copy version the screen rendered. */
  copyVersion?: string;
};

/** The address as the server binds it (`normalizeEmailLoginAddress`). */
const boundAddress = (email: string | undefined) => email?.trim().toLowerCase();

type Slots = Partial<Record<Channel, StoredAttempt>>;

const isStoredAttempt = (value: unknown): value is StoredAttempt => {
  const entry = value as Partial<StoredAttempt> | null;
  return (
    !!entry &&
    typeof entry.attemptId === "string" &&
    typeof entry.nonce === "string" &&
    typeof entry.expiresAt === "number" &&
    typeof entry.optIn === "boolean" &&
    typeof entry.objected === "boolean"
  );
};

const readSlots = (): Slots => {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const slots: Slots = {};
    if (isStoredAttempt(parsed.oauth)) slots.oauth = parsed.oauth;
    if (isStoredAttempt(parsed.email_code)) slots.email_code = parsed.email_code;
    return slots;
  } catch {
    return {};
  }
};

const writeSlots = (slots: Slots) => {
  try {
    if (!slots.oauth && !slots.email_code) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(slots));
  } catch {
    // Storage blocked: the choice simply is not kept.
  }
};

const live = (entry: StoredAttempt | undefined, margin = 0): entry is StoredAttempt =>
  !!entry && entry.expiresAt - margin > Date.now();

/**
 * The choice this tab has stored and not yet used, for the screen to show
 * after a reload. The email attempt first: its code may already be in the inbox.
 */
export function readStoredSignupConsentChoice(): { optIn: boolean; objected: boolean } | null {
  const slots = readSlots();
  const entry = live(slots.email_code) ? slots.email_code : live(slots.oauth) ? slots.oauth : null;
  return entry ? { optIn: entry.optIn, objected: entry.objected } : null;
}

/**
 * The pending email attempt's id, for a sign-in link opened in this same tab
 * (`/auth/email/verify`), so its landing carries the marker too. A link opened
 * in another tab has no storage and consumes nothing.
 */
export function storedEmailAttemptId(): string | null {
  const entry = readSlots().email_code;
  return live(entry) ? entry.attemptId : null;
}

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
  const slots = readSlots();
  const previous = slots[input.channel];
  // The same choice for the same address, still well inside its life: keep the
  // pending attempt. Replacing it before a request that may fail would leave
  // the code already in the inbox bound to a superseded attempt.
  // Everything the attempt is bound to has to match: the choice, the
  // language whose wording it records, and the channel's own binding -- the
  // address for a code, the provider for OAuth.
  if (
    live(previous, 60_000) &&
    previous.optIn === input.expressOptInRequested &&
    previous.objected === input.objected &&
    previous.language === input.language &&
    previous.copyVersion === CURRENT_CONSENT_COPY_VERSION &&
    (input.channel === "email_code"
      ? previous.email === boundAddress(input.email)
      : previous.provider === input.provider)
  ) {
    return previous.attemptId;
  }
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
        ...(previous ? { supersede: { attemptId: previous.attemptId, nonce: previous.nonce } } : {}),
      }),
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => null)) as
      | { ok?: boolean; attemptId?: string; nonce?: string; expiresAt?: string }
      | null;
    if (response.ok && data?.ok && data.attemptId && data.nonce) {
      const expiresAt = data.expiresAt ? Date.parse(data.expiresAt) : Number.NaN;
      writeSlots({
        ...slots,
        [input.channel]: {
          attemptId: data.attemptId,
          nonce: data.nonce,
          expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 15 * 60_000,
          optIn: input.expressOptInRequested,
          objected: input.objected,
          ...(input.email ? { email: boundAddress(input.email) } : {}),
          ...(input.provider ? { provider: input.provider } : {}),
          language: input.language,
          copyVersion: CURRENT_CONSENT_COPY_VERSION,
        },
      });
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
 * The refusals that mean the person signed into an account that already
 * existed from the sign-up screen (docs/policy/email-product-news-redesign-draft.md
 * section 5.2a): the choice they ticked is not applied, and the landing says so
 * rather than dropping it without a word.
 */
const EXISTING_ACCOUNT_REFUSALS = new Set([
  "not_created_by_this_sign_in",
  "account_predates_attempt",
  "account_already_consumed",
]);

export type SignupConsentFinalizeOutcome = {
  /** The server answered `ok: true`: the sign-up recorded its own estimate. */
  consumed: boolean;
  /** Signed into an existing account from the sign-up screen: nothing applied. */
  existingAccount: boolean;
};

const NOTHING_FINALIZED: SignupConsentFinalizeOutcome = { consumed: false, existingAccount: false };

/**
 * After this tab's own sign-in lands: hands the stored choice to the server,
 * and forgets it once the answer is final. `consumed` is whether the server
 * answered `ok: true` -- which is when the sign-up recorded its own estimate;
 * a refusal or a rollback recorded nothing. Only a landing whose URL carries
 * the stored attempt's marker counts. The server decides whether this account
 * may consume it; an existing account's sign-in never does, and
 * `existingAccount` says that is what happened.
 */
export async function finalizeStoredSignupConsent(): Promise<SignupConsentFinalizeOutcome> {
  const slots = readSlots();
  if (!slots.oauth && !slots.email_code) return NOTHING_FINALIZED;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return NOTHING_FINALIZED;
  }
  const marker = url.searchParams.get(SIGNUP_CONSENT_MARKER_PARAM);
  const channel = (["oauth", "email_code"] as const).find(
    (key) => slots[key]?.attemptId === marker
  );
  const entry = channel ? slots[channel] : undefined;
  if (!channel || !entry) return NOTHING_FINALIZED;
  const stored = { attemptId: entry.attemptId, nonce: entry.nonce };
  // 200 is a final answer: consumed, or refused for good. Anything else -- the
  // confirmation lane briefly gone (503), a rate limit, a server error, the
  // network -- rolled back and left the attempt pending, so it is tried again
  // a few times from this landing, which is the only one that may consume it.
  // After that the choice is dropped and the attempt expires on its own; the
  // account exists either way (section 5.2).
  let consumed = false;
  // Whether the attempt itself is spent. A refusal about this account
  // (`binding_mismatch`, `account_predates_attempt`, `not_created_by_this_sign_in`)
  // leaves the attempt pending for the account it does belong to, so the tab
  // keeps it; only a consumed or dead attempt is dropped.
  let spent = false;
  let existingAccount = false;
  for (const delayMs of FINALIZE_RETRY_DELAYS_MS) {
    if (delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    try {
      const response = await fetch("/api/auth/signup-consent/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stored),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: unknown; reason?: unknown }
        | null;
      if (response.status === 200) {
        consumed = data?.ok === true;
        spent =
          consumed || data?.reason === "not_found" || data?.reason === "not_pending";
        existingAccount =
          typeof data?.reason === "string" && EXISTING_ACCOUNT_REFUSALS.has(data.reason);
        break;
      }
    } catch {
      // Nothing reached the server; try again.
    }
  }
  // Consumed: the account exists, and no other sign-up follows from this
  // tab's choice, so both slots go. Dead: only the slot the marker named.
  // Otherwise nothing is dropped.
  if (consumed) {
    writeSlots({});
    // The sign-up recorded its own estimate: this session's per-landing
    // estimate (for existing accounts) must not overwrite it on a later
    // full reload either.
    try {
      window.sessionStorage.setItem(ESTIMATE_KEY, "1");
    } catch {
      // Storage blocked: nothing to remember.
    }
  }
  else if (spent) writeSlots({ ...slots, [channel]: undefined });
  // Removed only now: a reload during the retries is still this landing, and
  // finds the attempt either consumed (a final answer) or still pending.
  url.searchParams.delete(SIGNUP_CONSENT_MARKER_PARAM);
  try {
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // The URL keeps the marker; with nothing stored, it does nothing.
  }
  return { consumed, existingAccount };
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

const AUTH_CALLBACK_KEY = "tomverse.auth.callbackUrl.v1";

/**
 * Remembers where this tab's sign-in was headed, for the sign-up screen a
 * provider sign-in with no account is sent to (section 5.2a). That redirect is
 * a fixed URL built on the server, so it carries no destination of its own.
 */
export function rememberAuthCallbackUrl(callbackUrl: string): void {
  try {
    window.sessionStorage.setItem(AUTH_CALLBACK_KEY, callbackUrl);
  } catch {
    // Storage blocked: the sign-up lands on the default page instead.
  }
}

/** The destination `rememberAuthCallbackUrl()` kept, if it is same-origin. */
export function readRememberedAuthCallbackUrl(): string | null {
  try {
    const value = window.sessionStorage.getItem(AUTH_CALLBACK_KEY);
    if (!value) return null;
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}

/**
 * Tells the server this click means to create an account with `provider`
 * (section 5.2a). Without it, a provider account with no account here is sent
 * back to the sign-up screen instead of created. Bounded like the choice store:
 * a slow request must not hold up the redirect, and a failed one only costs
 * the person that round trip.
 */
export async function declareSignupIntent(provider: "google" | "azure-ad"): Promise<void> {
  // A failed declaration costs a round trip: the provider sign-in comes back
  // to the sign-up screen, which asks again.
  await sendSignupIntent({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
}

/**
 * Withdraws any intent the sign-up screen set, before a sign-in screen
 * provider click: within its ten minutes it would otherwise turn that sign-in
 * into a new account. Returns whether the server confirmed it; the caller does
 * not go to the provider otherwise, since a surviving intent would do exactly
 * that.
 */
export async function withdrawSignupIntent(): Promise<boolean> {
  return sendSignupIntent({ method: "DELETE" });
}

async function sendSignupIntent(init: RequestInit): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch("/api/auth/signup-intent", { ...init, signal: controller.signal });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}
