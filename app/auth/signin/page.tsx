"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react"; // 💡 React에서 Suspense를 불러옵니다.
import { useLanguage } from "@/components/LanguageProvider";
import Link from "next/link";

// 💡 1. useSearchParams를 사용하는 버튼 영역을 별도의 컴포넌트로 분리합니다.
function SignInButtons() {
    const searchParams = useSearchParams();
    const callbackUrl = searchParams.get("callbackUrl") || "/";
    const { t } = useLanguage(); // 💡 t 함수 꺼내기

    return (
        <div className="mt-8 space-y-3">
            {/* Google */}
            {/* 💡 라이트 모드일 때 눈에 잘 띄도록 연한 테두리(border-zinc-200) 및 호버 피드백 추가 */}
            <button
                onClick={() => signIn("google", { callbackUrl })}
                className="cursor-pointer flex w-full items-center justify-center gap-3 rounded-xl bg-white border border-zinc-200 px-4 py-3 text-sm font-semibold text-zinc-900 transition-all hover:bg-zinc-50 dark:border-transparent dark:hover:bg-zinc-200"
            >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="https://authjs.dev/img/providers/google.svg" className="h-5 w-5" alt="Google" />
                {t("auth.google")}
            </button>

            {/* Microsoft */}
            {/* 💡 라이트 모드 대응 테두리 및 배경 최적화 */}
            <button
                onClick={() => signIn("azure-ad", { callbackUrl })}
                className="cursor-pointer flex w-full items-center justify-center gap-3 rounded-xl bg-white border border-zinc-200 px-4 py-3 text-sm font-semibold text-zinc-900 transition-all hover:bg-zinc-50 dark:border-transparent dark:hover:bg-zinc-200"
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
            {/* 💡 네이버 브랜드 컬러는 테마와 무관하게 고유 색상을 유지하되 커서 포인터 최적화 */}
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

// 💡 2. 메인 페이지에서는 분리한 컴포넌트를 Suspense로 감싸줍니다.
export default function SignInPage() {
    const { t } = useLanguage(); // 💡 t 함수 꺼내기

    return (
        // 💡 전체 배경색 조절 (라이트: 연한 회색 bg-zinc-50, 다크: 무한 우주 bg-zinc-950)
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 transition-colors duration-300 dark:bg-zinc-950">
            {/* 💡 중앙 로그인 카드 박스 조절 (라이트: 흰색 배경에 고운 그림자, 다크: bg-zinc-900에 짙은 테두리) */}
            <div className="w-full max-w-md space-y-8 rounded-2xl border border-zinc-200 bg-white p-8 shadow-2xl transition-all dark:border-zinc-800 dark:bg-zinc-900">

                {/* 로고 및 제목 */}
                <div className="text-center">
                    {/* 💡 타이틀 글자 색상 교차 매핑 */}
                    <h1 className="text-4xl font-bold tracking-tighter text-zinc-900 dark:text-white">
                        Tomverse
                    </h1>
                    {/* 💡 설명 문구 색상 최적화 */}
                    <p className="mt-2 text-zinc-500 dark:text-zinc-400">
                        {t("auth.description")}
                    </p>
                </div>

                {/* 💡 3. 여기에 Suspense를 적용하여 빌드 에러를 우회합니다! */}
                <Suspense fallback={<div className="mt-8 text-center text-sm text-zinc-400 dark:text-zinc-500">버튼을 불러오는 중...</div>}>
                    <SignInButtons />
                </Suspense>

                {/* 하단 안내 문구 */}
                <p className="mt-6 text-center text-xs text-zinc-400 dark:text-zinc-500">
                    {t("auth.privacy") }
                </p>
                <div className="text-center">
                    <Link
                        href="/privacy"
                        className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                        {t("auth.privacyPolicyLink")}
                    </Link>
                </div>
            </div>
        </div>
    );
}
