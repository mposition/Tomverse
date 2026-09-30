"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLanguage } from "@/components/LanguageProvider";
import { withChatLanguage } from "@/lib/localizedCallbackUrl";
import { SignupConsentDevices } from "@/components/auth/SignupConsentDevices";
import {
    storedEmailAttemptId,
    storeSignupConsentChoice,
    withSignupConsentMarker,
} from "@/components/auth/signupConsentClient";

type Status = "verifying" | "error" | "no_account";

function EmailLinkVerifier({ signupConsentEnabled }: { signupConsentEnabled: boolean }) {
    const searchParams = useSearchParams();
    const { t, lang } = useLanguage();
    const callbackUrl = withChatLanguage(searchParams.get("callbackUrl"), lang);
    const token = searchParams.get("token");
    const [status, setStatus] = useState<Status>("verifying");
    const [heldEmail, setHeldEmail] = useState<string | null>(null);
    const [consentChoice, setConsentChoice] = useState({ optIn: false, objected: false });
    const [isSigningUp, setIsSigningUp] = useState(false);
    const [signupError, setSignupError] = useState(false);
    const startedRef = useRef(false);

    useEffect(() => {
        if (startedRef.current) return;
        startedRef.current = true;

        if (!token) {
            queueMicrotask(() => setStatus("error"));
            return;
        }

        void (async () => {
            try {
                // Opened in the tab that made the sign-up choice, the link was
                // asked for from the sign-up screen: it signs up, and the
                // landing carries the choice's marker like the code form's.
                // Anywhere else it signs in, and never creates an account
                // (docs/policy/email-product-news-redesign-draft.md section 5.2a).
                const attemptId = storedEmailAttemptId();
                const landing = withSignupConsentMarker(callbackUrl, attemptId);
                const result = await signIn("email-code", {
                    redirect: false,
                    linkToken: token,
                    intent: attemptId ? "signup" : "signin",
                    callbackUrl: landing,
                });
                if (result?.error === "EMAIL_ACCOUNT_NOT_FOUND") {
                    // The link proved the address and there is no account: it
                    // is now a one-time sign-up hold. Ask for the address it was
                    // sent to, which the sign-up choice is bound to.
                    const response = await fetch("/api/auth/email-login/held-address", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ linkToken: token }),
                    });
                    const data = (await response.json().catch(() => null)) as
                        | { ok?: unknown; email?: unknown }
                        | null;
                    if (response.ok && data?.ok === true && typeof data.email === "string") {
                        setHeldEmail(data.email);
                        setStatus("no_account");
                    } else {
                        setStatus("error");
                    }
                    return;
                }
                if (result?.error) {
                    setStatus("error");
                    return;
                }
                window.location.href = result?.url || landing;
            } catch {
                setStatus("error");
            }
        })();
    }, [token, callbackUrl]);

    const handleSignup = async () => {
        if (!token || !heldEmail || isSigningUp) return;
        setIsSigningUp(true);
        setSignupError(false);
        try {
            // This step shows the devices, so it is the screen that stores the
            // choice -- after the proof, never before it.
            const attemptId = signupConsentEnabled
                ? await storeSignupConsentChoice({
                      channel: "email_code",
                      email: heldEmail,
                      expressOptInRequested: consentChoice.optIn,
                      objected: consentChoice.objected,
                      language: lang,
                  })
                : null;
            const landing = withSignupConsentMarker(callbackUrl, attemptId);
            const result = await signIn("email-code", {
                redirect: false,
                linkToken: token,
                intent: "signup",
                callbackUrl: landing,
            });
            if (result?.error) {
                setSignupError(true);
                return;
            }
            window.location.href = result?.url || landing;
        } catch {
            setSignupError(true);
        } finally {
            setIsSigningUp(false);
        }
    };

    if (status === "verifying") {
        return (
            <p role="status" aria-live="polite" className="text-sm leading-6 text-zinc-500 dark:text-zinc-400">
                {t("auth.emailLoginLinkVerifying")}
            </p>
        );
    }

    if (status === "no_account" && heldEmail) {
        return (
            <div className="space-y-4 text-left" data-testid="email-link-no-account-step">
                <p role="status" className="text-sm leading-6 text-zinc-700 dark:text-zinc-200">
                    {t("auth.noAccountEmail").replace("{email}", heldEmail)}
                </p>
                {signupConsentEnabled ? (
                    <SignupConsentDevices
                        disabled={isSigningUp}
                        language={lang}
                        optIn={consentChoice.optIn}
                        objected={consentChoice.objected}
                        onChange={setConsentChoice}
                    />
                ) : null}
                <button
                    type="button"
                    disabled={isSigningUp}
                    onClick={handleSignup}
                    className="flex min-h-11 w-full items-center justify-center rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm font-semibold text-zinc-900 shadow-sm transition-all hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-100"
                >
                    {isSigningUp ? t("auth.loading") : t("auth.signupWithThisEmail")}
                </button>
                {signupError ? (
                    <p role="alert" className="text-center text-xs font-semibold text-red-600 dark:text-red-400">
                        {t("auth.emailLoginLinkExpired")}
                    </p>
                ) : null}
            </div>
        );
    }

    return (
        <div className="space-y-3">
            <p role="alert" className="text-sm leading-6 text-zinc-500 dark:text-zinc-400">
                {t("auth.emailLoginLinkExpired")}
            </p>
            <Link
                href="/auth/signin"
                className="inline-flex text-sm font-semibold text-blue-600 hover:underline dark:text-blue-400"
            >
                {t("auth.emailLoginBackButton")}
            </Link>
        </div>
    );
}

export function EmailLinkVerifyContent({ signupConsentEnabled }: { signupConsentEnabled: boolean }) {
    const { t } = useLanguage();

    return (
        <main className="flex min-h-screen items-center justify-center bg-zinc-100 px-4 transition-colors duration-300 dark:bg-zinc-950">
            <div className="w-full max-w-md rounded-3xl border border-zinc-200 bg-white p-8 text-center shadow-2xl shadow-zinc-300/40 dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-black/30">
                <div className="mx-auto flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl bg-white ring-1 ring-zinc-200 shadow-sm dark:ring-zinc-800">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/tomverse-logo.png" alt="Tomverse" className="h-full w-full object-cover" />
                </div>
                <h1 className="mt-5 text-xl font-bold text-zinc-900 dark:text-white">
                    Tomverse
                </h1>
                <div className="mt-4">
                    <Suspense fallback={<p role="status" className="text-sm text-zinc-400 dark:text-zinc-500">{t("auth.loading")}</p>}>
                        <EmailLinkVerifier signupConsentEnabled={signupConsentEnabled} />
                    </Suspense>
                </div>
            </div>
        </main>
    );
}
