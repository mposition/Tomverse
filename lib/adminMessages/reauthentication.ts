import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the administrator reauthentication screen. */
export const adminReauthenticationMessages = defineAdminMessages({
  en: {
    reasons: {
      "admin-session": {
        eyebrow: "Administrator session expired",
        title: "Administrator reauthentication required",
        lead: "Your normal Tomverse session is still active, but the shorter administrator session that opens the Admin Console has expired.",
      },
      "recent-auth": {
        eyebrow: "High-risk action needs a fresh sign-in",
        title: "Sign in again to make this change",
        lead: "Your Admin Console session is still valid. High-risk changes need a more recent sign-in than that, and this one is no longer recent enough, so the change was refused and nothing was saved.",
      },
    },
    signOutFailed: "Could not end the current session. Please try again.",
    refreshCannotRenew:
      "A browser refresh cannot renew administrator authentication. Sign out of the current app session completely, then sign in again to continue securely.",
    returnNote:
      "You will come back to the Admin Console screen you started from. Nothing you had not saved is carried over or re-sent -- review the change there and submit it again.",
    currentAccount: "Current account:",
    signingOut: "Signing out…",
    signOutAndReauthenticate: "Sign out and reauthenticate",
    returnToProduct: "Return to Tomverse",
  },
  ko: {
    reasons: {
      "admin-session": {
        eyebrow: "관리자 세션 만료",
        title: "관리자 재인증이 필요합니다",
        lead: "일반 Tomverse 세션은 아직 유효하지만, Admin Console을 여는 더 짧은 관리자 세션이 만료되었습니다.",
      },
      "recent-auth": {
        eyebrow: "고위험 작업에는 새 로그인이 필요합니다",
        title: "이 변경을 하려면 다시 로그인하세요",
        lead: "Admin Console 세션은 아직 유효합니다. 고위험 변경에는 그보다 최근의 로그인이 필요한데 현재 로그인은 충분히 최근이 아니어서, 변경이 거부되었고 아무것도 저장되지 않았습니다.",
      },
    },
    signOutFailed: "현재 세션을 종료하지 못했습니다. 다시 시도하세요.",
    refreshCannotRenew:
      "브라우저를 새로고침해도 관리자 인증은 갱신되지 않습니다. 현재 앱 세션에서 완전히 로그아웃한 뒤 다시 로그인해 안전하게 계속하세요.",
    returnNote:
      "작업을 시작한 Admin Console 화면으로 돌아갑니다. 저장하지 않은 내용은 이어지거나 다시 전송되지 않으니, 그 화면에서 변경 내용을 확인하고 다시 제출하세요.",
    currentAccount: "현재 계정:",
    signingOut: "로그아웃 중…",
    signOutAndReauthenticate: "로그아웃 후 재인증",
    returnToProduct: "Tomverse로 돌아가기",
  },
});
