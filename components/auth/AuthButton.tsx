// components/auth/AuthButton.tsx
"use client";

import { signIn, signOut, useSession } from "next-auth/react";

export function AuthButton() {
  // 💡 현재 로그인 상태(session)를 가져옵니다.
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <div className="text-sm text-zinc-400">로딩 중...</div>;
  }

// 1️⃣ 로그인 세션이 있는 경우 (Signed as 이메일 표시)
  if (session && session.user) {
    return (
      <div className="flex flex-col gap-2 w-full p-3 rounded-xl bg-zinc-900 border border-zinc-800">
        <div className="flex items-center gap-2.5 min-w-0">
          {session.user.image && (
            <img 
              src={session.user.image} 
              alt="Profile" 
              className="w-7 h-7 rounded-full border border-zinc-700 flex-shrink-0" 
            />
          )}
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Signed as</span>
            <span className="text-xs font-semibold text-zinc-200 truncate">
              {session.user.email}
            </span>
          </div>
        </div>
        <button
          onClick={() => signOut()}
          className="cursor-pointer w-full mt-1 py-1.5 text-xs font-medium text-zinc-400 bg-zinc-800 hover:bg-zinc-700 hover:text-zinc-200 rounded-lg transition-colors"
        >
          로그아웃
        </button>
          {/* 추후 설정 모달이나 관리 페이지 라우팅용 버튼 */}
          <button 
            onClick={() => alert("추후 사용자 설정 기능이 구현될 예정입니다.")}
                className=" w-full mt-1 py-1.5 text-xs font-medium text-zinc-400 bg-zinc-800 hover:bg-zinc-700 hover:text-zinc-200 rounded-lg transition-colors"
            >
          사용자 설정
          </button>		
      </div>
    );
  }

  // 2️⃣ 로그인 세션이 없는 경우 (로그인/가입 버튼만 표시)
  return (
    <button
      onClick={() => signIn()} 
      className="cursor-pointer w-full px-4 py-2.5 text-sm font-bold text-white bg-gradient-to-r from-indigo-600 to-blue-600 rounded-xl hover:from-indigo-500 hover:to-blue-500 transition-all shadow-lg"
    >
      로그인 / 회원가입
    </button>
  );
}