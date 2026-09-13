import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for the operator panels in `components/admin/AdminRiskPanels.tsx`, and
 * for the promotion risk labels the billing page computes for them.
 */
export const adminRiskPanelsMessages = defineAdminMessages({
  en: {
    promotionRisk: {
      eyebrow: "Risk",
      title: "Promotion risk monitor",
      description:
        "Codes that are close to exhaustion, discount unusually deeply, or carry hashed abuse signals from their redemptions.",
      empty: "No promotion is currently flagged.",
      redemptionSummary: (
        redeemed: number,
        maxRedemptions: number | null,
        discountPercent: number,
        abuseSignals: number
      ) =>
        `${redeemed}${maxRedemptions ? ` / ${maxRedemptions}` : ""} redeemed · ${discountPercent}% off${
          abuseSignals > 0
            ? ` / ${abuseSignals} hashed abuse signal${abuseSignals === 1 ? "" : "s"}`
            : ""
        }`,
      sharedSignals: (sharedIp: number, sharedPaymentMethod: number) =>
        `${sharedIp} shared IP · ${sharedPaymentMethod} shared payment method`,
      risk: {
        abuseSignals: (count: number) =>
          `${count} abuse signal${count === 1 ? "" : "s"}`,
        exhausted: "exhausted",
        nearLimit: "near limit",
        highDiscount: "high discount",
      },
    },
    supportAge: {
      eyebrow: "Service level",
      title: "Open support age",
      description:
        "Open feedback older than 24 hours, from the ten most recent reports.",
      empty: "No open report has breached the 24-hour mark.",
      hoursOpen: (hours: number) => `${hours}h open`,
      reported: (type: string, status: string, date: string) =>
        `${type} · ${status} · reported ${date} UTC`,
    },
    funnel: {
      eyebrow: "Funnel",
      title: "Launch conversion funnel",
      description:
        "Account-level counts over the whole database, not a sampled window.",
      accounts: "Accounts",
      usedChat: "Used chat",
      checkoutStarted: "Checkout started",
      paidUsers: "Paid users",
    },
    playbooks: {
      eyebrow: "Runbooks",
      title: "Operator playbooks",
      planNotUpdated: {
        title: "Plan not updated after payment",
        detail: "Open user detail, run Stripe resync, then verify webhook log.",
      },
      providerOutage: {
        title: "Provider outage",
        detail:
          "Create incident mode, add user-facing note, recommend fallback model.",
      },
      fileUploadFailure: {
        title: "File upload failure",
        detail: "Check R2 CORS, attachment limits, and support trace ID.",
      },
      oauthLogin: {
        title: "OAuth login issue",
        detail:
          "Check provider account link, callback URL, and account linking audit log.",
      },
    },
  },
  ko: {
    promotionRisk: {
      eyebrow: "위험",
      title: "프로모션 위험 모니터",
      description:
        "소진이 가까운 코드, 할인율이 비정상적으로 큰 코드, 사용 기록에 해시된 악용 신호가 있는 코드입니다.",
      empty: "현재 표시된 프로모션이 없습니다.",
      redemptionSummary: (
        redeemed: number,
        maxRedemptions: number | null,
        discountPercent: number,
        abuseSignals: number
      ) =>
        `${redeemed}${maxRedemptions ? ` / ${maxRedemptions}` : ""}회 사용 · ${discountPercent}% 할인${
          abuseSignals > 0 ? ` / 해시된 악용 신호 ${abuseSignals}건` : ""
        }`,
      sharedSignals: (sharedIp: number, sharedPaymentMethod: number) =>
        `공유 IP ${sharedIp}건 · 공유 결제 수단 ${sharedPaymentMethod}건`,
      risk: {
        abuseSignals: (count: number) => `악용 신호 ${count}건`,
        exhausted: "소진됨",
        nearLimit: "한도 임박",
        highDiscount: "높은 할인율",
      },
    },
    supportAge: {
      eyebrow: "서비스 수준",
      title: "미처리 지원 경과 시간",
      description:
        "최근 신고 10건 중 24시간이 지난 미처리 피드백입니다.",
      empty: "24시간을 넘긴 미처리 신고가 없습니다.",
      hoursOpen: (hours: number) => `${hours}시간 경과`,
      reported: (type: string, status: string, date: string) =>
        `${type} · ${status} · ${date} UTC 접수`,
    },
    funnel: {
      eyebrow: "퍼널",
      title: "출시 전환 퍼널",
      description:
        "표본 기간이 아니라 데이터베이스 전체에 대한 계정 단위 집계입니다.",
      accounts: "계정",
      usedChat: "채팅 사용",
      checkoutStarted: "Checkout 시작",
      paidUsers: "유료 사용자",
    },
    playbooks: {
      eyebrow: "런북",
      title: "운영자 플레이북",
      planNotUpdated: {
        title: "결제 후 플랜이 갱신되지 않음",
        detail:
          "사용자 상세를 열어 Stripe 재동기화를 실행한 뒤 webhook 로그를 확인하세요.",
      },
      providerOutage: {
        title: "공급자 장애",
        detail:
          "장애 모드를 만들고 사용자 안내 문구를 추가한 뒤 fallback 모델을 권장하세요.",
      },
      fileUploadFailure: {
        title: "파일 업로드 실패",
        detail: "R2 CORS, 첨부 한도, 지원 trace ID를 확인하세요.",
      },
      oauthLogin: {
        title: "OAuth 로그인 문제",
        detail:
          "로그인 공급자 계정 연결, callback URL, 계정 연결 감사 로그를 확인하세요.",
      },
    },
  },
});
