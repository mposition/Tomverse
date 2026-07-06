// components/auth/AuthButton.tsx
"use client";

import { signIn, signOut, useSession } from "next-auth/react";

export function AuthButton() {
  // 💡 현재 로그인 상태(session)를 가져옵니다.
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <div className="text-sm text-zinc-400">로딩 중...</div>;
  }

  // 로그인된 상태일 때
  if (session && session.user) {
    return (
      <div className="flex items-center gap-3">
        {session.user.image && (
          <img src={session.user.image} alt="Profile" className="w-8 h-8 rounded-full" />
        )}
        <span className="text-sm font-medium text-zinc-200">
          {session.user.name}님
        </span>
        <button
          onClick={() => signOut()}
          className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors"
        >
          로그아웃
        </button>
      </div>
    );
  }

  // 로그인되지 않은 상태일 때 (로그인 버튼 표시)
  return (
    <div className="flex gap-2">
      <button
        onClick={() => signIn("google")}
        className="px-4 py-2 text-sm font-semibold text-zinc-900 bg-white rounded-md hover:bg-zinc-200 transition-colors"
      >
        Google 로그인
      </button>
      <button
        onClick={() => signIn("azure-ad")}
        className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
      >
        Microsoft 로그인
      </button>
    </div>
  );
}