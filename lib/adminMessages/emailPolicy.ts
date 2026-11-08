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
      loadFailedDetail: "The policy versions could not be read, so nothing is shown. Try again.",
      status: { active: "In force", draft: "Draft, waiting for approval", superseded: "Replaced" },
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
        "Activation is audited. The administrator who submits it activates the version, and the audit log records who did it and why.",
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
        inForce: "Version",
        techSummary: "prefix, footer, sources",
      },
      nothingSelected: "Nothing selected.",
      toast: {
        loadFailed: "Could not load jurisdiction policy versions.",
        refused: "The request was refused.",
        draftCreated: "Draft created. It changes nothing until it is activated.",
        draftExists: "That draft already exists.",
        draftFailed: "Could not create the draft.",
        activated: "Activated. The previous version is now superseded.",
        activateFailed: "Could not activate the version.",
      },
    },
    domains: {
      recordsTitle: "DNS records",
      recordsDescription:
        "Mail only stays out of spam when SPF, DKIM and DMARC are all in place. DMARC is not reported by the provider, so it is never shown as healthy here.",
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
        `Read at ${time}. The DNS records themselves are added at the registrar; see docs/ops/email-sending-domains.md.`,
    },
  },
  ko: {
    eyebrow: "이메일",
    policy: {
      title: "관할 정책",
      intro:
        "나라마다 다른 메일 규칙이에요. 제목 접두어, 푸터, 수신 거부 문구, 야간 발송 제한, 동의 안내 주기를 정해요. 적용 중인 버전은 하나뿐이고, 이미 보내는 중인 메일은 만들어질 때의 버전을 그대로 써요.",
      refresh: "새로고침",
      seedDraft: "초안 만들기",
      loadFailedDetail: "정책 버전을 읽지 못해서 아무것도 보여 주지 않았어요. 다시 시도해 주세요.",
      status: { active: "적용 중", draft: "초안, 승인 대기", superseded: "대체됨" },
      versionCounts: (profiles: number, countries: number) =>
        `프로필 ${profiles}개 · 국가 ${countries}개`,
      noVersions:
        "아직 정책 버전이 없어요. 초안을 만들어도 적용하기 전에는 그 버전으로 메일이 나가지 않아요.",
      fields: {
        created: "생성",
        activated: "활성화",
        superseded: "대체됨",
        approvedBy: "승인자",
      },
      reasonLabel: "이 버전을 적용하는 이유",
      reasonHelp:
        "적용은 감사 기록에 남아요. 제출한 관리자가 이 버전을 적용하고, 누가 왜 했는지 기록돼요.",
      activate: "적용하기",
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
        fallback: "— (그 밖의 나라)",
        sources: "출처와 확인 날짜",
        inForce: "적용 버전",
        techSummary: "제목 접두어, 푸터, 출처",
      },
      nothingSelected: "선택한 버전이 없어요.",
      toast: {
        loadFailed: "관할 정책 버전을 불러오지 못했어요.",
        refused: "요청이 거절됐어요.",
        draftCreated: "초안을 만들었어요. 적용하기 전에는 아무것도 바뀌지 않아요.",
        draftExists: "그 초안은 이미 있어요.",
        draftFailed: "초안을 만들지 못했어요.",
        activated: "적용했어요. 이전 버전은 이제 대체된 상태예요.",
        activateFailed: "버전을 적용하지 못했어요.",
      },
    },
    domains: {
      recordsTitle: "DNS 기록",
      recordsDescription:
        "메일이 스팸함에 가지 않으려면 SPF, DKIM, DMARC 세 가지가 모두 맞아야 해요. 공급자는 DMARC를 알려 주지 않아서, 여기서는 DMARC를 정상으로 보여 주지 않아요.",
      title: "발송 도메인",
      intro:
        "서비스 메일과 마케팅 메일은 평판과 DMARC 정책을 따로 두려고 서로 다른 도메인에서 보내요. 나뉘는 건 이것뿐이에요. 발송 IP, 공급자 계정, 수신 차단 목록은 같은 지역의 모든 도메인이 함께 써요.",
      transactional: "Transactional",
      marketing: "Marketing",
      notConfigured: "설정 안 됨",
      providerErrorSuffix:
        "아래는 도메인 자체에 대한 판단이 아니에요. 공급자에 연결하지 못해서, 빈 목록에서 결과를 짐작하지 않고 결과 없음으로 보여 줘요.",
      recordUnknown: "알 수 없음",
      dmarcNotIssued: "공급자가 알려 주지 않아요. DNS 영역에서 직접 확인해 주세요",
      severity: {
        error: "차단",
        warning: "미해결",
        info: "수동 확인",
      },
      nothingToReport: "알려 드릴 설정이 없어요.",
      blockingCount: (count: number) => `차단 항목 ${count}건. `,
      readAt: (time: string) =>
        `${time}에 읽었어요. DNS 기록은 도메인 등록 기관에서 추가해요. 방법은 docs/ops/email-sending-domains.md에 있어요.`,
    },
  },
});
