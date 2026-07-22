"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { useTurnstile } from "@/components/chat/useTurnstile";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { withChatLanguage } from "@/lib/localizedCallbackUrl";
import {
    markSignupStarted,
    trackProductEvent,
} from "@/lib/productAnalyticsClient";

const PROVIDER_ERROR_KEYS: Record<string, string> = {
    OAuthAccountNotLinked: "auth.errorAccountNotLinked",
    AccessDenied: "auth.errorAccessDenied",
};

function SignInButtons() {
    const searchParams = useSearchParams();
    const { t, lang } = useLanguage();
    const callbackUrl = withChatLanguage(searchParams.get("callbackUrl"), lang);
    const adminReauthentication =
        searchParams.get("reason") === "admin-session-expired";
    const providerError = searchParams.get("error");
    const pageViewTrackedRef = useRef(false);

    const [step, setStep] = useState<"email" | "code">("email");
    const [email, setEmail] = useState("");
    const [code, setCode] = useState("");
    const [isSendingCode, setIsSendingCode] = useState(false);
    const [isVerifyingCode, setIsVerifyingCode] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [needsTurnstile, setNeedsTurnstile] = useState(false);
    const { containerRef: turnstileContainerRef, getToken: getTurnstileToken } =
        useTurnstile(true, "email_login_request");

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
        if (isSendingCode || !email.trim()) return;
        setIsSendingCode(true);
        setFormError(null);
        try {
            let response = await requestCode();
            if (response.status === 403) {
                const data = await response.json().catch(() => null);
                if (data?.code === "TURNSTILE_REQUIRED") {
                    setNeedsTurnstile(true);
                    const token = await getTurnstileToken();
                    response = await requestCode(token);
                }
            }
            if (!response.ok) {
                setFormError(t("auth.emailLoginRequestFailed"));
                return;
            }
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

    return (
        <div className="mt-8 space-y-4">
            {adminReauthentication ? (
                <div role="status" className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900 dark:border-blue-500/30 dark:bg-blue-950/30 dark:text-blue-100">
                    Your previous administrator session was ended. Sign in again
                    to open the Tomverse Admin Console.
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
                    Terms and Conditions
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
                    void signIn("google", { callbackUrl });
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
                    void signIn("azure-ad", { callbackUrl });
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
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                    {t("auth.orDivider")}
                </span>
                <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            </div>

            {step === "email" ? (
                <div className="space-y-2">
                    <input
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder={t("auth.emailLoginPlaceholder")}
                        autoComplete="email"
                        className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-white"
                    />
                    <div
                        ref={turnstileContainerRef}
                        className={needsTurnstile ? "flex justify-center py-1" : "hidden"}
                    />
                    <button
                        type="button"
                        disabled={!email.trim() || isSendingCode}
                        onClick={handleSendCode}
                        className={providerButtonClass}
                    >
                        {isSendingCode ? t("auth.loading") : t("auth.emailLoginButton")}
                    </button>
                </div>
            ) : (
                <div className="space-y-2">
                    <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                        {t("auth.emailLoginCodeSentBody").replace("{email}", email)}
                    </p>
                    <input
                        value={code}
                        onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="000000"
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
                    <button
                        type="button"
                        onClick={() => {
                            setStep("email");
                            setCode("");
                            setFormError(null);
                        }}
                        className="w-full text-center text-xs font-semibold text-zinc-500 hover:underline dark:text-zinc-400"
                    >
                        {t("auth.emailLoginBackButton")}
                    </button>
                </div>
            )}
            {formError ? (
                <p role="alert" className="text-center text-xs font-semibold text-red-600 dark:text-red-400">
                    {formError}
                </p>
            ) : null}
        </div>
    );
}

export default function SignInPage() {
    const { t } = useLanguage();

    return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-100 px-4 transition-colors duration-300 dark:bg-zinc-950">
            <div className="w-full max-w-md overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-300/40 transition-all dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-black/30">
                <div className="border-b border-zinc-200 px-8 py-7 dark:border-zinc-800">
                    <div className="mx-auto flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl bg-white ring-1 ring-zinc-200 shadow-sm dark:ring-zinc-800">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/tomverse-logo.png" alt="Tomverse" className="h-full w-full object-cover" />
                    </div>
                    <div className="mt-5 text-center">
                        <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white">
                            Tomverse AI
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

                    <div className="mt-6 rounded-xl bg-zinc-50 px-4 py-3 text-center dark:bg-zinc-950/60">
                        <p className="flex items-center justify-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Review the terms before continuing.
                        </p>
                        <Link
                            href="/terms"
                            className="mt-2 inline-flex text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400"
                        >
                            Terms and Conditions
                        </Link>
                        <span className="mx-2 text-xs text-zinc-400">/</span>
                        <Link
                            href="/privacy"
                            className="mt-2 inline-flex text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400"
                        >
                            {t("auth.privacyPolicyLink")}
                        </Link>
                    </div>
                </div>
            </div>
        </div>
    );
}
