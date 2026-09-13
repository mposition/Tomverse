import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the campaign list and the wave schedule. */
export const adminEmailCampaignsMessages = defineAdminMessages({
  en: {
    eyebrow: "Email",
    list: {
      title: "Campaigns",
      intro:
        "Every campaign this console knows about, newest first. A campaign is a set of waves over one piece of copy; approving it is where a person reads that copy, and it is the only two-person action here.",
      draftingBefore: (limit: number) =>
        `Showing the newest ${limit}. Drafting a campaign is done through`,
      draftingAfter:
        "— the audience spec is a document the expansion layer owns, and a free-text box for it here would be a worse editor than the request that already validates it.",
      empty: "No campaigns have been drafted.",
      columns: {
        campaign: "Campaign",
        status: "Status",
        trigger: "Trigger",
        languages: "Languages",
        waves: "Waves",
        nextDue: "Next due",
        drafted: "Drafted",
      },
      promisesTransition: "Promises an automatic transition",
      approvedAt: (when: string) => `approved ${when}`,
      overdue: (count: number) => `${count} overdue`,
    },
    schedule: {
      title: "Wave schedule",
      intro:
        "Waves that have a time, across every campaign. Waves an operator starts by hand have no time and are not listed here — they are not late and never will be.",
      showingSoonest: (limit: number) => `Showing the ${limit} soonest.`,
      columns: {
        due: "Due",
        campaign: "Campaign",
        wave: "Wave",
        status: "Status",
        trigger: "Trigger",
        expanded: "Expanded",
      },
      campaignStatus: (status: string) => `campaign ${status}`,
      dryRun: "dry run",
      cap: (cap: number) => ` / cap ${cap}`,
      overdueHeading: "Due and not sent",
      overdueClear: "Nothing is past its scheduled time.",
      overdueExplanationBefore:
        "The scheduler reached these and did not send them. Why is not stored on the wave: it is raised as a",
      overdueExplanationAfter:
        "incident, which goes to Sentry and the operational alert channels and not to any page in this console. Open the campaign to see what its send gate refuses now.",
      upcomingHeading: "Upcoming",
      upcomingEmpty: "Nothing is scheduled.",
    },
  },
  ko: {
    eyebrow: "이메일",
    list: {
      title: "캠페인",
      intro:
        "이 콘솔이 알고 있는 모든 캠페인을 최신순으로 표시합니다. 캠페인은 하나의 문안에 대한 wave 묶음입니다. 승인은 사람이 그 문안을 읽는 단계이며, 이 화면에서 유일하게 두 사람이 필요한 작업입니다.",
      draftingBefore: (limit: number) =>
        `최신 ${limit}개를 표시합니다. 캠페인 초안은`,
      draftingAfter:
        "요청으로 작성합니다. audience spec은 expansion 계층이 소유하는 문서이므로, 여기에 자유 입력란을 두면 이미 이를 검증하는 요청보다 못한 편집기가 됩니다.",
      empty: "작성된 캠페인이 없습니다.",
      columns: {
        campaign: "캠페인",
        status: "상태",
        trigger: "트리거",
        languages: "언어",
        waves: "Wave",
        nextDue: "다음 예정",
        drafted: "작성",
      },
      promisesTransition: "자동 전환을 약속함",
      approvedAt: (when: string) => `승인 ${when}`,
      overdue: (count: number) => `${count}건 지연`,
    },
    schedule: {
      title: "Wave 일정",
      intro:
        "모든 캠페인에서 예정 시각이 있는 wave입니다. 운영자가 수동으로 시작하는 wave는 시각이 없어 여기에 표시되지 않습니다. 그런 wave는 지연된 것이 아니며 앞으로도 지연되지 않습니다.",
      showingSoonest: (limit: number) => `가장 가까운 ${limit}개를 표시합니다.`,
      columns: {
        due: "예정",
        campaign: "캠페인",
        wave: "Wave",
        status: "상태",
        trigger: "트리거",
        expanded: "확장됨",
      },
      campaignStatus: (status: string) => `캠페인 ${status}`,
      dryRun: "dry run",
      cap: (cap: number) => ` / 상한 ${cap}`,
      overdueHeading: "예정 시각이 지났는데 발송되지 않음",
      overdueClear: "예정 시각을 넘긴 항목이 없습니다.",
      overdueExplanationBefore:
        "scheduler가 이 wave에 도달했지만 발송하지 않았습니다. 그 이유는 wave에 저장되지 않고",
      overdueExplanationAfter:
        "incident로 발생하며, 이는 Sentry와 운영 알림 채널로 가고 이 콘솔의 어떤 페이지에도 표시되지 않습니다. 캠페인을 열어 현재 send gate가 무엇을 거절하는지 확인하세요.",
      upcomingHeading: "예정",
      upcomingEmpty: "예정된 항목이 없습니다.",
    },
  },
});
