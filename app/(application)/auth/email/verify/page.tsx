"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLanguage } from "@/components/LanguageProvider";
import { withChatLanguage } from "@/lib/localizedCallbackUrl";

function EmailLinkVerifier() {
    const searchParams = useSearchParams();
    const { t, lang } = useLanguage();
    const callbackUrl = withChatLanguage(searchParams.get("callbackUrl"), lang);
    const token = searchParams.get("token");
    const [status, setStatus] = useState<"verifying" | "error">("verifying");
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
                const result = await signIn("email-code", {
                    redirect: false,
                    linkToken: token,
                    callbackUrl,
                });
                if (result?.error) {
                    setStatus("error");
                    return;
                }
                window.location.href = result?.url || callbackUrl;
            } catch {
                setStatus("error");
            }
        })();
    }, [token, callbackUrl]);

    if (status === "verifying") {
        return (
            <p className="text-sm leading-6 text-zinc-500 dark:text-zinc-400">
                {t("auth.emailLoginLinkVerifying")}
            </p>
        );
    }

    return (
        <div className="space-y-3">
            <p className="text-sm leading-6 text-zinc-500 dark:text-zinc-400">
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

export default function EmailLoginVerifyPage() {
    const { t } = useLanguage();

    return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-100 px-4 transition-colors duration-300 dark:bg-zinc-950">
            <div className="w-full max-w-md rounded-3xl border border-zinc-200 bg-white p-8 text-center shadow-2xl shadow-zinc-300/40 dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-black/30">
                <div className="mx-auto flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl bg-white ring-1 ring-zinc-200 shadow-sm dark:ring-zinc-800">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/tomverse-logo.png" alt="Tomverse" className="h-full w-full object-cover" />
                </div>
                <h1 className="mt-5 text-xl font-bold text-zinc-900 dark:text-white">
                    Tomverse Insight
                </h1>
                <div className="mt-4">
                    <Suspense fallback={<p className="text-sm text-zinc-400 dark:text-zinc-500">{t("auth.loading")}</p>}>
                        <EmailLinkVerifier />
                    </Suspense>
                </div>
            </div>
        </div>
    );
}
