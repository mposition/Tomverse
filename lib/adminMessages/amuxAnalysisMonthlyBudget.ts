import { defineAdminMessages } from "@/lib/adminLocale";

export const adminAmuxAnalysisMonthlyBudgetMessages = defineAdminMessages({
  en: {
    title: "Analysis monthly budget", hint: "Agent analysis only; no user credits. Saving applies to the current UTC month and future months. It preserves usage and never starts a model or clears a halt.",
    month: "UTC month", current: "Current monthly threshold (USD)", spent: "Recorded internal cost (USD)", reserved: "Reserved (USD)", remaining: "Available (USD)", shadowOverrun: "Max shadow overrun (USD)", version: "Setting version",
    billing: "Max subscription analysis may exceed this shadow threshold. Recorded cost can include conservative unknown-outcome settlements; it is not the vendor's invoice.",
    limit: "New monthly threshold (USD)", inputHint: "Positive USD amount, up to two decimal places. The proposed US$1,000 is not active until saved.",
    confirm: "I approve this monthly analysis threshold and have checked the existing cost and reservations",
    save: "Save monthly threshold", refresh: "Refresh budget", readBack: "Read back this exact save",
    loading: "Checking the budget…", unavailable: "The monthly budget is unavailable or disabled.",
    invalid: "Enter a positive USD amount with at most two decimal places.", below: "The threshold cannot be below the recorded cost plus existing reservations.",
    changed: "The setting changed. Refresh it and confirm the new value before saving.",
    refused: "This save was refused before committing. Check permissions, recent authentication and the budget switches.",
    unknown: "The save outcome is unknown. Do not submit another change; read back the same request.",
    saved: "Monthly threshold saved. Existing cost and reservations were preserved. No model was called.", audit: "Approval audit ID",
    storage: "Recovery storage is unavailable. Saving is disabled to prevent a duplicate write after reload.",
  },
  ko: {
    title: "분석 월 예산", hint: "Agent 분석 전용이며 사용자 크레딧과 무관합니다. 저장하면 이번 UTC 월과 이후 월에 적용됩니다. 기존 사용액은 유지하며 모델 호출이나 정지 해제를 하지 않습니다.",
    month: "UTC 기준 월", current: "현재 월 기준액 (USD)", spent: "기록된 내부 비용 (USD)", reserved: "예약액 (USD)", remaining: "잔여액 (USD)", shadowOverrun: "Max shadow 초과액 (USD)", version: "설정 버전",
    billing: "Max 구독 분석은 이 shadow 기준액을 넘을 수 있습니다. 내부 비용에는 결과 불명 예약의 보수적 정산이 포함될 수 있으며 공급자의 실제 청구액이 아닙니다.",
    limit: "새 월 기준액 (USD)", inputHint: "0보다 큰 USD 금액을 소수점 두 자리까지 입력하세요. 제안된 US$1,000은 저장 전에는 적용되지 않습니다.",
    confirm: "기존 사용액·예약액을 확인했고 이 분석 월 기준액을 승인합니다",
    save: "월 기준액 저장", refresh: "예산 새로고침", readBack: "이 저장 요청 재조회",
    loading: "예산을 확인하는 중…", unavailable: "월 예산을 조회할 수 없거나 기능이 비활성화되어 있습니다.",
    invalid: "0보다 큰 USD 금액을 소수점 두 자리 이하로 입력하세요.", below: "기록된 내부 비용과 기존 예약액의 합보다 낮게 저장할 수 없습니다.",
    changed: "다른 설정 변경이 먼저 저장됐습니다. 새로고침 후 금액을 다시 확인하세요.",
    refused: "저장 전에 거절되었습니다. 권한·최근 관리자 인증·예산 스위치를 확인하세요.",
    unknown: "저장 결과를 알 수 없습니다. 다른 변경을 제출하지 말고 같은 요청을 재조회하세요.",
    saved: "월 기준액을 저장했습니다. 기존 사용액·예약액은 유지되며 모델은 호출되지 않았습니다.", audit: "승인 감사 ID",
    storage: "복구 정보를 보관할 수 없어 저장을 비활성화했습니다. 새로고침 뒤 중복 쓰기를 방지하기 위한 조치입니다.",
  },
});
