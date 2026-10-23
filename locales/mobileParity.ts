import type { MobileLanguage } from "./mobile";

const en = {
  settings: "Settings", general: "General", intelligence: "AI & personalization", security: "Device security", privacy: "Privacy & data",
  saved: "Saved", save: "Save changes", unavailable: "This feature is not available on the current server. Your conversation is unchanged.",
  timeZone: "Account time zone", timeZoneHint: "The account time zone controls daily limits. Changes follow the existing 30-day rule.",
  defaultModel: "Default manual model", autoHint: "New Chat conversations start with Smart Adaptive when available. This model applies to manual selection.",
  imageAuto: "Generate images after choosing the image action", memory: "Memory", memoryStyle: "Personalize writing style", memoryDefault: "Memory for new conversations",
  on: "On", off: "Off", inherit: "Account default", deviceLock: "Require device authentication", deviceHint: "Use the device’s fingerprint, Face ID, PIN, pattern or passcode. Tomverse never receives your biometric data or device code. It locks after restarting the app or 30 seconds in the background.",
  deviceUnavailable: "Set up a screen lock or biometrics in device settings first.", deviceCancelled: "Authentication was cancelled or failed. Try unlocking again.", unlock: "Unlock Tomverse", locked: "Your conversations are locked", unlockHint: "Verify with your device to continue.",
  tools: "Message tools", files: "Choose files", photos: "Choose photos", filePrivacy: "Only files you select are shared. Tomverse cannot browse your storage.",
  search: "Web search", searchHint: "Search the web for this conversation", assistant: "Assistant", noAssistant: "Default assistant", clearAssistant: "Remove assistant", selected: "Selected",
  imageFailed: "The image could not be loaded.", imageLoading: "Loading image…", retry: "Try again", openImage: "Open image", copy: "Copy", copied: "Copied", copyFailed: "Copy failed",
  uploadFailed: "The file could not be uploaded. Check your connection and select it again.",
  review: "Compare perspectives", easy: "Choose providers. Tomverse selects a model for each question.", professional: "Choose the exact models to compare.",
  models: "Models", providers: "Providers", results: "Results", write: "Write", history: "History", newReview: "New Review", reviewEmpty: "One question. More perspectives.",
  choose: "Choose participants", noParticipants: "Select at least one model or provider.", reviewUnavailable: "Review requires the updated mobile server integration.",
  imageDecision: "This question needs image generation. Review image generation requires a separate price confirmation.",
};
const ko: typeof en = {
  settings: "설정", general: "일반", intelligence: "AI 및 개인화", security: "기기 보안", privacy: "개인정보 및 데이터",
  saved: "저장했습니다", save: "변경사항 저장", unavailable: "현재 서버에서 지원하지 않는 기능입니다. 대화는 변경되지 않았습니다.",
  timeZone: "계정 시간대", timeZoneHint: "계정 시간대는 일일 사용 한도에 적용됩니다. 기존 30일 변경 제한이 유지됩니다.",
  defaultModel: "기본 수동 모델", autoHint: "새 Chat은 사용 가능한 경우 Smart Adaptive로 시작합니다. 이 모델은 수동 선택에 적용됩니다.",
  imageAuto: "이미지 동작을 선택한 뒤 바로 생성", memory: "메모리", memoryStyle: "작성 스타일 개인화", memoryDefault: "새 대화의 메모리",
  on: "켜짐", off: "꺼짐", inherit: "계정 기본값", deviceLock: "기기 인증으로 앱 잠금", deviceHint: "기기의 지문, Face ID, PIN, 패턴 또는 암호를 사용합니다. Tomverse는 생체 정보나 기기 암호를 받지 않습니다. 앱을 재시작하거나 백그라운드에서 30초 지나면 잠깁니다.",
  deviceUnavailable: "기기 설정에서 화면 잠금 또는 생체 인증을 먼저 등록하세요.", deviceCancelled: "인증이 취소되었거나 실패했습니다. 다시 잠금 해제해 주세요.", unlock: "Tomverse 잠금 해제", locked: "대화가 잠겨 있습니다", unlockHint: "기기 인증 후 계속 이용하세요.",
  tools: "메시지 도구", files: "파일 선택", photos: "사진 선택", filePrivacy: "직접 선택한 파일만 공유됩니다. Tomverse는 기기 저장소를 탐색할 수 없습니다.",
  search: "웹 검색", searchHint: "이 대화에서 웹 정보를 검색합니다", assistant: "어시스턴트", noAssistant: "기본 어시스턴트", clearAssistant: "어시스턴트 해제", selected: "선택됨",
  imageFailed: "이미지를 불러오지 못했습니다.", imageLoading: "이미지 불러오는 중…", retry: "다시 시도", openImage: "이미지 열기", copy: "복사", copied: "복사됨", copyFailed: "복사하지 못했습니다",
  uploadFailed: "파일을 업로드하지 못했습니다. 연결을 확인한 뒤 다시 선택하세요.",
  review: "여러 관점 비교", easy: "제공사를 선택하면 질문마다 Tomverse가 모델을 고릅니다.", professional: "비교할 모델을 직접 선택합니다.",
  models: "모델", providers: "제공사", results: "결과", write: "질문 작성", history: "대화 기록", newReview: "새 Review", reviewEmpty: "하나의 질문, 다양한 관점.",
  choose: "참여 모델 선택", noParticipants: "모델 또는 제공사를 하나 이상 선택하세요.", reviewUnavailable: "Review를 사용하려면 모바일 서버 연동 업데이트가 필요합니다.",
  imageDecision: "이미지 생성이 필요한 질문입니다. Review 이미지 생성은 별도 가격 확인이 필요합니다.",
};
export const mobileParityCopy = (language: MobileLanguage) => language === "ko" ? ko : en;
