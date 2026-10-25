/** Small, framework-free copy shared by the native bundle and device connection page. */
const en = {
  title: "Tomverse Chat", connect: "Connect your account", openBrowser: "Sign in in your browser",
  connectionNote: "Sign in on the page that opens, create a one-time connection code, then paste it here. The code only works for this device's connection request.",
  code: "Connection code", confirm: "Connect device", disconnect: "Sign out", newChat: "New chat",
  prompt: "Ask anything…", send: "Send", stop: "Stop", location: "Current location", search: "Web search",
  locationNote: "While on, share your approximate location with AI providers on each message. Used when relevant. No background tracking.",
  reading: "Reading current location…", denied: "Location permission denied. Allow it in device settings, then try again.",
  timeout: "Location timed out. Continuing without location.", unavailable: "Location unavailable. You can enter a place instead.",
  locationOn: "Current location on · refreshed with each message", memoryOnly: "This conversation stays on this screen. It is cleared when you sign out, reload, or start a new chat.",
  restoring: "Checking device session…", retryConnection: "Retry connection",
  incomplete: "This answer reached its length limit and may be incomplete.",
  requestId: "Connection request", requestNote: "Compare this request ID with the one in your Tomverse app. Close this page if someone sent you the link.",
  requestMatch: "The request ID matches the request shown in my Tomverse app.",
  connected: "Connected", connecting: "Connecting…", thinking: "Thinking…", connectionError: "Could not connect. Start a new connection and try again.",
  chatError: "The message could not be completed. Check your connection or account access and try again.",
  disabled: "Native chat is not enabled on this server yet.", empty: "Ask about a nearby place, the weather, or anything else.",
  grantTitle: "Connect your Tomverse app", grantNote: "This creates a code for the app that opened this page. Only continue if you started this request on your own device.",
  createCode: "Create connection code", codeNote: "Paste this code into the app within 60 seconds. Do not share it with anyone.",
  expired: "The code has expired. Create a new one.", createError: "Could not create a code. Sign in again and retry.",
};

const ko: typeof en = {
  title: "Tomverse Chat", connect: "계정 연결", openBrowser: "브라우저에서 로그인",
  connectionNote: "열린 페이지에서 로그인하고 일회용 연결 코드를 만든 뒤 여기에 붙여 넣으세요. 코드는 이 기기에서 시작한 연결에만 사용할 수 있습니다.",
  code: "연결 코드", confirm: "기기 연결", disconnect: "로그아웃", newChat: "새 대화",
  prompt: "무엇이든 물어보세요…", send: "보내기", stop: "중지", location: "현재 위치", search: "웹 검색",
  locationNote: "켜져 있는 동안 메시지를 보낼 때마다 대략적인 위치를 AI 제공자에게 전달하고 관련 답변에 사용합니다. 백그라운드에서는 추적하지 않습니다.",
  reading: "현재 위치 확인 중…", denied: "위치 권한이 거부되었습니다. 기기 설정에서 허용한 뒤 다시 시도해 주세요.",
  timeout: "위치 확인 시간이 초과되어 위치 없이 대화를 계속합니다.", unavailable: "위치를 확인할 수 없습니다. 장소를 직접 입력해도 됩니다.",
  locationOn: "현재 위치 사용 중 · 메시지마다 새로 확인", memoryOnly: "이 대화는 현재 화면에서만 유지됩니다. 로그아웃, 새로고침 또는 새 대화를 시작하면 지워집니다.",
  restoring: "기기 세션 확인 중…", retryConnection: "연결 다시 확인",
  incomplete: "답변 길이 제한에 도달하여 내용이 완성되지 않았을 수 있습니다.",
  requestId: "연결 요청", requestNote: "Tomverse 앱에 표시된 요청 ID와 비교하세요. 다른 사람이 보낸 링크라면 이 페이지를 닫으세요.",
  requestMatch: "요청 ID가 내 Tomverse 앱에 표시된 요청과 일치합니다.",
  connected: "연결됨", connecting: "연결 중…", thinking: "답변 생성 중…", connectionError: "연결할 수 없습니다. 새 연결을 시작한 뒤 다시 시도해 주세요.",
  chatError: "메시지를 완료하지 못했습니다. 연결 상태와 계정 이용 권한을 확인한 뒤 다시 시도해 주세요.",
  disabled: "이 서버에서 네이티브 채팅이 아직 활성화되지 않았습니다.", empty: "근처 장소나 날씨 등 궁금한 내용을 물어보세요.",
  grantTitle: "Tomverse 앱 연결", grantNote: "이 페이지를 연 앱에 연결 코드를 발급합니다. 본인 기기에서 직접 시작한 요청인 경우에만 진행해 주세요.",
  createCode: "연결 코드 만들기", codeNote: "60초 안에 코드를 앱에 붙여 넣으세요. 다른 사람과 공유하지 마세요.",
  expired: "코드가 만료되었습니다. 새 코드를 만들어 주세요.", createError: "코드를 만들 수 없습니다. 다시 로그인한 뒤 시도해 주세요.",
};

export const mobileChatCopy = (language: string) => language.toLowerCase().startsWith("ko") ? ko : en;
