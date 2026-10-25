/** Framework-free copy for the native current-location control. */
const en = {
  "disable": "Turn off current location",
  "location": "Current location",
  "locationNote": "While on, share your approximate location with AI providers on each message. Used when relevant. No background tracking.",
  "reading": "Reading current location…",
  "denied": "Location permission denied. Allow it in device settings, then try again.",
  "timeout": "Location timed out. Continuing without location.",
  "unavailable": "Location unavailable. You can enter a place instead.",
  "locationOn": "Current location on · refreshed with each message"
};

const ko: typeof en = {
  "disable": "현재 위치 사용 끄기",
  "location": "현재 위치",
  "locationNote": "켜져 있는 동안 메시지를 보낼 때마다 대략적인 위치를 AI 제공자에게 전달하고 관련 답변에 사용합니다. 백그라운드에서는 추적하지 않습니다.",
  "reading": "현재 위치 확인 중…",
  "denied": "위치 권한이 거부되었습니다. 기기 설정에서 허용한 뒤 다시 시도해 주세요.",
  "timeout": "위치 확인 시간이 초과되어 위치 없이 대화를 계속합니다.",
  "unavailable": "위치를 확인할 수 없습니다. 장소를 직접 입력해도 됩니다.",
  "locationOn": "현재 위치 사용 중 · 메시지마다 새로 확인"
};

export const mobileChatCopy = (language: string) => language.toLowerCase().startsWith("ko") ? ko : en;
