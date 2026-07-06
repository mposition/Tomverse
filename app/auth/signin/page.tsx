"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react"; // 💡 React에서 Suspense를 불러옵니다.

// 💡 1. useSearchParams를 사용하는 버튼 영역을 별도의 컴포넌트로 분리합니다.
function SignInButtons() {
    const searchParams = useSearchParams();
    const callbackUrl = searchParams.get("callbackUrl") || "/";

    return (
        <div className="mt-8 space-y-3">
            {/* Google */}
            <button
                onClick={() => signIn("google", { callbackUrl })}
                className="flex w-full items-center justify-center gap-3 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-zinc-900 transition-all hover:bg-zinc-200"
            >
                <img src="https://authjs.dev/img/providers/google.svg" className="h-5 w-5" alt="Google" />
                Google로 계속하기
            </button>

            {/* Microsoft */}
            <button
                onClick={() => signIn("azure-ad", { callbackUrl })}
                className="flex w-full items-center justify-center gap-3 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-zinc-900 transition-all hover:bg-zinc-200"
            >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" className="h-5 w-5">
                    <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                    <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                    <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                </svg>
                Microsoft로 계속하기
            </button>

            {/* Naver */}
            <button
                onClick={() => signIn("naver", { callbackUrl })}
                className="flex w-full items-center justify-center gap-3 rounded-xl bg-[#03C75A] px-4 py-3 text-sm font-semibold text-white transition-all hover:opacity-90"
            >
                <span className="font-black text-white">N</span>
                Naver로 계속하기
            </button>
        </div>
    );
}

// 💡 2. 메인 페이지에서는 분리한 컴포넌트를 Suspense로 감싸줍니다.
export default function SignInPage() {
    return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
            <div className="w-full max-w-md space-y-8 rounded-2xl border border-zinc-800 bg-zinc-900 p-8 shadow-2xl">

                {/* 로고 및 제목 */}
                <div className="text-center">
                    <h1 className="text-4xl font-bold tracking-tighter text-white">
                        Tomverse
                    </h1>
                    <p className="mt-2 text-zinc-400">
                        당신만의 AI 챗 허브에 로그인하세요
                    </p>
                </div>

                {/* 💡 3. 여기에 Suspense를 적용하여 빌드 에러를 우회합니다! */}
                <Suspense fallback={<div className="mt-8 text-center text-sm text-zinc-500">버튼을 불러오는 중...</div>}>
                    <SignInButtons />
                </Suspense>

                {/* 하단 안내 */}
                <p className="mt-6 text-center text-xs text-zinc-500">
                    로그인 시 Tomverse의 서비스 이용약관 및 개인정보 처리방침에 동의하게 됩니다.
                </p>
            </div>
        </div>
    );
}