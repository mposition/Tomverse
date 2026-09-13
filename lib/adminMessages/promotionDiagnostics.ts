import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the read-only promotion diagnostics panel under Billing > Promotions. */
export const adminPromotionDiagnosticsMessages = defineAdminMessages({
  en: {
    status: {
      pass: "Pass",
      ready: "Ready",
      fail: "Fail",
      blocked: "Blocked",
      warn: "Warning",
      warning: "Warning",
      not_checked: "Not checked",
    },
    maskedId: {
      notStored: "not stored",
      hide: (label: string) => `Hide ${label}`,
      reveal: (label: string) => `Reveal ${label}`,
    },
    title: "Promotion diagnostics",
    description:
      "Reads the saved promotion policy, the selected account and the Stripe Coupon and Promotion Code behind this code. It creates nothing: no account, no Coupon, no Promotion Code, no Checkout Session, and no redemption.",
    fields: {
      promotion: "Promotion",
      noPromotions: "No promotions",
      plan: "Plan",
      billingInterval: "Billing interval",
      monthly: "Monthly",
      annual: "Annual",
      marketCurrency: "Market currency",
      existingAccount: "Existing account (optional)",
      userPlaceholder: "User ID — leave blank for a configuration-only run",
      accountHelp:
        "An existing account only. Nothing here creates one, and no account is required to diagnose the configuration.",
    },
    dirtyNotice:
      "Save or discard changes before diagnosing. Diagnostics read the saved database configuration, not the unsaved edits in the promotion editor.",
    cleanNotice:
      "Diagnostics read the saved database configuration, not unsaved edits in the promotion editor.",
    running: "Running diagnostics…",
    run: "Run diagnostics",
    copySummary: "Copy summary",
    copyJson: "Copy JSON",
    retry: "Retry",
    errors: {
      notCompleted: "Promotion diagnostics could not be completed.",
      unreachable: "Promotion diagnostics could not be reached.",
    },
    copy: {
      summaryTarget: "Diagnostics summary",
      jsonTarget: "Diagnostics JSON",
      dryRunTarget: "Dry-run command",
      copied: (what: string) => `${what} copied.`,
      failed: (what: string) => `${what} could not be copied.`,
    },
    summary: {
      label: "Summary",
      ready:
        "No blocker was found in the policy and Stripe linkage that can be read from here. This is not a guarantee that Checkout will succeed.",
      blocked:
        "Blockers below are read from the saved configuration and Stripe. Fix them before retrying a customer checkout.",
    },
    localPolicy: "Local policy",
    account: {
      title: "Account eligibility",
      evaluated: "Judged with the same function /api/billing/checkout uses.",
      notEvaluated: "Not evaluated — no account selected.",
    },
    stripe: {
      title: "Stripe linkage",
      facts: (mode: string, candidates: number, recommendation: string) =>
        `Expected mode: ${mode} · exact-code candidates: ${candidates} · recommendation: ${recommendation}`,
      modeUnknown: "unknown",
      modeLive: "live",
      modeTest: "test",
      storedCoupon: "Stored coupon",
      storedCouponInStripe: "Stored coupon in Stripe: ",
      found: "found",
      notFoundInMode: "not found in this mode",
      storedPromotionCode: "Stored promotion code",
      blocking: (reasons: string) => `Blocking: ${reasons}`,
      drift: (reasons: string) => `Drift (non-fatal): ${reasons}`,
      candidatesHeading: "Stripe objects holding this code string",
      candidateLabel: (active: boolean, adoptable: boolean) =>
        `${active ? "Active" : "Inactive"}${adoptable ? ", adoptable" : ""}`,
    },
    preview: {
      title: "Checkout request preview",
      description:
        "Predicted from the resolved configuration. No Checkout Session is created.",
      baseAmount: "Base amount",
      discountedAmount: "Discounted amount",
      minorUnits: (amount: number, currency: string) =>
        `${amount} ${currency} (minor units)`,
      discountSource: "Discount source",
      discountsSentSuffix: " sent",
      paymentMethodRequired: "Payment method required",
      automaticRenewal: "Automatic renewal",
      yes: "yes",
      no: "no",
      bothParamsBefore: "Blocker: the Session request would carry both ",
      bothParamsBetween: " and ",
      bothParamsAfter: ". Stripe refuses that request whatever the value is.",
    },
    abuse: {
      title: "Abuse signals",
      description:
        "Not evaluated — the admin request's IP is not the customer's IP, and evaluating it here would corrupt the shared-IP signal.",
      stored: (total: number, sharedIp: number, sharedPaymentMethod: number) =>
        `Stored signals on this promotion: ${total} total · ${sharedIp} shared IP · ${sharedPaymentMethod} shared payment method.`,
    },
    actions: {
      title: "Recommended action",
      copyDryRun: "Copy dry-run command",
      repairsNote:
        "Repairs are run deliberately from a terminal with an incident reference. This console never applies one, and never deletes or deactivates a Stripe object.",
    },
    multiPlan: (plans: string) =>
      `This promotion is eligible for ${plans}. One promotion row carries one Stripe Coupon and Promotion Code for every eligible plan, because a Stripe promotion code string is unique across the account.`,
    planJoiner: " and ",
  },
  ko: {
    status: {
      pass: "통과",
      ready: "준비됨",
      fail: "실패",
      blocked: "차단됨",
      warn: "경고",
      warning: "경고",
      not_checked: "검사 안 함",
    },
    maskedId: {
      notStored: "저장되지 않음",
      hide: (label: string) => `${label} 숨기기`,
      reveal: (label: string) => `${label} 표시`,
    },
    title: "프로모션 진단",
    description:
      "저장된 프로모션 정책, 선택한 계정, 이 코드에 연결된 Stripe Coupon과 Promotion Code를 읽습니다. 계정, Coupon, Promotion Code, Checkout Session, 사용 기록 중 어느 것도 만들지 않습니다.",
    fields: {
      promotion: "프로모션",
      noPromotions: "프로모션 없음",
      plan: "플랜",
      billingInterval: "결제 주기",
      monthly: "월간",
      annual: "연간",
      marketCurrency: "시장 통화",
      existingAccount: "기존 계정(선택)",
      userPlaceholder: "사용자 ID — 설정만 진단하려면 비워 두세요",
      accountHelp:
        "기존 계정만 입력합니다. 여기서는 계정을 만들지 않으며, 설정 진단에는 계정이 필요하지 않습니다.",
    },
    dirtyNotice:
      "진단하기 전에 변경 사항을 저장하거나 취소하세요. 진단은 프로모션 편집기의 저장되지 않은 수정이 아니라 데이터베이스에 저장된 설정을 읽습니다.",
    cleanNotice:
      "진단은 프로모션 편집기의 저장되지 않은 수정이 아니라 데이터베이스에 저장된 설정을 읽습니다.",
    running: "진단 실행 중…",
    run: "진단 실행",
    copySummary: "요약 복사",
    copyJson: "JSON 복사",
    retry: "다시 시도",
    errors: {
      notCompleted: "프로모션 진단을 완료하지 못했습니다.",
      unreachable: "프로모션 진단에 연결하지 못했습니다.",
    },
    copy: {
      summaryTarget: "진단 요약",
      jsonTarget: "진단 JSON",
      dryRunTarget: "dry-run 명령",
      copied: (what: string) => `${what}을(를) 복사했습니다.`,
      failed: (what: string) => `${what}을(를) 복사하지 못했습니다.`,
    },
    summary: {
      label: "요약",
      ready:
        "여기서 읽을 수 있는 정책과 Stripe 연결에서 차단 요인을 찾지 못했습니다. Checkout 성공을 보장하는 것은 아닙니다.",
      blocked:
        "아래 차단 요인은 저장된 설정과 Stripe에서 읽은 것입니다. 고객 결제를 다시 시도하기 전에 해결하세요.",
    },
    localPolicy: "로컬 정책",
    account: {
      title: "계정 적격성",
      evaluated: "/api/billing/checkout과 같은 함수로 판정했습니다.",
      notEvaluated: "평가하지 않음 — 선택한 계정이 없습니다.",
    },
    stripe: {
      title: "Stripe 연결",
      facts: (mode: string, candidates: number, recommendation: string) =>
        `예상 모드: ${mode} · 코드 일치 후보: ${candidates} · 권장 조치: ${recommendation}`,
      modeUnknown: "알 수 없음",
      modeLive: "live",
      modeTest: "test",
      storedCoupon: "저장된 coupon",
      storedCouponInStripe: "Stripe의 저장된 coupon: ",
      found: "찾음",
      notFoundInMode: "이 모드에서 찾지 못함",
      storedPromotionCode: "저장된 promotion code",
      blocking: (reasons: string) => `차단: ${reasons}`,
      drift: (reasons: string) => `불일치(치명적이지 않음): ${reasons}`,
      candidatesHeading: "이 코드 문자열을 가진 Stripe 객체",
      candidateLabel: (active: boolean, adoptable: boolean) =>
        `${active ? "활성" : "비활성"}${adoptable ? ", 채택 가능" : ""}`,
    },
    preview: {
      title: "Checkout 요청 미리보기",
      description:
        "해석된 설정으로 예측한 결과입니다. Checkout Session은 만들지 않습니다.",
      baseAmount: "기본 금액",
      discountedAmount: "할인 후 금액",
      minorUnits: (amount: number, currency: string) =>
        `${amount} ${currency} (최소 단위)`,
      discountSource: "할인 출처",
      discountsSentSuffix: " 전송",
      paymentMethodRequired: "결제 수단 필요",
      automaticRenewal: "자동 갱신",
      yes: "예",
      no: "아니요",
      bothParamsBefore: "차단 요인: Session 요청에 ",
      bothParamsBetween: "와 ",
      bothParamsAfter:
        "가 함께 실립니다. 값과 관계없이 Stripe가 이 요청을 거부합니다.",
    },
    abuse: {
      title: "악용 신호",
      description:
        "평가하지 않음 — 관리자 요청의 IP는 고객의 IP가 아니므로, 여기서 평가하면 공유 IP 신호가 오염됩니다.",
      stored: (total: number, sharedIp: number, sharedPaymentMethod: number) =>
        `이 프로모션에 저장된 신호: 전체 ${total}건 · 공유 IP ${sharedIp}건 · 공유 결제 수단 ${sharedPaymentMethod}건.`,
    },
    actions: {
      title: "권장 조치",
      copyDryRun: "dry-run 명령 복사",
      repairsNote:
        "복구는 장애 참조 번호와 함께 터미널에서 의도적으로 실행합니다. 이 콘솔은 복구를 적용하지 않으며, Stripe 객체를 삭제하거나 비활성화하지도 않습니다.",
    },
    multiPlan: (plans: string) =>
      `이 프로모션은 ${plans} 플랜에 적용됩니다. Stripe promotion code 문자열은 계정 전체에서 고유하므로, 프로모션 행 하나가 모든 적용 플랜에 대해 Stripe Coupon과 Promotion Code를 하나씩만 가집니다.`,
    planJoiner: ", ",
  },
});
