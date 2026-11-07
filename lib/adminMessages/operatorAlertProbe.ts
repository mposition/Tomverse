import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the operator alert path probe under Alerts. */
export const adminOperatorAlertProbeMessages = defineAdminMessages({
  en: {
    paths: {
      operational: {
        name: "Operational alerts",
        description:
          "Readiness failures, budget exhaustion and other incidents raised by the platform itself.",
      },
      provider: {
        name: "Provider alerts",
        description:
          "Model provider outages, spend budgets and account balances. Records its outcome in the delivery log.",
      },
    },
    runFailed: "Could not run the test.",
    sentFrom: (from: string | null) => `Sent from ${from}.`,
    nothingSent: (code: string | undefined) => `Nothing was sent: ${code}.`,
    eyebrow: "Email",
    title: "Operator alert paths",
    description:
      "These two paths send only when something is wrong, so nothing exercises them in ordinary operation. Each button sends one real message through that path's own code and reports the address the provider accepted.",
    caveat:
      "A passing test shows the path can send. It does not show that the condition which should trigger it — a failed readiness check, an exhausted budget — still calls it.",
    to: "to: ",
    sending: "Sending...",
    sendTest: "Send test",
    result: "Result",
    sent: "Sent",
    notSent: "Not sent",
    from: "From",
    recipient: "To",
    provider: "Provider",
    noIdReturned: "no id returned",
    reason: "Reason",
  },
  ko: {
    paths: {
      operational: {
        name: "운영 알림",
        description:
          "점검 실패, 예산 소진처럼 플랫폼이 스스로 알리는 장애 알림이에요.",
      },
      provider: {
        name: "공급자 알림",
        description:
          "모델 공급자 장애, 지출 예산, 계정 잔액 알림이에요. 결과는 발송 기록에 남아요.",
      },
    },
    runFailed: "시험을 실행하지 못했어요.",
    sentFrom: (from: string | null) => `${from}에서 보냈어요.`,
    nothingSent: (code: string | undefined) => `아무것도 보내지 않았어요: ${code}.`,
    eyebrow: "이메일",
    title: "운영자 알림 경로",
    description:
      "이 두 경로는 문제가 있을 때만 메일을 보내서, 평소에는 아무도 써 보지 못해요. 버튼을 누르면 그 경로의 코드로 실제 메일 한 통을 보내고, 공급자가 받은 주소를 알려 줘요.",
    caveat:
      "시험을 통과해도 이 경로로 메일을 보낼 수 있다는 것만 알 수 있어요. 이 경로를 불러야 하는 상황(점검 실패, 예산 소진)이 지금도 이 경로를 부른다는 뜻은 아니에요.",
    to: "받는 주소: ",
    sending: "보내는 중...",
    sendTest: "시험 메일 보내기",
    result: "결과",
    sent: "발송됨",
    notSent: "발송 안 됨",
    from: "발신",
    recipient: "수신",
    provider: "공급자",
    noIdReturned: "반환된 id 없음",
    reason: "사유",
  },
});
