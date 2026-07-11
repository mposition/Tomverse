"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";

function SignInButtons() {
    const searchParams = useSearchParams();
    const callbackUrl = searchParams.get("callbackUrl") || "/chat";
    const { t } = useLanguage();

    return (
        <div className="mt-8 space-y-3">
            {/* Google */}
            <button
                onClick={() => signIn("google", { callbackUrl })}
                className="cursor-pointer flex w-full items-center justify-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm font-semibold text-zinc-900 shadow-sm transition-all hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-100"
            >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="https://authjs.dev/img/providers/google.svg" className="h-5 w-5" alt="Google" />
                {t("auth.google")}
            </button>

            {/* Microsoft */}
            <button
                onClick={() => signIn("azure-ad", { callbackUrl })}
                className="cursor-pointer flex w-full items-center justify-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm font-semibold text-zinc-900 shadow-sm transition-all hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-100"
            >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" className="h-5 w-5">
                    <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                    <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                    <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                </svg>
                {t("auth.microsoft") }
            </button>

            {/* Naver */}
            <button
                onClick={() => signIn("naver", { callbackUrl })}
                className="cursor-pointer flex w-full items-center justify-center gap-3 rounded-xl bg-[#03C75A] px-4 py-3 text-sm font-semibold text-white transition-all hover:opacity-90"
            >
                <span className="font-black text-white">N</span>
                {t("auth.naver")}
            </button>
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
                            {t("auth.privacy")}
                        </p>
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
