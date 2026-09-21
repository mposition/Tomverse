import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the read-only Marketing console (docs/policy/marketing-automation.md §6.1). */
export const adminMarketingMessages = defineAdminMessages({
  en: {
    loadFailed: "Could not load marketing data.",
    loading: "Loading",
    empty: "Nothing here yet.",
    showing: "Newest {count} of this section, not a total.",
    readOnly:
      "Read only. Approving, pausing and publishing arrive with the next slice.",
    unavailableS4:
      "Comment monitoring is built in stage S4. Nothing writes this section yet, so it is empty because it is unbuilt rather than because nothing is waiting.",
    unavailableS5:
      "Landing experiments are built in stage S5. Nothing writes this section yet, so it is empty because it is unbuilt rather than because nothing is waiting.",
    queueTitle: "Drafts waiting on a person",
    queueDescription:
      "What the Guard sent to a human, with the codes it gave and the words it read.",
    publishedTitle: "Published posts",
    publishedDescription:
      "Where each post went, and whether it was confirmed publicly visible.",
    accountsTitle: "Brand accounts",
    accountsDescription:
      "Mode, caps and, for a paused account, the reason code that paused it.",
    reportsTitle: "Reports",
    reportsDescription:
      "Weekly summaries, competitor facts and retention runs, by period.",
    colAccount: "Account",
    colLocale: "Locale",
    colStatus: "Status",
    colMode: "Mode",
    colVerdict: "Guard",
    colText: "Text",
    colExpires: "Approval expires",
    colCreated: "Created",
    colUrl: "Link",
    colPublished: "Published",
    colVerified: "Verified public",
    colCaps: "Caps (day/week)",
    colPaused: "Paused",
    colKind: "Kind",
    colPeriod: "Period",
    noCap: "policy default",
    notPaused: "no",
    none: "-",
  },
  ko: {
    loadFailed: "마케팅 데이터를 불러오지 못했습니다.",
    loading: "불러오는 중",
    empty: "아직 아무것도 없습니다.",
    showing: "이 구획의 최신 {count}건이며 전체 수가 아닙니다.",
    readOnly: "읽기 전용입니다. 승인·정지·게시는 다음 슬라이스에서 들어옵니다.",
    unavailableS4:
      "댓글 모니터링은 S4 단계에서 만듭니다. 아직 이 구획에 쓰는 것이 없으므로, 기다리는 일이 없어서가 아니라 아직 만들지 않아서 비어 있습니다.",
    unavailableS5:
      "랜딩 실험은 S5 단계에서 만듭니다. 아직 이 구획에 쓰는 것이 없으므로, 기다리는 일이 없어서가 아니라 아직 만들지 않아서 비어 있습니다.",
    queueTitle: "사람을 기다리는 초안",
    queueDescription: "Guard가 사람에게 보낸 것과, 그때 준 코드와 읽은 문장입니다.",
    publishedTitle: "게시된 글",
    publishedDescription: "각 글이 어디로 갔고 공개로 확인됐는지입니다.",
    accountsTitle: "브랜드 계정",
    accountsDescription: "모드와 상한, 정지된 계정은 정지시킨 사유 코드입니다.",
    reportsTitle: "보고서",
    reportsDescription: "주간 요약, 경쟁사 사실, 보존 실행 기록을 기간별로 봅니다.",
    colAccount: "계정",
    colLocale: "언어",
    colStatus: "상태",
    colMode: "모드",
    colVerdict: "Guard",
    colText: "문장",
    colExpires: "승인 만료",
    colCreated: "생성",
    colUrl: "링크",
    colPublished: "게시",
    colVerified: "공개 확인",
    colCaps: "상한(일/주)",
    colPaused: "정지",
    colKind: "종류",
    colPeriod: "기간",
    noCap: "정책 기본값",
    notPaused: "아니오",
    none: "-",
  },
});
