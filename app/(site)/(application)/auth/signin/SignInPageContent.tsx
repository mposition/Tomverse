"use client";

import { signIn, useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { useTurnstile } from "@/components/chat/useTurnstile";
import Link from "next/link";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { withChatLanguage } from "@/lib/localizedCallbackUrl";
import {
    ACCOUNT_SWITCH_REASON,
    isAdminReauthenticationSignInReason,
} from "@/lib/adminReauthenticationCore";
import { isValidLoginEmail } from "@/lib/emailValidation";
import { useAuthConsentSlotRef } from "@/components/analytics/AnalyticsProvider";
import {
    markSignupStarted,
    trackProductEvent,
} from "@/lib/productAnalyticsClient";

const PROVIDER_ERROR_KEYS: Record<string, string> = {
    OAuthAccountNotLinked: "auth.errorAccountNotLinked",
    AccessDenied: "auth.errorAccessDenied",
    AccountPendingDeletion: "auth.errorAccountPendingDeletion",
};

// Maps the specific failure the server reports (lib/emailLogin.ts's
// EmailLoginError codes, plus the shared ApiSecurityError "INVALID_REQUEST"
// for a malformed payload) to actionable copy instead of one generic
// "couldn't send the code" message that covers rate limits, CAPTCHA
// failures, format errors, and outages alike.
const emailLoginErrorMessage = (
    t: (key: string) => string,
    status: number,
    code: string | undefined,
    retryAfterSeconds: number | null
): string => {
    switch (code) {
        case "RATE_LIMITED_MINUTE":
            return t("auth.emailLoginRateLimitedMinute").replace(
                "{seconds}",
                String(retryAfterSeconds ?? 60)
            );
        case "RATE_LIMITED_DAY":
            return t("auth.emailLoginRateLimitedDay");
        case "TURNSTILE_FAILED":
            return t("auth.emailLoginTurnstileFailed");
        case "TURNSTILE_UNAVAILABLE":
            return t("auth.emailLoginTurnstileUnavailable");
        case "SEND_FAILED":
            // Distinct from the generic 5xx copy: the request was accepted and
            // the code was minted, only the mail did not go out. Telling
            // someone to check their inbox here would be false, and telling
            // them to check their address would send them looking for a
            // mistake they did not make.
            return t("auth.emailLoginSendFailed");
        case "INVALID_REQUEST":
            return t("auth.emailLoginInvalidFormat");
        default:
            return status >= 500
                ? t("auth.emailLoginInternalError")
                : t("auth.emailLoginRequestFailed");
    }
};

function SignInButtons() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const { status } = useSession();
    const { t, lang } = useLanguage();
    const callbackUrl = withChatLanguage(searchParams.get("callbackUrl"), lang);
    // Both administrator windows land here: an expired console session and an
    // expired high-risk step-up window. The notice is the same either way --
    // the previous session was ended on purpose and signing in again is what
    // continues -- but the step-up reason has to be recognised too, or the
    // operator arriving from a refused save is shown a bare sign-in page and a
    // provider error box.
    const adminReauthentication = isAdminReauthenticationSignInReason(
        searchParams.get("reason")
    );
    // The visitor deliberately ended the previous session to use a different
    // account. Whoever was signed in with the identity provider is still signed
    // in *there*, so without this the next click would silently hand back the
    // same account -- on a shared computer, someone else's.
    const accountSwitch = searchParams.get("reason") === ACCOUNT_SWITCH_REASON;
    // Only for that entry: an ordinary sign-in keeps going straight through
    // with the provider's existing session, which is the whole point of it.
    // Nothing is done to the provider's own session either way; forcing the
    // chooser is a request for this one authorization, not a global sign-out.
    const oauthAuthorizationParams = accountSwitch
        ? { prompt: "select_account" }
        : undefined;
    const providerError = searchParams.get("error");
    const pageViewTrackedRef = useRef(false);
    const emailInputRef = useRef<HTMLInputElement | null>(null);
    const codeInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (status === "authenticated") {
            router.replace(callbackUrl);
        }
    }, [callbackUrl, router, status]);

    const [step, setStep] = useState<"email" | "code">("email");
    const [email, setEmail] = useState("");
    const [code, setCode] = useState("");
    const [isSendingCode, setIsSendingCode] = useState(false);
    const [isVerifyingCode, setIsVerifyingCode] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [emailError, setEmailError] = useState<string | null>(null);
    const isEmailValid = isValidLoginEmail(email);
    const [needsTurnstile, setNeedsTurnstile] = useState(false);
    const { containerRef: turnstileContainerRef, getToken: getTurnstileToken } =
        useTurnstile(true, "email_login_request");

    // Drives the "N초 후 다시 시도" countdown on a minute-scoped rate limit:
    // retryAfterUntil is the fixed deadline from the server's Retry-After
    // header, retryCountdown is the live seconds-remaining derived from it.
    // Re-deriving from the deadline each tick (rather than decrementing a
    // counter directly) keeps the display correct even if a tab was
    // backgrounded and missed ticks.
    const [retryAfterUntil, setRetryAfterUntil] = useState<number | null>(null);
    const [retryCountdown, setRetryCountdown] = useState(0);
    // Only the minute-scoped rate limit gets a live per-second message
    // ("45초 후..."); a day-scoped limit still disables the button for the
    // same duration (via retryCountdown) but shows a static message instead
    // of a countdown that would otherwise read out tens of thousands of
    // seconds.
    const [isMinuteRateLimited, setIsMinuteRateLimited] = useState(false);

    useEffect(() => {
        if (step !== "code") return;
        const frame = requestAnimationFrame(() => codeInputRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, [step]);

    useEffect(() => {
        if (!retryAfterUntil) return;
        const tick = () => {
            const remaining = Math.max(0, Math.ceil((retryAfterUntil - Date.now()) / 1000));
            setRetryCountdown(remaining);
            if (remaining <= 0) {
                setRetryAfterUntil(null);
                if (isMinuteRateLimited) {
                    setIsMinuteRateLimited(false);
                    setFormError(null);
                }
            }
        };
        tick();
        const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [retryAfterUntil]);

    useEffect(() => {
        if (pageViewTrackedRef.current) return;
        pageViewTrackedRef.current = true;
        trackProductEvent("signup_page_view");
    }, []);

    const providerButtonClass =
        "flex w-full items-center justify-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm font-semibold text-zinc-900 shadow-sm transition-all hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-100 dark:disabled:hover:bg-white";

    const requestCode = (turnstileToken?: string) =>
        fetch("/api/auth/email-login/request", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: email.trim(), turnstileToken }),
        });

    const handleSendCode = async () => {
        if (isSendingCode || retryCountdown > 0) return;
        if (!isEmailValid) {
            setEmailError(t("auth.emailLoginInvalidFormat"));
            return;
        }
        setEmailError(null);
        setIsSendingCode(true);
        setFormError(null);
        setIsMinuteRateLimited(false);
        try {
            let response = await requestCode();
            let data: { code?: string } | null = null;
            if (response.status === 403) {
                data = await response.json().catch(() => null);
                if (data?.code === "TURNSTILE_REQUIRED") {
                    setNeedsTurnstile(true);
                    const token = await getTurnstileToken();
                    response = await requestCode(token);
                    data = null;
                }
            }
            if (!response.ok) {
                if (!data) data = await response.json().catch(() => null);
                const retryAfterHeader = Number(response.headers.get("Retry-After"));
                const retryAfterSeconds =
                    Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
                        ? retryAfterHeader
                        : null;
                setIsMinuteRateLimited(data?.code === "RATE_LIMITED_MINUTE");
                if (retryAfterSeconds) {
                    setRetryAfterUntil(Date.now() + retryAfterSeconds * 1_000);
                }
                setFormError(
                    emailLoginErrorMessage(t, response.status, data?.code, retryAfterSeconds)
                );
                return;
            }
            // The success path reads nothing out of the body -- the next step
            // is a screen change -- so it is drained rather than abandoned.
            // Every refusal above already reads it; this was the one path that
            // did not, and an unread body holds the request open for the life
            // of the page (see lib/apiCacheControlPolicy.ts).
            await discardResponseBody(response);
            markSignupStarted("email-code");
            setStep("code");
        } catch {
            setFormError(t("auth.emailLoginRequestFailed"));
        } finally {
            setIsSendingCode(false);
        }
    };

    const handleVerifyCode = async () => {
        if (isVerifyingCode || code.trim().length !== 6) return;
        setIsVerifyingCode(true);
        setFormError(null);
        try {
            const result = await signIn("email-code", {
                redirect: false,
                email: email.trim(),
                code: code.trim(),
                callbackUrl,
            });
            // next-auth v4 collapses every authorize() rejection into the
            // generic "CredentialsSignin" code, so a specific "locked" vs
            // "invalid" distinction can't reach the client here -- show one
            // generic message and let the user request a fresh code.
            if (result?.error) {
                setFormError(t("auth.emailLoginInvalidCode"));
                return;
            }
            window.location.href = result?.url || callbackUrl;
        } catch {
            setFormError(t("auth.emailLoginInvalidCode"));
        } finally {
            setIsVerifyingCode(false);
        }
    };

    // While a minute-scoped rate limit is counting down, show the live
    // remaining seconds instead of the frozen number from when the error
    // first arrived.
    const displayedFormError =
        isMinuteRateLimited && retryCountdown > 0
            ? t("auth.emailLoginRateLimitedMinute").replace("{seconds}", String(retryCountdown))
            : formError;

    if (status === "authenticated" || status === "loading") {
        return (
            <div className="mt-8 text-center text-sm text-zinc-400 dark:text-zinc-500">
                {t("auth.loading")}
            </div>
        );
    }

    return (
        <div className="mt-8 space-y-4">
            {adminReauthentication ? (
                <div
                    role="status"
                    data-testid="signin-admin-reauthentication-notice"
                    className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900 dark:border-blue-500/30 dark:bg-blue-950/30 dark:text-blue-100"
                >
                    Your previous administrator session was ended. Sign in again
                    to open the Tomverse Admin Console.
                </div>
            ) : null}
            {accountSwitch ? (
                <div
                    role="status"
                    data-testid="signin-account-switch-notice"
                    className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900 dark:border-blue-500/30 dark:bg-blue-950/30 dark:text-blue-100"
                >
                    The previous session was ended. Choose an account to
                    continue.
                </div>
            ) : null}
            {providerError && !adminReauthentication ? (
                <div role="status" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-900 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-100">
                    {t(PROVIDER_ERROR_KEYS[providerError] || "auth.errorGeneric")}
                </div>
            ) : null}
            <p className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-left text-xs leading-5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-300">
                {t("auth.privacy")}{" "}
                <Link
                    href="/terms"
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                >
                    {t("auth.termsLink")}
                </Link>
                {" / "}
                <Link
                    href="/privacy"
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                >
                    {t("auth.privacyPolicyLink")}
                </Link>
            </p>

            {/* Google */}
            <button
                type="button"
                onClick={() => {
                    markSignupStarted("google");
                    void signIn("google", { callbackUrl }, oauthAuthorizationParams);
                }}
                className={providerButtonClass}
            >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="https://authjs.dev/img/providers/google.svg" className="h-5 w-5" alt="Google" />
                {t("auth.google")}
            </button>

            {/* Microsoft */}
            <button
                type="button"
                onClick={() => {
                    markSignupStarted("azure-ad");
                    void signIn("azure-ad", { callbackUrl }, oauthAuthorizationParams);
                }}
                className={providerButtonClass}
            >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" className="h-5 w-5">
                    <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                    <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                    <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                </svg>
                {t("auth.microsoft")}
            </button>

            <div className="flex items-center gap-3 py-1">
                <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                {/* UI-CONTRAST-001. zinc-400 composited to 2.62:1 against the
                    light card surface; dark already passed. Moved onto the
                    same supporting-text pair the rest of the product uses so
                    the divider label is legible in both themes without
                    outweighing the provider buttons beside it. */}
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-300">
                    {t("auth.orDivider")}
                </span>
                <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            </div>

            {step === "email" ? (
                <div className="space-y-2">
                    <label htmlFor="email-login-address" className="sr-only">
                        {t("auth.emailLoginEmailInputLabel")}
                    </label>
                    <input
                        ref={emailInputRef}
                        id="email-login-address"
                        type="email"
                        value={email}
                        onChange={(event) => {
                            setEmail(event.target.value);
                            if (emailError) setEmailError(null);
                        }}
                        onBlur={() => {
                            if (email && !isValidLoginEmail(email)) {
                                setEmailError(t("auth.emailLoginInvalidFormat"));
                            }
                        }}
                        onKeyDown={(event) => {
                            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                            event.preventDefault();
                            void handleSendCode();
                        }}
                        placeholder={t("auth.emailLoginPlaceholder")}
                        autoComplete="email"
                        aria-invalid={emailError ? true : undefined}
                        aria-describedby={emailError ? "email-login-error" : undefined}
                        className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-base text-zinc-900 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-white aria-[invalid=true]:border-red-400 aria-[invalid=true]:focus:border-red-500 aria-[invalid=true]:focus:ring-red-500/10 md:text-sm"
                    />
                    {emailError ? (
                        <p id="email-login-error" role="alert" className="px-1 text-xs font-semibold text-red-600 dark:text-red-400">
                            {emailError}
                        </p>
                    ) : null}
                    <div
                        ref={turnstileContainerRef}
                        className={needsTurnstile ? "flex justify-center py-1" : "hidden"}
                    />
                    <button
                        type="button"
                        disabled={!isEmailValid || isSendingCode || retryCountdown > 0}
                        onClick={handleSendCode}
                        className={providerButtonClass}
                    >
                        {isSendingCode
                            ? t("auth.loading")
                            : isMinuteRateLimited && retryCountdown > 0
                              ? `${t("auth.emailLoginButton")} (${retryCountdown})`
                              : t("auth.emailLoginButton")}
                    </button>
                </div>
            ) : (
                <div className="space-y-2">
                    <p id="email-login-code-description" role="status" className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                        {t("auth.emailLoginCodeSentBody").replace("{email}", email)}
                    </p>
                    <label htmlFor="email-login-code" className="sr-only">
                        {t("auth.emailLoginCodeInputLabel")}
                    </label>
                    <input
                        ref={codeInputRef}
                        id="email-login-code"
                        value={code}
                        onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="000000"
                        aria-describedby="email-login-code-description"
                        className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-center font-mono text-lg tracking-widest text-zinc-950 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 dark:border-zinc-700 dark:bg-zinc-950 dark:text-white"
                    />
                    <button
                        type="button"
                        disabled={isVerifyingCode || code.trim().length !== 6}
                        onClick={handleVerifyCode}
                        className={providerButtonClass}
                    >
                        {isVerifyingCode ? t("auth.loading") : t("auth.emailLoginVerifyButton")}
                    </button>
                    {/*
                      * Always present, not only after something visibly fails.
                      * This lane does not retry a login code in the background
                      * -- there is nothing stored to retry it from -- so the
                      * user pressing this is the recovery path, and it is
                      * better than a background retry anyway because it mints a
                      * fresh code rather than resending one that may have
                      * expired while it waited.
                      */}
                    <button
                        type="button"
                        disabled={isSendingCode || retryCountdown > 0}
                        onClick={handleSendCode}
                        className="w-full text-center text-xs font-semibold text-zinc-500 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline dark:text-zinc-400"
                    >
                        {retryCountdown > 0
                            ? `${t("auth.emailLoginResendButton")} (${retryCountdown})`
                            : t("auth.emailLoginResendButton")}
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setStep("email");
                            setCode("");
                            setFormError(null);
                            requestAnimationFrame(() => emailInputRef.current?.focus());
                        }}
                        className="w-full text-center text-xs font-semibold text-zinc-500 hover:underline dark:text-zinc-400"
                    >
                        {t("auth.emailLoginBackButton")}
                    </button>
                </div>
            )}
            {displayedFormError ? (
                <>
                    <p
                        role={isMinuteRateLimited ? undefined : "alert"}
                        aria-hidden={isMinuteRateLimited ? true : undefined}
                        className="text-center text-xs font-semibold text-red-600 dark:text-red-400"
                    >
                        {displayedFormError}
                    </p>
                    {isMinuteRateLimited && formError ? (
                        <p role="alert" className="sr-only">{formError}</p>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}

export function SignInPageContent() {
    const { t } = useLanguage();
    // The analytics consent notice used to render as a viewport-fixed bar
    // spanning the bottom of the screen, which could cross over the login
    // card's terms/privacy links or CTA on short viewports. Registering a
    // slot here lets AnalyticsProvider portal the notice into normal
    // document flow right after the card instead, so it can never overlap
    // it -- on short viewports the page just grows taller and scrolls
    // (UI-P1-02).
    const registerAuthConsentSlot = useAuthConsentSlotRef();
    const [consentSlot, setConsentSlot] = useState<HTMLDivElement | null>(null);
    useEffect(() => {
        registerAuthConsentSlot(consentSlot);
        return () => registerAuthConsentSlot(null);
    }, [consentSlot, registerAuthConsentSlot]);

    return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-zinc-100 px-4 pt-8 pb-[max(2rem,env(safe-area-inset-bottom))] transition-colors duration-300 dark:bg-zinc-950">
            <div
                data-testid="signin-card"
                className="w-full max-w-md overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-300/40 transition-all dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-black/30"
            >
                <div className="border-b border-zinc-200 px-8 py-7 dark:border-zinc-800">
                    <div className="mx-auto flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl bg-white ring-1 ring-zinc-200 shadow-sm dark:ring-zinc-800">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/tomverse-logo.png" alt="Tomverse" className="h-full w-full object-cover" />
                    </div>
                    <div className="mt-5 text-center">
                        <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white">
                            Tomverse Insight
                        </h1>
                        <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
                            {t("auth.description")}
                        </p>
                    </div>
                </div>

                <div className="px-8 py-7">
                    <Suspense fallback={<div className="mt-8 text-center text-sm text-zinc-400 dark:text-zinc-500">{t("auth.loading")}</div>}>
                        <SignInButtons />
                    </Suspense>
                </div>
            </div>
            <div ref={setConsentSlot} className="w-full max-w-md empty:hidden" />
        </main>
    );
}
