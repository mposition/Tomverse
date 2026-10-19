import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Admin "개선 제안 (Scout)" section (docs/policy/product-research-agent.md §10). */
export const adminProductResearchScoutMessages = defineAdminMessages({
  en: {
    heading: "Improvement suggestions (Scout)",
    intro:
      "Each day the Scout looks at the public pages, generated files and the model catalogue, and a model suggests what to improve. Dismiss what is not worth doing; send the rest to AMUX as an idea.",
    disabled: "The Scout is switched off here. No suggestions are being collected.",
    modelOff: "No model is set for the Scout, so pages are collected but not judged.",
    counts: "Open {open} · dismissed {dismissed} · sent to AMUX {sent}",
    empty: "No open suggestions.",
    subject: "Where",
    evidence: "What it saw",
    suggestion: "Suggested change",
    dismiss: "Dismiss",
    send: "Send to AMUX",
    sending: "Sending…",
    dismissing: "Dismissing…",
    sent: "Sent to AMUX as idea {ideaId}.",
    dismissed: "Dismissed.",
    dismissNotAllowed: "Only an owner or ops administrator can dismiss.",
    sendNotAllowed: "Only an owner can send an idea to AMUX.",
    failed: "The action did not complete.",
    severity: { high: "High", medium: "Medium", low: "Low" },
  },
  ko: {
    heading: "개선 제안 (Scout)",
    intro:
      "Scout가 매일 공개 페이지, 생성 파일, 모델 카탈로그를 살펴보고 모델이 개선할 점을 제안합니다. 할 가치가 없는 것은 거절하고, 나머지는 AMUX 아이디어로 보냅니다.",
    disabled: "이 환경에서는 Scout가 꺼져 있습니다. 제안을 모으지 않습니다.",
    modelOff: "Scout에 지정된 모델이 없어 화면은 모으지만 판정하지 않습니다.",
    counts: "열림 {open} · 거절 {dismissed} · AMUX로 보냄 {sent}",
    empty: "열린 제안이 없습니다.",
    subject: "대상",
    evidence: "근거",
    suggestion: "제안",
    dismiss: "거절",
    send: "AMUX로 보내기",
    sending: "보내는 중…",
    dismissing: "거절하는 중…",
    sent: "AMUX 아이디어 {ideaId}로 보냈습니다.",
    dismissed: "거절했습니다.",
    dismissNotAllowed: "owner 또는 ops 관리자만 거절할 수 있습니다.",
    sendNotAllowed: "owner만 AMUX로 보낼 수 있습니다.",
    failed: "작업을 마치지 못했습니다.",
    severity: { high: "높음", medium: "보통", low: "낮음" },
  },
});
