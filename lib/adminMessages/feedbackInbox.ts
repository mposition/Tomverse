import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the feedback inbox on the Support page and its closing dialog. */
export const adminFeedbackInboxMessages = defineAdminMessages({
  en: {
    verification: {
      verified: "Verified server error (signed token)",
      clientEmptyResponse: "Client-classified EMPTY_RESPONSE — server token not issued",
      missingToken: "Unverified — no server token",
      expired: "Unverified — token expired",
      invalidSignature: "Unverified — invalid token signature",
      payloadMismatch: "Unverified — token does not match this trace",
      unsupportedVersion: "Unverified — unsupported token version",
      untrustedTraceSource: "Unverified — client-supplied trace",
      manualTrace: "Unverified — manual trace",
    },
    evidence: {
      recorded: "Evidence recorded",
      intentionallyNotRecorded: "No evidence row by policy",
      existingLimitEvent: "See existing limit-decision events for this trace",
      existingProviderEvent: "See existing provider events for this trace",
      notYetAvailable: "Evidence row not found (write pending, capped or failed)",
      ambiguousTrace: "Multiple occurrences share this trace — no exact link",
    },
    notification: {
      delivered: " The reply was accepted by the mail provider.",
      queued: " Reply queued; delivery will be retried.",
      alreadyNotified: " This stage was already announced -- no new email.",
      noAddress: " Nothing was emailed: this report carries no address.",
      withheld:
        " Nothing was emailed: you closed this one without announcing it. Pressing the same status button again sends the reply.",
      notConsented: " Nothing was emailed: the reporter did not ask for progress notices.",
      noStage: " Nothing was emailed: this status announces nothing.",
    },
    replyDelivery: {
      label: "Reply email",
      accepted: (at: string) => `accepted by the mail provider ${at}`,
      resent: " (re-sent)",
      pending: (attempts: number) =>
        `not sent yet -- ${attempts} attempt(s), the queue is retrying`,
      abandoned: (reason: string) => `not delivered -- the queue gave up (${reason})`,
      none: "never queued",
      reasons: {
        contact_removed: "the address was removed",
        not_consented: "the reporter did not ask for this notice",
        source_missing: "the report or its record is gone",
        suppressed: "the address is suppressed",
      } as Record<string, string>,
      previewLabel: "This is what the email will say:",
      resend: "Send this reply now",
      resending: "Sending…",
      resendHint:
        "Sends the text above, once, exactly as it was recorded when the report was completed. To send anything else, use the mail app.",
      resendDone: "The reply was queued for delivery.",
      resendFailed: "The reply could not be queued.",
      resendRefused: {
        NO_ADDRESS: "This report has no address to answer.",
        NOT_COMPLETED: "This report has no completion record yet.",
        ALREADY_SENT: "This reply was already sent.",
        ALREADY_QUEUED: "This reply is already queued.",
        ALREADY_RESENT: "This reply was already re-sent once.",
      } as Record<string, string>,
    },
    statuses: {
      all: "all",
      open: "open",
      reviewing: "reviewing",
      resolved: "resolved",
      closed: "closed",
    },
    toast: {
      updated: (notificationSentence: string) =>
        `Feedback status updated.${notificationSentence}`,
      updateFailed: "Feedback update failed.",
      updateFailedFallback: "Failed to update feedback.",
      contextCopied: "Feedback context copied.",
      contextCopyFailed: "Could not copy feedback context.",
    },
    eyebrow: "Feedback",
    title: "Support inbox",
    description:
      "Review user feedback, copy reproduction context, and move issues through support states without leaving the Admin console.",
    rowLimit: (limit: number) =>
      ` Showing the ${limit} most recent reports; the counters below describe those reports, not every report ever filed.`,
    openCount: (count: number) => `${count} open`,
    exportCsv: "Export CSV",
    searchPlaceholder: "Search email, trace ID, model, path, message...",
    empty: "No feedback matches the current filter.",
    emailUpdatesOn: "Email updates on",
    noEmailUpdates: "No email updates",
    guest: "guest",
    copyContext: "Copy context",
    reply: "Reply",
    reviewingEmailHint:
      "Moving this report to reviewing (or closing it) emails the reporter a status update.",
    meta: {
      trace: (value: string) => `Trace: ${value}`,
      model: (value: string) => `Model: ${value}`,
      plan: (value: string) => `Plan: ${value}`,
      attachments: (count: number) => `Attachments: ${count}`,
      path: (value: string) => `Path: ${value}`,
      userAgent: (value: string) => `UA: ${value}`,
    },
    traceSource: "Trace source: ",
    traceSourceAuthenticated: "server_generated (authenticated)",
    traceSourceClaim: (provenance: string) => `${provenance} (client claim)`,
    clientCode: (code: string) => `Client-classified code: ${code}`,
    shadowDiagnosis: "Shadow diagnosis (observation only, no auto-fix): ",
    autoFixStage: "Auto-fix: ",
    autoFixDraft: {
      ready:
        "The fix for this report was observed live in production. A reply draft is ready; nothing has been sent to the reporter.",
      use: "Reply with the draft and resolve",
      review: "Review the fix",
      sendAndResolve: "Send reply and mark resolved",
      resolveOnly: "Mark resolved",
    },
    evidenceRow: {
      serverCode: (code: string, source: string) => `Server code: ${code} (${source})`,
      route: (routeClass: string) => `Route: ${routeClass}`,
      release: (release: string, environment: string) => `Release: ${release} (${environment})`,
      provider: (provider: string, model: string) => `Provider: ${provider} / ${model}`,
      occurred: (at: string) => `Occurred: ${at}`,
      sentryEvent: (id: string) => `Sentry event: ${id}`,
    },
    dialog: {
      cancel: "Cancel",
      label: (status: string) => `Close feedback as ${status}`,
      title: (status: string) => `Mark as ${status}`,
      alreadyCompleted:
        "This report's completion email has already been raised once. It is raised only for the first closure, so no new email will go out.",
      willEmail:
        "The reporter opted into email updates. Confirming sends the completion email previewed below.",
      noEmail: "This report carries no address. The status changes and nothing is emailed.",
      outcome: "Outcome",
      reply: "Reply to the reporter (optional, included in the email)",
      replyInternal: "Reply (kept as an internal record -- nothing is emailed)",
      willSendTo: (address: string) =>
        `Pressing confirm emails this reply to ${address}.`,
      cannotSend: "Nothing will be emailed: this report carries no address. The reply is kept as an internal record.",
      confirmWithoutEmail: "Mark closed without emailing",
      withholdLabel: "Close this one without emailing the reporter",
      withholdHint:
        "Nothing is sent and nothing claims they were told, so pressing the same status button again still sends the reply.",
      withheld:
        "Nothing will be emailed. The report closes and the reply stays available to send later.",
      replyTooShort: (min: number) =>
        `A reply needs at least ${min} characters, or leave it empty.`,
      replyHint: (length: number, max: number) =>
        `Visible to the reporter. Never paste internal notes, trace IDs or diagnostics here. ${length}/${max}`,
      preview: (language: string) => `Email preview (${language})`,
      confirm: (status: string) => `Mark ${status}`,
    },
  },
  ko: {
    verification: {
      verified: "검증된 서버 오류 (서명된 token)",
      clientEmptyResponse: "클라이언트가 분류한 EMPTY_RESPONSE — 서버 token 미발급",
      missingToken: "미검증 — 서버 token 없음",
      expired: "미검증 — token 만료",
      invalidSignature: "미검증 — token 서명 불일치",
      payloadMismatch: "미검증 — token이 이 trace와 일치하지 않음",
      unsupportedVersion: "미검증 — 지원하지 않는 token 버전",
      untrustedTraceSource: "미검증 — 클라이언트가 제공한 trace",
      manualTrace: "미검증 — 수동 입력 trace",
    },
    evidence: {
      recorded: "증거 기록됨",
      intentionallyNotRecorded: "정책상 증거 행 없음",
      existingLimitEvent: "이 trace의 기존 한도 판정 이벤트를 확인하세요",
      existingProviderEvent: "이 trace의 기존 공급자 이벤트를 확인하세요",
      notYetAvailable: "증거 행 없음 (쓰기 대기, 상한 도달 또는 실패)",
      ambiguousTrace: "여러 발생 건이 이 trace를 공유함 — 정확한 연결 없음",
    },
    notification: {
      delivered: " 답변이 메일 제공자에 접수되었습니다.",
      queued: " 답변을 대기열에 넣었습니다. 발송은 재시도됩니다.",
      alreadyNotified: " 이 단계는 이미 안내되어 새 이메일은 없습니다.",
      noAddress: " 이메일은 보내지 않았습니다. 이 신고에는 주소가 없습니다.",
      withheld:
        " 이메일은 보내지 않았습니다. 알리지 않고 닫았습니다. 같은 상태 버튼을 다시 누르면 그때 답변이 발송됩니다.",
      notConsented: " 이메일은 보내지 않았습니다. 신고자가 진행 알림을 요청하지 않았습니다.",
      noStage: " 이메일은 보내지 않았습니다. 이 상태는 안내 대상이 아닙니다.",
    },
    replyDelivery: {
      label: "답변 메일",
      accepted: (at: string) => `메일 제공자 접수됨 ${at}`,
      resent: " (다시 보냄)",
      pending: (attempts: number) => `아직 발송되지 않음 — ${attempts}회 시도, 재시도 중`,
      abandoned: (reason: string) => `전달되지 않음 — 큐가 포기했습니다 (${reason})`,
      none: "대기열에 넣은 적 없음",
      reasons: {
        contact_removed: "주소가 삭제됨",
        not_consented: "신고자가 이 안내를 요청하지 않음",
        source_missing: "신고 또는 기록이 사라짐",
        suppressed: "수신 차단된 주소",
      } as Record<string, string>,
      previewLabel: "메일에 들어갈 내용:",
      resend: "이 답변 지금 보내기",
      resending: "보내는 중…",
      resendHint:
        "위 내용을 완료 시점에 기록된 그대로 한 번 보냅니다. 다른 내용을 보내려면 메일 앱을 쓰세요.",
      resendDone: "답변을 발송 대기열에 넣었습니다.",
      resendFailed: "답변을 대기열에 넣지 못했습니다.",
      resendRefused: {
        NO_ADDRESS: "이 신고에는 답변할 주소가 없습니다.",
        NOT_COMPLETED: "이 신고에는 아직 완료 기록이 없습니다.",
        ALREADY_SENT: "이 답변은 이미 발송되었습니다.",
        ALREADY_QUEUED: "이 답변은 이미 대기열에 있습니다.",
        ALREADY_RESENT: "이 답변은 이미 한 번 다시 보냈습니다.",
      } as Record<string, string>,
    },
    statuses: {
      all: "전체",
      open: "접수",
      reviewing: "검토 중",
      resolved: "해결됨",
      closed: "종료",
    },
    toast: {
      updated: (notificationSentence: string) =>
        `피드백 상태를 업데이트했습니다.${notificationSentence}`,
      updateFailed: "피드백을 업데이트하지 못했습니다.",
      updateFailedFallback: "피드백을 업데이트하지 못했습니다.",
      contextCopied: "피드백 컨텍스트를 복사했습니다.",
      contextCopyFailed: "피드백 컨텍스트를 복사하지 못했습니다.",
    },
    eyebrow: "피드백",
    title: "고객 지원 수신함",
    description:
      "Admin 콘솔을 벗어나지 않고 사용자 피드백을 검토하고, 재현 컨텍스트를 복사하고, 이슈를 지원 상태별로 옮깁니다.",
    rowLimit: (limit: number) =>
      ` 최근 신고 ${limit}건만 표시합니다. 아래 카운터는 이 신고들에 대한 것이며, 지금까지 접수된 전체 신고가 아닙니다.`,
    openCount: (count: number) => `접수 ${count}건`,
    exportCsv: "CSV 내보내기",
    searchPlaceholder: "이메일, trace ID, 모델, 경로, 메시지 검색...",
    empty: "현재 필터에 맞는 피드백이 없습니다.",
    emailUpdatesOn: "이메일 알림 켜짐",
    noEmailUpdates: "이메일 알림 없음",
    guest: "게스트",
    copyContext: "컨텍스트 복사",
    reply: "답장",
    reviewingEmailHint:
      "이 신고를 검토 중으로 옮기거나 종료하면 신고자에게 상태 변경 이메일이 발송됩니다.",
    meta: {
      trace: (value: string) => `Trace: ${value}`,
      model: (value: string) => `모델: ${value}`,
      plan: (value: string) => `플랜: ${value}`,
      attachments: (count: number) => `첨부: ${count}`,
      path: (value: string) => `경로: ${value}`,
      userAgent: (value: string) => `UA: ${value}`,
    },
    traceSource: "Trace 출처: ",
    traceSourceAuthenticated: "server_generated (인증됨)",
    traceSourceClaim: (provenance: string) => `${provenance} (클라이언트 주장)`,
    clientCode: (code: string) => `클라이언트 분류 코드: ${code}`,
    shadowDiagnosis: "Shadow 진단 (관찰 전용, 자동 수정 없음): ",
    autoFixStage: "자동 수정: ",
    autoFixDraft: {
      ready:
        "이 신고의 수정이 production에 반영된 것을 확인했습니다. 답변 초안이 준비되었고, 신고자에게는 아직 아무것도 보내지 않았습니다.",
      use: "초안으로 답변하고 해결됨 처리",
      review: "수정 내용 보기",
      sendAndResolve: "답변 보내고 해결됨으로 표시",
      resolveOnly: "해결됨으로 표시",
    },
    evidenceRow: {
      serverCode: (code: string, source: string) => `서버 코드: ${code} (${source})`,
      route: (routeClass: string) => `경로 분류: ${routeClass}`,
      release: (release: string, environment: string) => `릴리스: ${release} (${environment})`,
      provider: (provider: string, model: string) => `공급자: ${provider} / ${model}`,
      occurred: (at: string) => `발생 시각: ${at}`,
      sentryEvent: (id: string) => `Sentry 이벤트: ${id}`,
    },
    dialog: {
      cancel: "취소",
      label: (status: string) => `피드백을 ${status} 상태로 종료`,
      title: (status: string) => `${status} 상태로 표시`,
      alreadyCompleted:
        "이 신고의 완료 이메일은 이미 한 번 만들어졌습니다. 완료 이메일은 첫 종료 때만 만들어지므로 새 이메일은 나가지 않습니다.",
      willEmail:
        "신고자가 이메일 알림을 선택했습니다. 확인하면 아래 미리보기의 완료 이메일이 발송됩니다.",
      noEmail: "이 신고에는 주소가 없습니다. 아무것도 발송하지 않고 상태만 바뀝니다.",
      outcome: "처리 결과",
      reply: "신고자에게 보낼 답변 (선택, 이메일에 포함)",
      replyInternal: "답변 (내부 기록용 — 발송되지 않습니다)",
      willSendTo: (address: string) => `확인을 누르면 이 답변을 ${address}로 보냅니다.`,
      cannotSend: "이메일은 발송되지 않습니다. 이 신고에는 주소가 없습니다. 답변은 내부 기록으로만 남습니다.",
      confirmWithoutEmail: "발송 없이 종료 상태로 변경",
      withholdLabel: "이번에는 신고자에게 메일을 보내지 않고 닫기",
      withholdHint:
        "아무것도 보내지 않고, 안내했다고 기록하지도 않습니다. 나중에 같은 상태 버튼을 다시 누르면 그때 발송됩니다.",
      withheld:
        "이메일은 발송되지 않습니다. 신고는 닫히고, 답변은 나중에 보낼 수 있습니다.",

      replyTooShort: (min: number) =>
        `답변은 ${min}자 이상이어야 합니다. 아니면 비워 두세요.`,
      replyHint: (length: number, max: number) =>
        `신고자에게 보입니다. 내부 메모, trace ID, 진단 정보를 절대 붙여 넣지 마세요. ${length}/${max}`,
      preview: (language: string) => `이메일 미리보기 (${language})`,
      confirm: (status: string) => `${status} 상태로 변경`,
    },
  },
});
