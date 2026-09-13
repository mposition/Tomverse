import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for one campaign's page and the wave expansion ledger inside it. */
export const adminEmailCampaignDetailMessages = defineAdminMessages({
  en: {
    excluded: {
      no_email: "No address on the account",
      account_inactive: "Account inactive",
      suppressed: "Address suppressed",
      no_consent: "No consent for this purpose",
      plan_incompatible: "Replacement not available on their plan",
      already_changed: "No longer in any cohort",
    },
    cohort: {
      default_model: "Their default model",
      new_conversation_lead: "Lead of their new-conversation set",
      conversation_selection: "Selected in a conversation",
    },
    attestation: {
      differences_stated: "The copy states the capability and credit differences",
      staging_verified: "The migration was rehearsed on staging",
      reconciliation_ready: "The reconciliation script and its rollback are ready",
    },
    attestationAbout: {
      differences_stated:
        "About the body. Goes stale when the copy changes, because the reading no longer describes what would be sent.",
      staging_verified:
        "About the migration. A copy edit does not undo a rehearsal, so this does not expire with one.",
      reconciliation_ready: "About the script. A copy edit does not undo it either.",
    },
    toast: {
      loadFailed: "Could not load this campaign.",
      approvalRecorded:
        "Recorded. A second administrator has to approve this in the work queue before the campaign is approved.",
      refused: "The request was refused.",
      recorded: "Recorded.",
      withdrawn: "Withdrawn.",
      approved: "Approved.",
      started: "Started.",
      measured: "Measured.",
      cancelled: "Cancelled.",
    },
    loading: "Loading the campaign…",
    loadFailed: "This campaign could not be loaded.",
    refresh: "Refresh",
    fields: {
      status: "Status",
      trigger: "Trigger",
      languages: "Languages",
      effective: "Effective",
      noTimezone: "no timezone",
      models: "Models",
      estimatedRecipients: "Estimated recipients",
      notMeasured: "not measured",
      estimateValue: (
        recipients: number,
        when: string,
        by: string,
        version: number
      ) => `${recipients} — measured ${when} by ${by} (rules v${version})`,
      unknown: "unknown",
      workItem: "Work item",
      draftedBy: "Drafted by",
      approved: "Approved",
      notApproved: "not approved",
    },
    cancelledAt: (when: string, reason: string) => `Cancelled ${when}: ${reason}`,
    gates: {
      title: "What this campaign is waiting on",
      intro:
        "Asked of the server every time this page loads. A gate answered once is a gate that was true once — a replacement model can be disabled and a copy edit takes an attestation with it.",
      sendRefused: (refusal: string) => `Send refused: ${refusal}`,
      sendPasses: "The send gate passes",
      sendPassesDetail:
        "Nothing refuses this campaign right now. It is still re-asked at the moment each wave runs.",
      scheduleProblems: (count: number) => `${count} problem(s) with the schedule`,
      scheduleConsistent: "The schedule is consistent",
      transitionTitle: "This campaign promises an automatic transition",
      transitionMet: "Every condition for that promise is met.",
      transitionUnmet: (count: number) =>
        `${count} of the twelve conditions are unmet. The send is refused rather than quietly downgraded to the safe sentence — otherwise words nobody chose would go out and the operator would never learn the promise was not made.`,
    },
    attestations: {
      title: "Attestations",
      intro:
        "Three things no column can answer, so a person says them. Recorded with who and when — that is what makes an attestation worth more than a parameter somebody passed.",
      stale: (by: string, when: string) =>
        `${by} said this on ${when}, and the copy has changed since. It no longer describes what would be sent.`,
      satisfied: (by: string, when: string) => `${by} said this on ${when}.`,
      nobody: "Nobody has said this.",
      reattest: "Re-attest",
      attest: "I checked this",
      withdraw: "Withdraw",
    },
    approval: {
      title: "Approval",
      intro:
        "The only two-person action here, and the only place a person reads the copy. Drafting sends nothing; scheduling a wave sends nothing; running a wave carries out what was approved. Approving is what is reviewed.",
      localesBefore: "The request carries this campaign’s language list —",
      localesNone: "none",
      localesAfter:
        "— so an approval cannot be inherited by a campaign that has since changed which languages it sends in.",
      reasonLabel: "Why this may go out",
      reasonPlaceholder:
        "Read the copy in every language and confirmed the effective date",
      approve: "Approve this campaign",
    },
    waves: {
      title: "Waves",
      intro:
        "Listed in the order they are meant to happen, not the order they are scheduled — a reminder set before its announcement is a mistake, and a list sorted by time would render it as a correct-looking sequence.",
      empty: "No waves have been created for this campaign.",
      due: (when: string) => `due ${when}`,
      startedByHand: "started by hand",
      dryRun: " · dry run",
      cap: (cap: number) => ` · cap ${cap}`,
      expanded: (count: number) => ` · expanded ${count}`,
      startNow: "Start now",
    },
    estimate: {
      title: "How large is this?",
      intro:
        "Counted from the audience rules, not typed in. The number is who the notice would go to after exclusions — not everyone in the cohort, which would size the send on people it is about to decide not to write to.",
      gatesNothing:
        "This gates nothing. It exists so the size is knowable before anybody commits to it; a campaign still sends on the same conditions it did before.",
      absent: "Nobody has measured this audience.",
      atLeast: "at least ",
      headlineAfter: (distinctUsers: number) =>
        `would receive the notice, out of ${distinctUsers} people in the cohort.`,
      measured: (when: string, by: string, version: number) =>
        `Measured ${when} by ${by} under audience rules v${version}. The audience moves; a count is about the moment it was taken.`,
      truncated:
        "The scan stopped before the audience did, so every figure here is a floor rather than a total. The real audience is larger by an unknown amount.",
      autoMigratable: (count: number) =>
        `${count} of them could be moved automatically.`,
      malformed: (count: number) =>
        `${count} could not, because a stored value the parser cannot read is preserved rather than rewritten — promising those accounts an automatic change would be untrue.`,
      counting: "Counting…",
      measureAgain: "Measure again",
      measure: "Measure the audience",
    },
    audience: {
      title: "Who each wave reached",
      intro:
        "The expansion ledger, read back. Every person the expander considered is one row: either a delivery was written for them, or a reason was recorded for why it was not.",
      introMasked:
        "Counts first, and the people behind them on request. Each row holds the address it was written to, so the list follows the rule Email delivery follows: addresses are masked, and showing them is a deliberate act that is recorded.",
      empty: "No wave has expanded yet, so nobody has been considered.",
      considered: (count: number) => `${count} considered`,
      notExpanded: "This wave has not expanded.",
      dryRunWritten:
        "would have been written to — this was a dry run, so every one of those deliveries was skipped and nothing was sent.",
      written: "had a delivery row written.",
      whyInAudience: "Why they were in the audience",
      malformed: (count: number) =>
        `${count} of these people had a stored value the parser could not read. It was reported and left exactly as it was — nothing rewrote it — so the count is here rather than in a log nobody opens.`,
      hidePeople: "Hide the people",
      showPeople: "Show the people",
    },
    cancel: {
      title: "Cancel",
      intro: "Cancelling stops every wave that has not started.",
      editable:
        "This campaign can still be edited through the API; once it is approved, editing is refused and cancelling is how it is stopped.",
      notEditable:
        "This campaign can no longer be edited — an approval covers the copy it was given, so changing it afterwards is what this layer refuses. Cancel it and draft another.",
      reasonLabel: "Why",
      reasonPlaceholder: "The retirement date moved",
      cancel: "Cancel this campaign",
    },
    ledger: {
      loadFailed: "Could not read this wave's ledger.",
      loading: "Reading the ledger…",
      empty: "This wave has no ledger rows, so nobody has been considered for it yet.",
      showing: (count: number, hasMore: boolean, limit: number) =>
        `Showing ${count}${hasMore ? " of more" : ""} — up to ${limit} at a time, which is what one reveal covers.`,
      columns: {
        address: "Address",
        why: "Why they were in",
        outcome: "Outcome",
        locale: "Locale",
      },
      malformed: "unreadable stored value",
      noLongerInCohort: "No longer in any cohort",
      writtenDryRun: "A delivery row was written and skipped — dry run",
      written: "A delivery row was written",
      noDelivery: "No delivery row",
      firstPage: "First page",
      nextPage: "Next page",
      pagingNote:
        "A new page is a new set of rows, so any addresses shown here are dropped and revealing them again is a new entry in the log.",
    },
  },
  ko: {
    excluded: {
      no_email: "계정에 주소 없음",
      account_inactive: "비활성 계정",
      suppressed: "수신 차단된 주소",
      no_consent: "이 목적에 대한 동의 없음",
      plan_incompatible: "사용자 플랜에서 대체 모델을 쓸 수 없음",
      already_changed: "더 이상 어떤 cohort에도 속하지 않음",
    },
    cohort: {
      default_model: "사용자의 기본 모델",
      new_conversation_lead: "새 대화 기본 조합의 첫 모델",
      conversation_selection: "대화에서 선택된 모델",
    },
    attestation: {
      differences_stated: "문안이 기능 및 크레딧 차이를 명시함",
      staging_verified: "staging에서 마이그레이션을 리허설함",
      reconciliation_ready: "reconciliation script와 rollback이 준비됨",
    },
    attestationAbout: {
      differences_stated:
        "본문에 관한 확인입니다. 문안이 바뀌면 그 검토가 더 이상 발송될 내용을 설명하지 않으므로 stale 상태가 됩니다.",
      staging_verified:
        "마이그레이션에 관한 확인입니다. 문안을 고친다고 리허설이 무효가 되지 않으므로 문안 수정으로 만료되지 않습니다.",
      reconciliation_ready:
        "script에 관한 확인입니다. 이것도 문안 수정으로 무효가 되지 않습니다.",
    },
    toast: {
      loadFailed: "이 캠페인을 불러오지 못했습니다.",
      approvalRecorded:
        "기록되었습니다. 캠페인이 승인되려면 두 번째 관리자가 작업 대기열에서 승인해야 합니다.",
      refused: "요청이 거절되었습니다.",
      recorded: "기록되었습니다.",
      withdrawn: "철회되었습니다.",
      approved: "승인되었습니다.",
      started: "시작되었습니다.",
      measured: "측정되었습니다.",
      cancelled: "취소되었습니다.",
    },
    loading: "캠페인을 불러오는 중…",
    loadFailed: "이 캠페인을 불러올 수 없습니다.",
    refresh: "새로고침",
    fields: {
      status: "상태",
      trigger: "트리거",
      languages: "언어",
      effective: "적용 시각",
      noTimezone: "시간대 없음",
      models: "모델",
      estimatedRecipients: "예상 수신자",
      notMeasured: "측정 안 됨",
      estimateValue: (
        recipients: number,
        when: string,
        by: string,
        version: number
      ) => `${recipients}명 — ${when}에 ${by} 측정 (규칙 v${version})`,
      unknown: "알 수 없음",
      workItem: "작업 항목",
      draftedBy: "작성자",
      approved: "승인",
      notApproved: "승인 안 됨",
    },
    cancelledAt: (when: string, reason: string) => `${when} 취소됨: ${reason}`,
    gates: {
      title: "이 캠페인이 기다리는 것",
      intro:
        "이 페이지를 불러올 때마다 서버에 다시 묻습니다. 한 번 답한 gate는 한때 참이었던 gate일 뿐입니다 — 대체 모델은 비활성화될 수 있고, 문안을 수정하면 확인 기록 하나가 함께 무효가 됩니다.",
      sendRefused: (refusal: string) => `발송 거절: ${refusal}`,
      sendPasses: "send gate 통과",
      sendPassesDetail:
        "현재 이 캠페인을 거절하는 것이 없습니다. 각 wave가 실행되는 시점에 다시 확인합니다.",
      scheduleProblems: (count: number) => `일정 문제 ${count}건`,
      scheduleConsistent: "일정에 모순이 없습니다",
      transitionTitle: "이 캠페인은 자동 전환을 약속합니다",
      transitionMet: "그 약속의 모든 조건이 충족되었습니다.",
      transitionUnmet: (count: number) =>
        `12개 조건 중 ${count}개가 충족되지 않았습니다. 발송은 안전한 문장으로 조용히 낮춰지지 않고 거절됩니다 — 그렇지 않으면 아무도 고르지 않은 문장이 나가고, 운영자는 약속이 빠졌다는 사실을 끝내 알지 못합니다.`,
    },
    attestations: {
      title: "확인 기록",
      intro:
        "어떤 컬럼도 답할 수 없는 세 가지라서 사람이 확인합니다. 누가 언제 확인했는지 함께 기록되며, 그것이 확인 기록을 누군가 넘긴 파라미터보다 가치 있게 만듭니다.",
      stale: (by: string, when: string) =>
        `${by}이(가) ${when}에 확인했지만 이후 문안이 바뀌었습니다. 더 이상 발송될 내용을 설명하지 않습니다.`,
      satisfied: (by: string, when: string) => `${by}이(가) ${when}에 확인했습니다.`,
      nobody: "아직 아무도 확인하지 않았습니다.",
      reattest: "다시 확인",
      attest: "확인했습니다",
      withdraw: "철회",
    },
    approval: {
      title: "승인",
      intro:
        "이 화면에서 유일하게 두 사람이 필요한 작업이며, 사람이 문안을 읽는 유일한 단계입니다. 초안 작성도, wave 예약도 아무것도 발송하지 않습니다. wave 실행은 승인된 내용을 수행할 뿐입니다. 검토 대상은 승인입니다.",
      localesBefore: "요청에는 이 캠페인의 언어 목록이 함께 전달됩니다 —",
      localesNone: "없음",
      localesAfter:
        "— 따라서 이후 발송 언어가 바뀐 캠페인이 이전 승인을 물려받을 수 없습니다.",
      reasonLabel: "발송해도 되는 이유",
      reasonPlaceholder: "모든 언어의 문안을 읽고 적용 날짜를 확인함",
      approve: "이 캠페인 승인",
    },
    waves: {
      title: "Wave",
      intro:
        "예약된 시각 순서가 아니라 실행되어야 할 순서로 나열합니다 — 공지보다 앞에 예약된 리마인더는 실수이며, 시각순으로 정렬하면 그것이 올바른 순서처럼 보입니다.",
      empty: "이 캠페인에 생성된 wave가 없습니다.",
      due: (when: string) => `예정 ${when}`,
      startedByHand: "수동 시작",
      dryRun: " · dry run",
      cap: (cap: number) => ` · 상한 ${cap}`,
      expanded: (count: number) => ` · 확장 ${count}`,
      startNow: "지금 시작",
    },
    estimate: {
      title: "규모는 얼마나 됩니까?",
      intro:
        "직접 입력한 값이 아니라 audience 규칙으로 센 값입니다. 이 숫자는 제외 후 안내를 받게 될 사람 수이며, cohort 전체가 아닙니다 — cohort 전체로 잡으면 곧 보내지 않기로 결정할 사람까지 발송 규모에 포함됩니다.",
      gatesNothing:
        "이 값은 아무것도 막지 않습니다. 누군가 결정하기 전에 규모를 알 수 있게 하려는 것이며, 캠페인은 이전과 같은 조건으로 발송됩니다.",
      absent: "아직 아무도 이 audience를 측정하지 않았습니다.",
      atLeast: "최소 ",
      headlineAfter: (distinctUsers: number) =>
        `명이 안내를 받게 됩니다 (cohort 전체 ${distinctUsers}명 중).`,
      measured: (when: string, by: string, version: number) =>
        `${when}에 ${by}이(가) audience 규칙 v${version}로 측정했습니다. audience는 변하며, 수치는 측정한 시점의 값입니다.`,
      truncated:
        "스캔이 audience 끝까지 가기 전에 멈췄으므로 여기의 모든 수치는 합계가 아니라 하한입니다. 실제 audience는 알 수 없는 만큼 더 큽니다.",
      autoMigratable: (count: number) => `그중 ${count}명은 자동으로 옮길 수 있습니다.`,
      malformed: (count: number) =>
        `${count}명은 옮길 수 없습니다. parser가 읽을 수 없는 저장값은 다시 쓰지 않고 보존하므로, 그 계정들에 자동 변경을 약속하면 사실이 아니게 됩니다.`,
      counting: "세는 중…",
      measureAgain: "다시 측정",
      measure: "audience 측정",
    },
    audience: {
      title: "각 wave가 도달한 사람",
      intro:
        "expansion ledger를 다시 읽은 것입니다. expander가 검토한 사람 한 명이 한 행이며, 그 사람에게 delivery가 기록되었거나 기록되지 않은 이유가 남아 있습니다.",
      introMasked:
        "수치를 먼저 보여 주고, 그 뒤의 사람은 요청할 때 보여 줍니다. 각 행에는 기록 당시의 주소가 들어 있으므로, 이 목록은 이메일 전송 화면과 같은 규칙을 따릅니다: 주소는 마스킹되며, 표시하는 것은 기록되는 의도적인 행위입니다.",
      empty: "아직 확장된 wave가 없어 검토된 사람이 없습니다.",
      considered: (count: number) => `${count}명 검토됨`,
      notExpanded: "이 wave는 확장되지 않았습니다.",
      dryRunWritten:
        "명에게 기록될 예정이었습니다 — dry run이었으므로 해당 delivery는 모두 skipped 처리되었고 아무것도 발송되지 않았습니다.",
      written: "명에게 delivery 행이 기록되었습니다.",
      whyInAudience: "audience에 포함된 이유",
      malformed: (count: number) =>
        `이 중 ${count}명은 parser가 읽을 수 없는 저장값을 가지고 있었습니다. 보고된 뒤 그대로 두었고 아무것도 다시 쓰지 않았으므로, 아무도 열지 않는 로그가 아니라 여기에 수치를 표시합니다.`,
      hidePeople: "사람 목록 숨기기",
      showPeople: "사람 목록 보기",
    },
    cancel: {
      title: "취소",
      intro: "취소하면 시작되지 않은 모든 wave가 중단됩니다.",
      editable:
        "이 캠페인은 아직 API로 편집할 수 있습니다. 승인된 뒤에는 편집이 거절되며, 취소가 캠페인을 멈추는 방법입니다.",
      notEditable:
        "이 캠페인은 더 이상 편집할 수 없습니다 — 승인은 당시 주어진 문안에 대한 것이므로, 이후 변경은 이 계층이 거절합니다. 취소하고 새로 작성하세요.",
      reasonLabel: "사유",
      reasonPlaceholder: "은퇴 날짜가 변경됨",
      cancel: "이 캠페인 취소",
    },
    ledger: {
      loadFailed: "이 wave의 ledger를 읽지 못했습니다.",
      loading: "ledger를 읽는 중…",
      empty: "이 wave에는 ledger 행이 없어 아직 아무도 검토되지 않았습니다.",
      showing: (count: number, hasMore: boolean, limit: number) =>
        `${count}행 표시${hasMore ? " (더 있음)" : ""} — 한 번에 최대 ${limit}행이며, 이는 한 번의 주소 표시가 다루는 범위입니다.`,
      columns: {
        address: "주소",
        why: "포함된 이유",
        outcome: "결과",
        locale: "로케일",
      },
      malformed: "읽을 수 없는 저장값",
      noLongerInCohort: "더 이상 어떤 cohort에도 속하지 않음",
      writtenDryRun: "delivery 행이 기록되고 skipped 처리됨 — dry run",
      written: "delivery 행이 기록됨",
      noDelivery: "delivery 행 없음",
      firstPage: "첫 페이지",
      nextPage: "다음 페이지",
      pagingNote:
        "새 페이지는 새로운 행 집합이므로, 여기 표시된 주소는 모두 사라지고 다시 표시하면 로그에 새 항목이 남습니다.",
    },
  },
});
