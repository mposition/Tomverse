import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy shared by the console's route-level states. */
export const adminCommonMessages = defineAdminMessages({
  en: {
    error: {
      title: "Admin workspace could not be loaded",
      safeFailure: "The operation failed without exposing sensitive server details.",
      digest: (digest: string) => `Reference digest ${digest} in the server logs.`,
      noDigest:
        "This failure produced no digest, so look it up by time in the server logs.",
      retry: "Try again",
    },
    apiFailure: {
      errorTitle: "The request was refused",
      // Not "failed". The request was stored and is waiting for a second
      // administrator; an operator told it failed retries something that has
      // already been accepted.
      queuedTitle: "Queued for a second administrator",
      reauthenticationTitle: "Your administrator sign-in is no longer recent",
      reauthenticate: "Sign in again to continue",
      retry: "Try again",
    },
    loading: "Loading this Admin workspace.",
  },
  ko: {
    error: {
      title: "관리자 작업 공간을 불러오지 못했습니다",
      safeFailure: "민감한 서버 정보를 노출하지 않고 작업이 실패했습니다.",
      digest: (digest: string) => `서버 로그에서 digest ${digest} 항목을 찾아보세요.`,
      noDigest:
        "이 실패에는 digest가 없습니다. 서버 로그에서 발생 시각으로 찾아보세요.",
      retry: "다시 시도",
    },
    apiFailure: {
      errorTitle: "요청이 거절되었습니다",
      queuedTitle: "두 번째 관리자의 승인을 기다리는 중입니다",
      reauthenticationTitle: "관리자 로그인이 더 이상 최근이 아닙니다",
      reauthenticate: "다시 로그인하고 계속하기",
      retry: "다시 시도",
    },
    loading: "이 관리자 작업 공간을 불러오는 중입니다.",
  },
});
