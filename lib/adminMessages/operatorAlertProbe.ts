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
          "readiness 실패, 예산 소진 등 플랫폼 자체가 발생시키는 장애 알림입니다.",
      },
      provider: {
        name: "공급자 알림",
        description:
          "모델 공급자 장애, 지출 예산, 계정 잔액 알림입니다. 결과를 전송 로그에 기록합니다.",
      },
    },
    runFailed: "테스트를 실행하지 못했습니다.",
    sentFrom: (from: string | null) => `${from}에서 보냈습니다.`,
    nothingSent: (code: string | undefined) => `아무것도 보내지 않았습니다: ${code}.`,
    eyebrow: "이메일",
    title: "운영자 알림 경로",
    description:
      "이 두 경로는 문제가 있을 때만 발송하므로 평소 운영에서는 아무것도 이 경로를 실행하지 않습니다. 각 버튼은 해당 경로 자체의 코드로 실제 메시지 한 통을 보내고, 공급자가 수락한 주소를 보고합니다.",
    caveat:
      "테스트 통과는 이 경로가 발송할 수 있다는 뜻입니다. 이 경로를 호출해야 하는 조건(readiness 검사 실패, 예산 소진)이 여전히 이 경로를 호출한다는 뜻은 아닙니다.",
    to: "수신: ",
    sending: "보내는 중...",
    sendTest: "테스트 전송",
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
