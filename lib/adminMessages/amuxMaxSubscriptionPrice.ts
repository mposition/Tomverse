import { defineAdminMessages } from "@/lib/adminLocale";

export const adminAmuxMaxSubscriptionPriceMessages = defineAdminMessages({
  en: {
    title: "Max subscription analysis price",
    hint: "The v19 session runner analyses with the Claude Max subscription. Before its first claim it needs this price approved: the same Opus 5.5 rates and token caps as the API price, recorded as an estimate of what the run would cost on the API. Approving calls no model.",
    loading: "Checking the price…", unavailable: "The price cannot be read right now.",
    none: "Not approved yet, so the runner holds every session analysis.",
    ready: "Approved and usable", unusable: "Approved, but expired or not the reviewed profile. Revoke it, then approve again.",
    revoked: "Revoked. Approve again to resume.", version: "Version", expires: "Evidence expires",
    rates: "Input / output per million tokens (USD)", caps: "Input / output token caps",
    confirm: "I approve these rates as the worst-case estimate for Max subscription analysis",
    approve: "Approve Max subscription price", revoke: "Revoke this price", revokeConfirm: "I want to revoke this price",
    readBack: "Read back this exact approval", refresh: "Refresh",
    unknown: "The outcome is unknown. Do not approve again; read back the same request.",
    refused: "Refused before committing. Check permissions, recent authentication and the price switches.",
    saved: "Saved. No model was called.",
  },
  ko: {
    title: "Max 구독 분석 가격",
    hint: "v19 세션 runner는 Claude Max 구독으로 분석합니다. 첫 claim 전에 이 가격 승인이 필요합니다. API 가격과 같은 Opus 5.5 단가와 토큰 상한이며, 같은 실행을 API로 했을 때의 추정 비용으로 기록됩니다. 승인해도 모델은 호출되지 않습니다.",
    loading: "가격을 확인하는 중…", unavailable: "지금은 가격을 읽을 수 없습니다.",
    none: "아직 승인되지 않아 runner가 세션 분석을 모두 보류합니다.",
    ready: "승인됨, 사용 가능", unusable: "승인됐지만 만료됐거나 검토된 프로필과 다릅니다. 철회한 뒤 다시 승인하세요.",
    revoked: "철회됨. 다시 승인하면 재개됩니다.", version: "버전", expires: "근거 만료",
    rates: "백만 토큰당 입력 / 출력 (USD)", caps: "입력 / 출력 토큰 상한",
    confirm: "이 단가를 Max 구독 분석의 최악 비용 추정으로 승인합니다",
    approve: "Max 구독 가격 승인", revoke: "이 가격 철회", revokeConfirm: "이 가격을 철회합니다",
    readBack: "이 승인 요청 재조회", refresh: "새로고침",
    unknown: "결과를 알 수 없습니다. 다시 승인하지 말고 같은 요청을 재조회하세요.",
    refused: "저장 전에 거절되었습니다. 권한, 최근 관리자 인증, 가격 스위치를 확인하세요.",
    saved: "저장했습니다. 모델은 호출되지 않았습니다.",
  },
});
