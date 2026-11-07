import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the customer mail screen: the delivery log and the suppression list. */
export const adminEmailDeliveryMessages = defineAdminMessages({
  en: {
    eyebrow: "Email",
    deliveries: {
      title: "Deliveries",
      intro:
        "Every message we sent to a customer and what became of it. Messages we gave up on stay here with their attempts and error, so nothing is lost.",
      filtersLabel: "Delivery status filters",
      kindFiltersLabel: "Mail kind filters",
      statusGroup: "Status",
      kindGroup: "Kind",
      didNotArrive: "Did not arrive",
      allKinds: "All kinds",
      kinds: {
        transactional: "Sign-in and receipts",
        service: "Service notices",
        legal: "Legal notices",
        marketing: "Campaigns",
      } as Record<string, string>,
      statuses: {
        abandoned: "Gave up",
        failed: "Failed",
        bounced: "Bounced",
        complained: "Marked as spam",
        pending: "Waiting",
        sent: "Sent",
        delivered: "Delivered",
        suppressed: "Blocked",
        skipped: "Skipped",
      } as Record<string, string>,
      kpi: {
        sent: { label: "Mail sent", detail: "Handed to the mail provider, all time" },
        delivered: {
          label: "Delivered",
          detail: (delivered: number, total: number) => `${delivered} of ${total}`,
        },
        bounced: {
          label: "Bounced",
          detail: (complaints: number) =>
            complaints > 0 ? `${complaints} marked as spam` : "No spam reports",
        },
        held: { label: "Held back", detail: "Not sent because the address is blocked" },
      },
      scope: (count: number, statuses: string) =>
        `Showing ${count} row${count === 1 ? "" : "s"} in ${statuses}.`,
      hiddenRows: (count: number) =>
        ` ${count} row${count === 1 ? "" : "s"} in other statuses are not shown.`,
      columns: {
        recipient: "To",
        template: "Kind",
        subject: "Subject",
        created: "Created",
        status: "Status",
        attempts: "Attempts",
        lastError: "Last error",
      },
      noSubject: "No subject",
      empty: "Nothing in these statuses.",
      loadFailed: "The delivery log could not be read.",
      older: "Older",
    },
    suppressions: {
      title: "Suppressions",
      intro:
        "Addresses we will not mail. A hard bounce or a spam report never expires; a soft bounce holds for a day. Lifting one is audited and needs a written reason.",
      providerNotice:
        "This is our list, not the provider's. Resend keeps its own suppression list across the whole account and region, so an address removed here can still be refused there — and a promotion's complaint can refuse a login code no matter what this table says.",
      columns: {
        address: "Address",
        reason: "Why",
        scope: "Applies to",
      },
      reasons: {
        hard_bounce: "Address does not exist",
        soft_bounce: "Mailbox full or busy",
        complaint: "Marked as spam",
        unsubscribe: "Unsubscribed",
        privacy_request: "Privacy request",
        manual: "Added by hand",
      } as Record<string, string>,
      source: (source: string) => `via ${source}`,
      occurred: (when: string) => `on ${when}`,
      expires: (when: string) => `until ${when}`,
      empty: "No addresses are suppressed.",
      allMail: "all mail",
      never: "never expires",
      count: (count: number) => `${count} address${count === 1 ? "" : "es"}`,
    },
  },
  ko: {
    eyebrow: "이메일",
    deliveries: {
      title: "발송 기록",
      intro:
        "고객에게 보낸 모든 메일과 그 결과예요. 포기한 메일도 시도 횟수와 오류와 함께 여기 그대로 남아요.",
      filtersLabel: "발송 상태 필터",
      kindFiltersLabel: "메일 종류 필터",
      statusGroup: "상태",
      kindGroup: "종류",
      didNotArrive: "도착하지 않음",
      allKinds: "전체",
      kinds: {
        transactional: "로그인·영수증",
        service: "서비스 안내",
        legal: "법정 고지",
        marketing: "캠페인",
      } as Record<string, string>,
      statuses: {
        abandoned: "포기함",
        failed: "실패",
        bounced: "반송",
        complained: "스팸 신고",
        pending: "대기 중",
        sent: "보냄",
        delivered: "전달됨",
        suppressed: "차단됨",
        skipped: "건너뜀",
      } as Record<string, string>,
      kpi: {
        sent: { label: "보낸 메일", detail: "메일 공급자에게 넘긴 전체 수" },
        delivered: {
          label: "전달됨",
          detail: (delivered: number, total: number) => `${total}통 중 ${delivered}통`,
        },
        bounced: {
          label: "반송",
          detail: (complaints: number) =>
            complaints > 0 ? `스팸 신고 ${complaints}건` : "스팸 신고 없음",
        },
        held: { label: "보내지 않음", detail: "차단된 주소라 보내지 않았어요" },
      },
      scope: (count: number, statuses: string) =>
        `${statuses} 상태의 메일 ${count}통을 보여 줘요.`,
      hiddenRows: (count: number) => ` 다른 상태의 ${count}통은 숨겨져 있어요.`,
      columns: {
        recipient: "받는 사람",
        template: "종류",
        subject: "제목",
        created: "만든 시각",
        status: "상태",
        attempts: "시도",
        lastError: "마지막 오류",
      },
      noSubject: "제목 없음",
      empty: "이 상태에 해당하는 메일이 없어요.",
      loadFailed: "발송 기록을 읽지 못했어요.",
      older: "이전 기록",
    },
    suppressions: {
      title: "수신 거부",
      intro:
        "메일을 보내지 않는 주소예요. 없는 주소나 스팸 신고는 만료되지 않고, 일시적 반송은 하루 동안만 막아요. 해제하면 감사 기록에 남고 사유를 적어야 해요.",
      providerNotice:
        "이 목록은 공급자의 목록이 아니라 우리 목록이에요. Resend는 계정과 리전 전체에 자체 수신 거부 목록을 따로 두기 때문에, 여기서 해제한 주소도 그쪽에서 거절될 수 있어요. 프로모션 메일 하나에 대한 스팸 신고가 이 표와 상관없이 로그인 코드를 막을 수도 있어요.",
      columns: {
        address: "주소",
        reason: "이유",
        scope: "적용 범위",
      },
      reasons: {
        hard_bounce: "없는 주소",
        soft_bounce: "받은편지함 가득 참",
        complaint: "스팸 신고",
        unsubscribe: "수신 거부",
        privacy_request: "개인정보 요청",
        manual: "직접 추가",
      } as Record<string, string>,
      source: (source: string) => `${source}에서`,
      occurred: (when: string) => `${when}`,
      expires: (when: string) => `${when}까지`,
      empty: "수신 거부된 주소가 없어요.",
      allMail: "모든 메일",
      never: "만료 없음",
      count: (count: number) => `${count}개 주소`,
    },
  },
});
