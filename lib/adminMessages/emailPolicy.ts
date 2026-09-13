import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the jurisdiction policy console and the sending-domain report. */
export const adminEmailPolicyMessages = defineAdminMessages({
  en: {
    eyebrow: "Email",
    policy: {
      title: "Jurisdiction policy",
      intro:
        "Subject prefixes, footer blocks, unsubscribe wording, quiet hours and consent notice intervals, per jurisdiction. Exactly one version is in force; a delivery already in flight keeps the version it was rendered under.",
      refresh: "Refresh",
      seedDraft: "Seed draft",
      versionCounts: (profiles: number, countries: number) =>
        `${profiles} profiles · ${countries} countries`,
      noVersions:
        "No policy version exists yet. Seeding one creates a draft; nothing is sent under it until it is activated.",
      fields: {
        created: "Created",
        activated: "Activated",
        superseded: "Superseded",
        approvedBy: "Approved by",
      },
      reasonLabel: "Why this version is being activated",
      reasonHelp:
        "Activation needs a second administrator’s approval. The first submission records the request; the change lands when the approval is granted and the request is repeated.",
      activate: "Activate",
      profile: {
        subjectPrefix: "Subject prefix",
        footerBlocks: "Footer blocks",
        unsubscribeCopy: "Unsubscribe copy",
        businessDays: (days: number) => `${days} business days`,
        processedImmediately: " (processed immediately)",
        consentNotice: "Consent notice",
        everyMonths: (months: number) => `every ${months} months`,
        noDuty: "no duty",
        quietHours: "Quiet hours",
        countries: "Countries",
        fallback: "— (fallback)",
        sources: "Sources and confirmation dates",
      },
      nothingSelected: "Nothing selected.",
      toast: {
        loadFailed: "Could not load jurisdiction policy versions.",
        approvalRecorded:
          "Recorded. A second administrator has to approve this in the work queue before it takes effect.",
        refused: "The request was refused.",
        draftCreated: "Draft created. It changes nothing until it is activated.",
        draftExists: "That draft already exists.",
        draftFailed: "Could not create the draft.",
        activated: "Activated. The previous version is now superseded.",
        activateFailed: "Could not activate the version.",
      },
    },
    domains: {
      title: "Sending domains",
      intro:
        "Transactional and marketing mail send from separate domains so their reputations and DMARC policies are separate. That is the only layer that separates: the sending IP, the provider account and its suppression list are shared across every domain in the region.",
      transactional: "Transactional",
      marketing: "Marketing",
      notConfigured: "not configured",
      providerErrorSuffix:
        "Nothing below is a statement about the domains themselves — the provider was not reached, so this screen has no findings rather than findings derived from an empty list.",
      recordUnknown: "unknown",
      dmarcNotIssued: "not issued by the provider — check the zone",
      severity: {
        error: "Blocking",
        warning: "Outstanding",
        info: "Check by hand",
      },
      nothingToReport: "Nothing configured to report on.",
      blockingCount: (count: number) =>
        `${count} blocking finding${count === 1 ? "" : "s"}. `,
      readAt: (time: string) =>
        `Read at ${time} UTC. The DNS records themselves are added at the registrar; see docs/ops/email-sending-domains.md.`,
    },
  },
  ko: {
    eyebrow: "이메일",
    policy: {
      title: "관할권 정책",
      intro:
        "관할권별 제목 접두어, 푸터 블록, 수신 거부 문구, 야간 발송 제한, 동의 안내 주기입니다. 적용 중인 버전은 정확히 하나이며, 이미 발송 중인 delivery는 렌더링된 당시의 버전을 유지합니다.",
      refresh: "새로고침",
      seedDraft: "초안 생성",
      versionCounts: (profiles: number, countries: number) =>
        `프로필 ${profiles}개 · 국가 ${countries}개`,
      noVersions:
        "아직 정책 버전이 없습니다. 초안을 생성하면 draft가 만들어지며, 활성화되기 전에는 그 버전으로 아무것도 발송되지 않습니다.",
      fields: {
        created: "생성",
        activated: "활성화",
        superseded: "대체됨",
        approvedBy: "승인자",
      },
      reasonLabel: "이 버전을 활성화하는 이유",
      reasonHelp:
        "활성화에는 두 번째 관리자의 승인이 필요합니다. 첫 제출은 요청을 기록하고, 승인이 난 뒤 요청을 다시 보내면 변경이 적용됩니다.",
      activate: "활성화",
      profile: {
        subjectPrefix: "제목 접두어",
        footerBlocks: "푸터 블록",
        unsubscribeCopy: "수신 거부 문구",
        businessDays: (days: number) => `영업일 ${days}일`,
        processedImmediately: " (즉시 처리)",
        consentNotice: "동의 안내",
        everyMonths: (months: number) => `${months}개월마다`,
        noDuty: "의무 없음",
        quietHours: "야간 발송 제한",
        countries: "국가",
        fallback: "— (fallback)",
        sources: "출처와 확인 날짜",
      },
      nothingSelected: "선택된 버전이 없습니다.",
      toast: {
        loadFailed: "관할권 정책 버전을 불러오지 못했습니다.",
        approvalRecorded:
          "기록되었습니다. 적용되려면 두 번째 관리자가 작업 대기열에서 승인해야 합니다.",
        refused: "요청이 거절되었습니다.",
        draftCreated: "초안이 생성되었습니다. 활성화되기 전에는 아무것도 바뀌지 않습니다.",
        draftExists: "해당 초안이 이미 있습니다.",
        draftFailed: "초안을 생성하지 못했습니다.",
        activated: "활성화되었습니다. 이전 버전은 이제 대체(superseded) 상태입니다.",
        activateFailed: "버전을 활성화하지 못했습니다.",
      },
    },
    domains: {
      title: "발송 도메인",
      intro:
        "transactional 메일과 marketing 메일은 평판과 DMARC 정책을 분리하기 위해 서로 다른 도메인에서 발송합니다. 분리되는 계층은 이것뿐입니다: 발송 IP, 공급자 계정, 그리고 그 계정의 수신 차단 목록은 region 안의 모든 도메인이 공유합니다.",
      transactional: "Transactional",
      marketing: "Marketing",
      notConfigured: "설정 안 됨",
      providerErrorSuffix:
        "아래 내용은 도메인 자체에 대한 판단이 아닙니다 — 공급자에 연결하지 못했으므로, 이 화면은 빈 목록에서 끌어낸 결과가 아니라 결과 없음으로 표시합니다.",
      recordUnknown: "알 수 없음",
      dmarcNotIssued: "공급자가 발급하지 않음 — zone에서 확인하세요",
      severity: {
        error: "차단",
        warning: "미해결",
        info: "수동 확인",
      },
      nothingToReport: "보고할 설정이 없습니다.",
      blockingCount: (count: number) => `차단 항목 ${count}건. `,
      readAt: (time: string) =>
        `${time} UTC에 읽었습니다. DNS 레코드 자체는 도메인 등록 기관에서 추가합니다. docs/ops/email-sending-domains.md를 참고하세요.`,
    },
  },
});
