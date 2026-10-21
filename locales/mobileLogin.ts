import type { MobileLanguage } from "./mobile";
const en = {
  "title": "Sign in to Tomverse",
  "intro": "Use your account email. Enter the code here to stay in the app.",
  "email": "Email address",
  "send": "Send sign-in code",
  "code": "6-digit code",
  "sent": "Check your email and enter the code below.",
  "verify": "Verify and continue",
  "change": "Use another email",
  "resend": "Send a new code",
  "otherSignIn": "Use another sign-in method",
  "unavailable": "App sign-in is not available on this server yet. Please try again after the service update.",
  "invalid": "This code is invalid or expired. Check it or request a new code.",
  "limited": "Too many attempts. Wait a moment before trying again.",
  "failed": "Sign-in could not finish. Check your connection. If you already verified a code, request a new one.",
  "requestFailed": "Could not request a sign-in code. Please try again later.",
  "deliveryFailed": "The email service could not send the code. Please try again later.",
  "challenge": "Additional verification is required. Sign in on the Tomverse website, or try again later.",
  "account": "No account was found for this verified email. Create an account on the Tomverse website first.",
  "refused": "This account cannot sign in right now. Check your account on the Tomverse website."
};
export const mobileLoginCopy: Record<MobileLanguage, typeof en> = {
 en, ko: {
  "title": "Tomverse에 로그인",
  "intro": "계정 이메일로 받은 인증 코드를 앱에서 입력하세요.",
  "email": "이메일 주소",
  "send": "인증 코드 받기",
  "code": "6자리 인증 코드",
  "sent": "이메일로 받은 코드를 아래에 입력하세요.",
  "verify": "확인하고 시작하기",
  "change": "다른 이메일 사용",
  "resend": "새 코드 받기",
  "otherSignIn": "다른 로그인 방법 사용",
  "unavailable": "이 서버는 아직 앱 로그인을 지원하지 않습니다. 서비스 업데이트 후 다시 시도해 주세요.",
  "invalid": "코드가 올바르지 않거나 만료되었습니다. 확인하거나 새 코드를 받아 주세요.",
  "limited": "시도 횟수가 많습니다. 잠시 후 다시 시도해 주세요.",
  "failed": "로그인을 완료하지 못했습니다. 연결을 확인해 주세요. 이미 코드를 확인했다면 새 코드를 받아 주세요.",
  "requestFailed": "인증 코드를 요청하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  "deliveryFailed": "메일 서비스에서 인증 코드를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.",
  "challenge": "추가 인증이 필요합니다. Tomverse 웹사이트에서 로그인하거나 잠시 후 다시 시도해 주세요.",
  "account": "인증한 이메일의 계정이 없습니다. 먼저 Tomverse 웹사이트에서 계정을 만들어 주세요.",
  "refused": "현재 이 계정으로 로그인할 수 없습니다. Tomverse 웹사이트에서 계정 상태를 확인해 주세요."
},
 // English fallback until the initial email flow's other translations are ready.
 zh: en, de: en, fr: en, es: en, pt: en,
};
export function mobileLoginError(error: unknown, language: MobileLanguage, phase: "request" | "verify" = "verify") {
 const code = (error as { code?: string })?.code ?? "";
 const copy = mobileLoginCopy[language];
 if (code === "MOBILE_LOGIN_UNAVAILABLE") return copy.unavailable;
 if (code === "EMAIL_CODE_INVALID") return copy.invalid;
 if (code === "EMAIL_ACCOUNT_NOT_FOUND") return copy.account;
 if (code === "MOBILE_LOGIN_REFUSED") return copy.refused;
 if (code === "EMAIL_CODE_LOCKED" || code.includes("RATE_LIMITED")) return copy.limited;
 if (code.startsWith("TURNSTILE_")) return copy.challenge;
 if (code === "SEND_FAILED") return copy.deliveryFailed;
 return phase === "request" ? copy.requestFailed : copy.failed;
}
