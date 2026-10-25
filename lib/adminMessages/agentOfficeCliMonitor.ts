import { defineAdminMessages } from "@/lib/adminLocale";

export const adminAgentOfficeCliMessages = defineAdminMessages({
  en: {
    open: "View CLI", title: "CLI monitor", readOnly: "Read only", room: "AMUX execution / Codex CLI",
    live: "Live", stale: "Reconnecting", unavailable: "Capture unavailable", loading: "Connecting to CLI output…",
    noCapture: "This worker's CLI output is not connected yet. Its operating status is still shown in the office.",
    empty: "No conversation has been captured for the current session.",
    session: "CLI session", current: "Current session", transcript: "Transcript", raw: "Raw output",
    find: "Find in log", pause: "Pause updates", resume: "Resume updates", paused: "Updates paused",
    following: "Following live output", followPaused: "Auto-follow paused", latest: "Jump to latest", expand: "Expand monitor", collapse: "Collapse monitor",
    close: "Close CLI monitor", footer: "View only. Commands cannot be sent from this panel.",
    masking: "Sensitive output is masked where detected. Current session only; no transcript is saved to disk.",
    captured: "Captured", truncated: "Showing a bounded excerpt of the latest output.",
    failed: "CLI output could not be refreshed. Previously captured output may be out of date.", retry: "Retry",
    labels: { prompt: "PROMPT", assistant: "AGENT", tool: "TOOL", output: "OUTPUT" },
  },
  ko: {
    open: "CLI 보기", title: "CLI 모니터", readOnly: "읽기 전용", room: "AMUX 실행 / Codex CLI",
    live: "실시간", stale: "다시 연결 중", unavailable: "출력 연결 없음", loading: "CLI 출력에 연결하는 중…",
    noCapture: "이 worker의 CLI 출력이 아직 연결되지 않았습니다. 운영 상태는 오피스에서 계속 확인할 수 있습니다.",
    empty: "현재 세션에서 수집된 대화가 없습니다.",
    session: "CLI 세션", current: "현재 세션", transcript: "대화 기록", raw: "원시 출력",
    find: "출력에서 찾기", pause: "갱신 일시정지", resume: "갱신 재개", paused: "화면 갱신 일시정지됨",
    following: "최신 출력 따라가는 중", followPaused: "자동 스크롤 일시정지됨", latest: "최신 출력으로", expand: "모니터 확대", collapse: "모니터 축소",
    close: "CLI 모니터 닫기", footer: "읽기 전용입니다. 이 패널에서는 명령을 전송할 수 없습니다.",
    masking: "감지된 민감정보는 가립니다. 현재 세션만 표시하며 대화는 디스크에 저장하지 않습니다.",
    captured: "수집 시각", truncated: "최근 출력 중 크기 제한 안의 내용만 표시합니다.",
    failed: "CLI 출력을 갱신하지 못했습니다. 기존 출력이 최신 상태가 아닐 수 있습니다.", retry: "다시 시도",
    labels: { prompt: "프롬프트", assistant: "에이전트", tool: "도구", output: "출력" },
  },
});
