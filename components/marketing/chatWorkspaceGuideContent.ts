import type { Language } from "@/components/LanguageProvider";

export type WorkspaceGuideItem = {
  term: string;
  detail: string;
};

export type WorkspaceGuideSection = {
  id: string;
  title: string;
  description: string;
  items: WorkspaceGuideItem[];
  note?: string;
};

export type ChatWorkspaceGuideCopy = {
  eyebrow: string;
  title: string;
  description: string;
  updated: string;
  contents: string;
  tourTitle: string;
  tourDescription: string;
  tourItems: WorkspaceGuideItem[];
  sections: WorkspaceGuideSection[];
  reviewVideoTitle: string;
  reviewVideoCaption: string;
  openChat: string;
  allHelp: string;
};

const sectionIds = {
  states: "states-and-labels",
  projects: "projects",
  labels: "labels",
  lockShare: "lock-and-share",
  models: "models-and-panels",
  review: "ai-review",
  files: "files-and-drive",
  credits: "credits-and-plans",
  troubleshooting: "troubleshooting",
} as const;

export const chatWorkspaceGuideContent: Record<
  Language,
  ChatWorkspaceGuideCopy
> = {
  en: {
    eyebrow: "Help Centre · Chat workspace",
    title: "Use the Tomverse chat workspace with confidence",
    description:
      "A practical guide to conversations, projects, personal labels, locks, sharing, model panels, AI Review, files, and credits.",
    updated: "Updated 16 July 2026",
    contents: "On this page",
    tourTitle: "1. Tour the chat screen",
    tourDescription:
      "Select a number in the workspace map to jump to its explanation. The map mirrors the current sidebar without showing private conversation content.",
    tourItems: [
      { term: "New chat", detail: "Starts a separate conversation with the currently selected default models." },
      { term: "Private Mode", detail: "Runs a conversation without saving its room or messages in the Tomverse database. Requests still go to the selected AI provider." },
      { term: "Search conversations", detail: "Searches conversation titles and, for signed-in accounts, matching saved message text." },
      { term: "Status filters", detail: "Shows conversations that are Locked or currently have a Shared link." },
      { term: "Personal labels", detail: "Filters the browser-local Work, Research, and Personal labels." },
      { term: "Projects", detail: "Groups account conversations into folders for organization." },
      { term: "Conversation menu", detail: "Renames, pins, favorites, labels, moves, shares, downloads, locks, or deletes a conversation." },
    ],
    sections: [
      {
        id: sectionIds.states,
        title: "2. Conversation states, labels, and projects",
        description: "These controls can appear together, but they describe different things.",
        items: [
          { term: "Locked", detail: "A protected conversation that requires password verification for protected reads and actions." },
          { term: "Shared", detail: "A read-only public snapshot link is currently active." },
          { term: "Work", detail: "A personal browser label for work-related conversations." },
          { term: "Research", detail: "A personal browser label for research conversations." },
          { term: "Personal", detail: "A personal browser label for private-life organization." },
          { term: "Project", detail: "An account-backed folder that groups related conversations." },
        ],
        note: "Projects do not make their conversations automatically share content, files, or AI memory. Work, Research, and Personal labels are stored in the current browser and do not change AI behavior or sharing visibility.",
      },
      {
        id: sectionIds.projects,
        title: "3. Use projects",
        description: "Create a project, then move conversations into it from each conversation menu.",
        items: [
          { term: "Create", detail: "Choose New beside Projects, enter a name, and confirm." },
          { term: "Rename", detail: "Use the pencil button beside the project name." },
          { term: "Move a conversation", detail: "Open the conversation menu, find Move to project, and select a project." },
          { term: "Remove from a project", detail: "Open the same menu and choose Remove from project." },
          { term: "Delete a project", detail: "Confirm the project delete action. Its conversations remain in the account and become uncategorized." },
          { term: "Context boundary", detail: "A project is a folder, not a shared prompt, file library, or cross-chat memory." },
        ],
      },
      {
        id: sectionIds.labels,
        title: "4. Use personal labels",
        description: "Open a conversation's menu and choose Work, Research, or Personal. Select the active label again to remove it.",
        items: [
          { term: "Example project", detail: "2026 Tomverse launch" },
          { term: "Example label", detail: "Work" },
          { term: "Use together", detail: "One conversation can be in the launch project and also carry the Work label." },
          { term: "Device scope", detail: "Labels, pins, and favorites stay in the current browser and may not appear on another device." },
        ],
      },
      {
        id: sectionIds.lockShare,
        title: "5. Locking and sharing",
        description: "Locking protects saved-chat actions; sharing publishes a bounded read-only snapshot.",
        items: [
          { term: "Lock", detail: "Set a conversation password from its menu. Opening, sharing, downloading, editing, and other protected actions require verification." },
          { term: "Unlock", detail: "Choose Unlock and enter the conversation password. Repeated incorrect attempts may be rate-limited." },
          { term: "Forgotten password", detail: "Tomverse cannot display or recover the original password. Keep it safely and contact support for available account-data options." },
          { term: "Not encryption", detail: "A lock is an access control. It does not stop the selected AI provider from receiving prompts and necessary context during generation." },
          { term: "Share", detail: "Anyone with the active link can read the snapshot until it expires or is revoked. Do not share sensitive content." },
          { term: "Refresh or revoke", detail: "Refresh Share to create a new snapshot and link. Revoke Share disables the current public link." },
        ],
        note: "Messages added after sharing are not automatically added to the existing snapshot.",
      },
      {
        id: sectionIds.models,
        title: "6. AI models and answer panels",
        description: "Choose one model for a focused answer or up to three for side-by-side comparison.",
        items: [
          { term: "Select models", detail: "Open the model picker before sending and review each model's usage class and estimated base credits." },
          { term: "Active model", detail: "Only enabled panels receive the next shared prompt." },
          { term: "Model-only follow-up", detail: "Use a response panel's follow-up control when the next question should go only to that model." },
          { term: "Pause a panel", detail: "Switch a panel off temporarily without removing it from the conversation." },
          { term: "Close a panel", detail: "Remove that model panel from the current comparison after confirmation." },
          { term: "Limited or unavailable", detail: "Open the model status reason and use a recommended fallback if a provider is temporarily limited." },
          { term: "Credit estimate", detail: "The composer shows the estimated charge before sending; long inputs and files can increase it." },
        ],
      },
      {
        id: sectionIds.review,
        title: "7. Use Tomverse AI Review",
        description: "After two or three model answers complete, open AI Review, choose a review mode, check the estimated credits, and run the review.",
        items: [
          { term: "Balanced", detail: "Organizes agreements, important differences, omissions, contradictions, and practical usefulness." },
          { term: "Evidence-focused", detail: "Emphasizes weak support, conflicts, and claims that require outside verification." },
          { term: "Action-focused", detail: "Emphasizes options, trade-offs, risks, and next actions." },
          { term: "Output", detail: "Review the consensus, differences, contradictions, missing points, and verification-needed sections." },
        ],
        note: "AI Review compares only the supplied answers. It does not browse the web, independently fact-check claims, or guarantee a correct answer.",
      },
      {
        id: sectionIds.files,
        title: "8. Files and Google Drive",
        description: "Signed-in plans that allow attachments can add up to five files, with a 10 MB limit per file and a 25 MB combined request limit.",
        items: [
          { term: "Supported", detail: "PNG, JPEG, WebP, PDF, text, Word, Excel, PowerPoint, OpenDocument files, and supported Google Drive exports." },
          { term: "Unsupported or failed", detail: "Remove passwords, re-export corrupted documents, reduce size, or paste the key text directly." },
          { term: "Model differences", detail: "Some models handle images or long documents differently; try a file-capable fallback when needed." },
          { term: "Private Mode", detail: "Tomverse does not save the chat history, but attached content still passes through Tomverse and may be sent to the selected provider." },
          { term: "Sensitive files", detail: "Attach only content you are permitted to process with Tomverse and the selected external AI provider." },
        ],
      },
      {
        id: sectionIds.credits,
        title: "9. Credits and plans",
        description: "Credits provide a simple usage unit while model cost and reasoning depth vary.",
        items: [
          { term: "Base classes", detail: "Typical short-request bases are Standard 1, Advanced 4, Premium 8, Reasoning 12–16, and Research 20–30 credits." },
          { term: "Long input", detail: "Estimated input above 16k, 50k, and 100k tokens can apply 1.5×, 2×, and 3× multipliers." },
          { term: "Files", detail: "Extracted file content contributes to input size and can change the estimate." },
          { term: "AI Review", detail: "The setup screen shows its separate estimated charge before execution." },
          { term: "Two balances", detail: "Plan credits reset on the plan schedule; purchased add-on credits are separate and remain until used or expired under their terms." },
          { term: "Failed usage", detail: "Provider failures and empty responses are refunded; cancelled requests settle completed usage and return the unused reservation." },
        ],
      },
      {
        id: sectionIds.troubleshooting,
        title: "10. Troubleshooting",
        description: "Start with the smallest retry, then keep the trace evidence if the problem continues.",
        items: [
          { term: "No answer", detail: "Check the status page, retry once, and try a recommended fallback model." },
          { term: "One model fails", detail: "Continue with successful panels and inspect the failed provider's status reason." },
          { term: "Upload fails", detail: "Check format, file size, password protection, and network stability; then retry with one file." },
          { term: "Credit looks wrong", detail: "Refresh the usage panel after settlement. Compare the estimate with completed usage and contact support if it remains inconsistent." },
          { term: "Trace ID", detail: "Copy the trace ID shown with an error and include it with the approximate time, model, browser, and attachment status." },
          { term: "Provider status", detail: "Open tomverse.app/status to see model availability and current incidents." },
        ],
      },
    ],
    reviewVideoTitle: "AI Review workflow example",
    reviewVideoCaption: "Controlled demonstration data; no private user conversation is shown.",
    openChat: "Open Tomverse chat",
    allHelp: "View all Help Centre guides",
  },
  ko: {
    eyebrow: "도움말 센터 · Chat 워크스페이스",
    title: "Tomverse Chat 워크스페이스 사용 가이드",
    description: "대화, 프로젝트, 개인 라벨, 잠금, 공유, 모델 패널, AI Review, 파일과 크레딧을 실제 화면 기준으로 설명합니다.",
    updated: "2026년 7월 16일 업데이트",
    contents: "이 페이지의 내용",
    tourTitle: "1. Chat 화면 둘러보기",
    tourDescription: "워크스페이스 지도에서 번호를 누르면 해당 설명으로 이동합니다. 개인 대화 내용 없이 현재 사이드바 구조를 재현했습니다.",
    tourItems: [
      { term: "새 대화", detail: "현재 기본 모델 선택으로 서로 독립된 새 대화를 시작합니다." },
      { term: "Private Mode", detail: "대화방과 메시지를 Tomverse DB에 저장하지 않습니다. 요청은 선택한 AI 공급자에게 계속 전달됩니다." },
      { term: "대화 검색", detail: "대화 제목을 검색하고 로그인 계정에서는 저장된 메시지의 일치 내용도 찾습니다." },
      { term: "상태 필터", detail: "잠겼거나 현재 공유 링크가 활성화된 대화를 표시합니다." },
      { term: "개인 라벨", detail: "현재 브라우저에 저장된 업무·리서치·개인 라벨로 필터링합니다." },
      { term: "프로젝트", detail: "계정의 관련 대화를 폴더처럼 묶어 정리합니다." },
      { term: "대화 메뉴", detail: "이름 변경, 고정, 즐겨찾기, 라벨, 이동, 공유, 다운로드, 잠금, 삭제를 실행합니다." },
    ],
    sections: [
      { id: sectionIds.states, title: "2. 대화 상태·라벨·프로젝트의 차이", description: "한 대화에 함께 표시될 수 있지만 각각 의미가 다릅니다.", items: [
        { term: "잠김", detail: "보호된 읽기와 작업 전에 비밀번호 확인이 필요한 대화입니다." },
        { term: "공유됨", detail: "읽기 전용 공개 스냅샷 링크가 활성화된 상태입니다." },
        { term: "업무", detail: "업무 대화를 구분하는 브라우저 개인 라벨입니다." },
        { term: "리서치", detail: "조사·연구 대화를 구분하는 브라우저 개인 라벨입니다." },
        { term: "개인", detail: "개인적인 대화를 정리하는 브라우저 개인 라벨입니다." },
        { term: "프로젝트", detail: "관련 대화를 묶는 계정 기반 폴더입니다." },
      ], note: "프로젝트에 포함된 대화들이 서로의 내용, 파일 또는 AI 메모리를 자동 공유하지 않습니다. 업무·리서치·개인 라벨은 현재 브라우저에 저장되며 AI 답변 방식이나 공개 범위를 바꾸지 않습니다." },
      { id: sectionIds.projects, title: "3. 프로젝트 사용 방법", description: "프로젝트를 만든 뒤 각 대화 메뉴에서 이동합니다.", items: [
        { term: "생성", detail: "프로젝트 옆 새 프로젝트를 누르고 이름을 입력해 확인합니다." },
        { term: "이름 변경", detail: "프로젝트 이름 옆 연필 버튼을 사용합니다." },
        { term: "대화 이동", detail: "대화의 ⋮ 메뉴에서 프로젝트로 이동을 열고 대상을 선택합니다." },
        { term: "프로젝트에서 제거", detail: "같은 메뉴에서 프로젝트에서 제거를 선택합니다." },
        { term: "프로젝트 삭제", detail: "삭제를 확인해도 대화는 계정에 남고 미분류 상태가 됩니다." },
        { term: "컨텍스트 제한", detail: "프로젝트는 폴더이며 공용 프롬프트, 파일 보관함 또는 대화 간 메모리가 아닙니다." },
      ] },
      { id: sectionIds.labels, title: "4. 대화 라벨 사용 방법", description: "대화의 ⋮ 메뉴에서 업무·리서치·개인을 선택합니다. 적용 중인 라벨을 다시 누르면 제거됩니다.", items: [
        { term: "프로젝트 예시", detail: "2026 Tomverse 출시" }, { term: "라벨 예시", detail: "업무" },
        { term: "동시 사용", detail: "하나의 대화가 출시 프로젝트에 들어가면서 동시에 업무 라벨을 가질 수 있습니다." },
        { term: "기기 범위", detail: "라벨·고정·즐겨찾기는 현재 브라우저에 저장되어 다른 기기에는 보이지 않을 수 있습니다." },
      ] },
      { id: sectionIds.lockShare, title: "5. 잠금과 공유", description: "잠금은 저장된 대화 작업을 보호하고, 공유는 범위가 제한된 읽기 전용 스냅샷을 공개합니다.", items: [
        { term: "잠금", detail: "대화 메뉴에서 비밀번호를 설정합니다. 열기, 공유, 다운로드, 수정 등 보호 작업 전에 확인이 필요합니다." },
        { term: "잠금 해제", detail: "잠금 해제를 선택하고 대화 비밀번호를 입력합니다. 반복 오류는 일시 제한될 수 있습니다." },
        { term: "비밀번호 분실", detail: "Tomverse는 원래 비밀번호를 표시하거나 복구할 수 없습니다. 안전하게 보관하고 가능한 계정 데이터 조치는 지원팀에 문의하세요." },
        { term: "암호화 아님", detail: "잠금은 접근 제어입니다. 답변 생성 중 선택한 AI 공급자에게 질문과 필요한 맥락이 전달되는 것을 막지 않습니다." },
        { term: "공유", detail: "링크를 가진 사람은 만료 또는 취소 전까지 스냅샷을 읽을 수 있으므로 민감한 내용은 공유하지 마세요." },
        { term: "갱신·취소", detail: "공유 갱신은 새 스냅샷과 링크를 만들고, 공유 취소는 현재 공개 링크를 비활성화합니다." },
      ], note: "공유 후 추가된 메시지는 기존 스냅샷에 자동 반영되지 않습니다." },
      { id: sectionIds.models, title: "6. AI 모델과 답변 패널", description: "집중 답변은 한 모델, 나란히 비교하려면 최대 세 모델을 선택합니다.", items: [
        { term: "모델 선택", detail: "보내기 전에 모델 선택창에서 사용량 클래스와 예상 기본 크레딧을 확인합니다." },
        { term: "활성 모델", detail: "켜진 패널만 다음 공통 질문을 받습니다." },
        { term: "특정 모델 후속 질문", detail: "해당 응답 패널의 후속 질문 기능을 사용합니다." },
        { term: "패널 일시 중지", detail: "대화에서 제거하지 않고 해당 모델만 잠시 끕니다." },
        { term: "패널 닫기", detail: "확인 후 현재 비교에서 해당 모델 패널을 제거합니다." },
        { term: "제한·장애", detail: "상태 이유를 열고 공급자가 제한된 경우 추천 대체 모델을 사용합니다." },
        { term: "크레딧 예상", detail: "입력창에서 전송 전 예상 차감량을 확인하며 긴 입력과 파일은 늘어날 수 있습니다." },
      ] },
      { id: sectionIds.review, title: "7. AI Review 사용법", description: "2~3개 모델 답변이 완료되면 AI Review를 열고 검토 방식과 예상 크레딧을 확인한 뒤 실행합니다.", items: [
        { term: "균형 검토", detail: "공통점, 중요한 차이, 누락, 모순과 실용성을 정리합니다." },
        { term: "근거 중심", detail: "근거가 약한 주장, 충돌과 외부 검증이 필요한 항목을 강조합니다." },
        { term: "실행 중심", detail: "선택지, 장단점, 위험과 다음 행동을 강조합니다." },
        { term: "결과", detail: "합의점·차이·모순·누락·검증 필요 영역을 확인합니다." },
      ], note: "AI Review는 제공된 답변만 비교합니다. 웹 검색, 독립적인 사실검증 또는 정답 보증을 수행하지 않습니다." },
      { id: sectionIds.files, title: "8. 파일과 Google Drive", description: "첨부 권한이 있는 로그인 플랜은 최대 5개, 파일당 10MB, 요청 전체 25MB까지 첨부할 수 있습니다.", items: [
        { term: "지원 형식", detail: "PNG, JPEG, WebP, PDF, 텍스트, Word, Excel, PowerPoint, OpenDocument와 지원되는 Google Drive 내보내기입니다." },
        { term: "실패 시", detail: "암호를 제거하고 손상 문서를 다시 내보내거나 크기를 줄이고 핵심 텍스트를 직접 붙여넣으세요." },
        { term: "모델별 차이", detail: "이미지·긴 문서 처리가 다를 수 있으므로 파일 지원 대체 모델을 시도하세요." },
        { term: "Private Mode", detail: "대화 기록은 저장하지 않지만 파일 내용은 Tomverse를 거쳐 선택한 공급자에게 전달될 수 있습니다." },
        { term: "민감 파일", detail: "Tomverse와 선택한 외부 AI 공급자에서 처리할 권한이 있는 내용만 첨부하세요." },
      ] },
      { id: sectionIds.credits, title: "9. 크레딧과 플랜", description: "모델 비용과 추론 깊이가 달라도 이해하기 쉽도록 크레딧이라는 공통 사용 단위를 제공합니다.", items: [
        { term: "기본 클래스", detail: "일반적인 짧은 요청 기준 Standard 1, Advanced 4, Premium 8, Reasoning 12~16, Research 20~30 크레딧입니다." },
        { term: "긴 입력", detail: "예상 입력이 16k·50k·100k 토큰을 넘으면 1.5배·2배·3배 배율이 적용될 수 있습니다." },
        { term: "파일", detail: "추출된 파일 내용도 입력 크기에 포함되어 예상량이 달라질 수 있습니다." },
        { term: "AI Review", detail: "실행 전 설정 화면에서 별도 예상 차감량을 표시합니다." },
        { term: "두 잔액", detail: "플랜 크레딧은 일정에 따라 초기화되고 추가 구매 크레딧은 별도로 유지되어 약관에 따라 소진·만료됩니다." },
        { term: "실패 처리", detail: "공급자 오류·빈 응답은 환불하고 취소 요청은 완료 사용량만 확정한 뒤 미사용 예약분을 돌려줍니다." },
      ] },
      { id: sectionIds.troubleshooting, title: "10. 문제 해결", description: "가장 작은 범위로 한 번 재시도하고 문제가 계속되면 추적 정보를 보관하세요.", items: [
        { term: "답변 없음", detail: "상태 페이지를 확인하고 한 번 재시도한 뒤 추천 대체 모델을 사용합니다." },
        { term: "특정 모델 실패", detail: "성공한 패널은 계속 사용하고 실패한 공급자의 상태 이유를 확인합니다." },
        { term: "업로드 실패", detail: "형식, 크기, 암호 보호와 네트워크를 확인하고 파일 하나로 재시도합니다." },
        { term: "크레딧 이상", detail: "정산 후 사용량 패널을 새로고침하고 예상량과 완료 사용량이 계속 다르면 지원팀에 문의합니다." },
        { term: "Trace ID", detail: "오류의 Trace ID와 대략적 시간, 모델, 브라우저, 첨부 여부를 함께 전달합니다." },
        { term: "공급자 상태", detail: "tomverse.app/status에서 모델 가용성과 진행 중인 사고를 확인합니다." },
      ] },
    ],
    reviewVideoTitle: "AI Review 동작 예시",
    reviewVideoCaption: "통제된 데모 데이터이며 실제 사용자의 비공개 대화는 표시하지 않습니다.",
    openChat: "Tomverse Chat 열기",
    allHelp: "전체 도움말 보기",
  },
  zh: {
    eyebrow: "帮助中心 · Chat 工作区", title: "Tomverse Chat 工作区使用指南", description: "了解对话、项目、个人标签、锁定、分享、模型面板、AI Review、文件和积分。", updated: "更新于 2026 年 7 月 16 日", contents: "本页内容", tourTitle: "1. Chat 界面导览", tourDescription: "选择工作区地图中的编号即可跳到说明。地图不显示任何私人对话内容。",
    tourItems: [
      { term: "新对话", detail: "使用当前默认模型开始一个独立对话。" }, { term: "Private Mode", detail: "不把房间或消息保存到 Tomverse 数据库，但请求仍会发送给所选 AI 提供商。" }, { term: "搜索对话", detail: "搜索标题；登录后也可搜索已保存消息中的匹配内容。" }, { term: "状态筛选", detail: "显示已锁定或已启用分享链接的对话。" }, { term: "个人标签", detail: "按当前浏览器中的工作、研究和个人标签筛选。" }, { term: "项目", detail: "像文件夹一样整理账户对话。" }, { term: "对话菜单", detail: "重命名、置顶、收藏、加标签、移动、分享、下载、锁定或删除。" },
    ],
    sections: [
      { id: sectionIds.states, title: "2. 状态、标签和项目", description: "它们可以同时出现，但含义不同。", items: [
        { term: "已锁定", detail: "受保护的读取和操作前需要密码验证。" }, { term: "已分享", detail: "只读公开快照链接当前有效。" }, { term: "工作", detail: "浏览器本地的工作分类标签。" }, { term: "研究", detail: "浏览器本地的研究分类标签。" }, { term: "个人", detail: "浏览器本地的个人分类标签。" }, { term: "项目", detail: "账户中用于归组相关对话的文件夹。" },
      ], note: "项目不会自动共享对话内容、文件或 AI 记忆。个人标签只保存在当前浏览器，不改变 AI 行为或公开范围。" },
      { id: sectionIds.projects, title: "3. 使用项目", description: "先创建项目，再从每个对话的菜单移动。", items: [
        { term: "创建", detail: "选择项目旁的新建，输入名称并确认。" }, { term: "重命名", detail: "使用项目名称旁的铅笔按钮。" }, { term: "移动对话", detail: "打开 ⋮ 菜单，在移动到项目中选择目标。" }, { term: "移出", detail: "在同一菜单选择从项目移除。" }, { term: "删除项目", detail: "对话不会被删除，而会回到未分类。" }, { term: "上下文边界", detail: "项目只是文件夹，不是共享提示词、文件库或跨对话记忆。" },
      ] },
      { id: sectionIds.labels, title: "4. 使用个人标签", description: "在 ⋮ 菜单选择工作、研究或个人；再次选择当前标签即可移除。", items: [
        { term: "项目示例", detail: "2026 Tomverse 发布" }, { term: "标签示例", detail: "工作" }, { term: "可同时使用", detail: "一个对话可以属于发布项目，同时带有工作标签。" }, { term: "设备范围", detail: "标签、置顶和收藏保存在当前浏览器，其他设备可能看不到。" },
      ] },
      { id: sectionIds.lockShare, title: "5. 锁定与分享", description: "锁定保护已保存对话的操作；分享发布有范围限制的只读快照。", items: [
        { term: "锁定", detail: "从菜单设置密码；打开、分享、下载、编辑等受保护操作需验证。" }, { term: "解锁", detail: "选择解锁并输入密码；连续错误可能被限速。" }, { term: "忘记密码", detail: "Tomverse 无法显示或恢复原密码，请安全保存并向支持咨询可用的数据选项。" }, { term: "不是加密", detail: "锁定是访问控制，不会阻止生成回答时把必要内容发送给 AI 提供商。" }, { term: "分享", detail: "持有链接的人可在到期或撤销前读取快照，请勿分享敏感内容。" }, { term: "刷新或撤销", detail: "刷新会生成新快照和链接；撤销会停用当前链接。" },
      ], note: "分享后新增的消息不会自动进入现有快照。" },
      { id: sectionIds.models, title: "6. AI 模型和回答面板", description: "一个模型适合专注回答，最多三个模型可并排比较。", items: [
        { term: "选择模型", detail: "发送前查看用量类别和预计基础积分。" }, { term: "启用模型", detail: "只有开启的面板接收下一条共同问题。" }, { term: "仅向一个模型追问", detail: "使用该回答面板的追问控件。" }, { term: "暂停面板", detail: "暂时关闭而不从对话移除。" }, { term: "关闭面板", detail: "确认后从当前比较移除。" }, { term: "受限或不可用", detail: "查看状态原因并使用推荐替代模型。" }, { term: "积分预估", detail: "发送前显示预估；长输入和文件可能增加用量。" },
      ] },
      { id: sectionIds.review, title: "7. 使用 AI Review", description: "两到三个回答完成后，打开 AI Review，选择模式、确认预计积分并运行。", items: [
        { term: "均衡", detail: "整理共识、差异、遗漏、矛盾和实用性。" }, { term: "证据优先", detail: "突出薄弱依据、冲突和需外部验证的说法。" }, { term: "行动优先", detail: "突出选项、权衡、风险和下一步。" }, { term: "结果", detail: "查看共识、差异、矛盾、遗漏和待验证部分。" },
      ], note: "AI Review 只比较提供的回答，不浏览网页、不独立核验事实，也不保证正确答案。" },
      { id: sectionIds.files, title: "8. 文件和 Google Drive", description: "允许附件的登录方案最多可添加 5 个文件，每个 10 MB，单次请求合计 25 MB。", items: [
        { term: "支持", detail: "PNG、JPEG、WebP、PDF、文本、Word、Excel、PowerPoint、OpenDocument 和支持的 Drive 导出。" }, { term: "失败时", detail: "移除密码、重新导出损坏文件、减小大小或粘贴关键文本。" }, { term: "模型差异", detail: "图像和长文档能力不同，可改用支持文件的模型。" }, { term: "Private Mode", detail: "不保存聊天历史，但文件仍经 Tomverse 并可能发送给所选提供商。" }, { term: "敏感文件", detail: "只上传你有权交由 Tomverse 和外部 AI 提供商处理的内容。" },
      ] },
      { id: sectionIds.credits, title: "9. 积分和方案", description: "积分把不同模型成本和推理深度统一为易懂的用量单位。", items: [
        { term: "基础类别", detail: "短请求通常为 Standard 1、Advanced 4、Premium 8、Reasoning 12–16、Research 20–30。" }, { term: "长输入", detail: "超过 16k、50k、100k 估算 token 时可应用 1.5×、2×、3×。" }, { term: "文件", detail: "提取内容计入输入大小。" }, { term: "AI Review", detail: "运行前单独显示预计用量。" }, { term: "两种余额", detail: "方案积分按周期重置；附加积分单独保留并按条款使用或到期。" }, { term: "失败处理", detail: "提供商错误和空回答会退款；取消时仅结算已完成用量并退回未用预留。" },
      ] },
      { id: sectionIds.troubleshooting, title: "10. 故障排除", description: "先做一次最小范围重试；若持续发生，请保留追踪证据。", items: [
        { term: "没有回答", detail: "查看状态页、重试一次并尝试推荐替代模型。" }, { term: "单个模型失败", detail: "继续使用成功面板并查看失败提供商原因。" }, { term: "上传失败", detail: "检查格式、大小、密码和网络，再用一个文件重试。" }, { term: "积分异常", detail: "结算后刷新用量；仍不一致时联系支持。" }, { term: "Trace ID", detail: "提交 Trace ID、时间、模型、浏览器和附件情况。" }, { term: "提供商状态", detail: "在 tomverse.app/status 查看可用性和事故。" },
      ] },
    ],
    reviewVideoTitle: "AI Review 流程示例", reviewVideoCaption: "使用受控演示数据，不显示私人用户对话。", openChat: "打开 Tomverse Chat", allHelp: "查看全部帮助指南",
  },
  fr: {
    eyebrow: "Centre d’aide · Espace Chat", title: "Guide de l’espace Chat Tomverse", description: "Maîtrisez conversations, projets, libellés personnels, verrouillage, partage, panneaux de modèles, AI Review, fichiers et crédits.", updated: "Mis à jour le 16 juillet 2026", contents: "Dans cette page", tourTitle: "1. Découvrir l’écran Chat", tourDescription: "Sélectionnez un numéro dans la carte pour rejoindre son explication, sans afficher de conversation privée.",
    tourItems: [
      { term: "Nouveau chat", detail: "Démarre une conversation indépendante avec les modèles par défaut." }, { term: "Private Mode", detail: "N’enregistre ni salon ni message dans la base Tomverse, mais envoie toujours la requête au fournisseur choisi." }, { term: "Rechercher", detail: "Recherche les titres et, une fois connecté, le texte correspondant dans les messages enregistrés." }, { term: "États", detail: "Filtre les conversations verrouillées ou avec un lien partagé actif." }, { term: "Libellés personnels", detail: "Filtre Travail, Recherche et Personnel stockés dans ce navigateur." }, { term: "Projets", detail: "Regroupe les conversations du compte comme des dossiers." }, { term: "Menu de conversation", detail: "Renommer, épingler, favoriser, étiqueter, déplacer, partager, télécharger, verrouiller ou supprimer." },
    ],
    sections: [
      { id: sectionIds.states, title: "2. États, libellés et projets", description: "Ils peuvent coexister mais n’ont pas le même rôle.", items: [
        { term: "Verrouillé", detail: "Mot de passe requis pour les lectures et actions protégées." }, { term: "Partagé", detail: "Un lien public vers un instantané en lecture seule est actif." }, { term: "Travail", detail: "Libellé local pour les conversations professionnelles." }, { term: "Recherche", detail: "Libellé local pour les travaux de recherche." }, { term: "Personnel", detail: "Libellé local pour l’organisation personnelle." }, { term: "Projet", detail: "Dossier lié au compte pour regrouper des conversations." },
      ], note: "Un projet ne partage pas automatiquement contenu, fichiers ou mémoire IA entre conversations. Les libellés restent dans ce navigateur et ne modifient ni les réponses ni la visibilité." },
      { id: sectionIds.projects, title: "3. Utiliser les projets", description: "Créez un projet puis déplacez-y les conversations depuis leur menu.", items: [
        { term: "Créer", detail: "Choisissez Nouveau près de Projets, saisissez un nom et confirmez." }, { term: "Renommer", detail: "Utilisez le crayon près du nom." }, { term: "Déplacer", detail: "Dans le menu ⋮, choisissez Déplacer vers le projet." }, { term: "Retirer", detail: "Choisissez Retirer du projet dans le même menu." }, { term: "Supprimer", detail: "Les conversations restent dans le compte et redeviennent non classées." }, { term: "Limite de contexte", detail: "Un projet est un dossier, pas une invite, bibliothèque de fichiers ou mémoire partagée." },
      ] },
      { id: sectionIds.labels, title: "4. Utiliser les libellés", description: "Dans ⋮, choisissez Travail, Recherche ou Personnel; sélectionnez à nouveau pour retirer.", items: [
        { term: "Projet exemple", detail: "Lancement Tomverse 2026" }, { term: "Libellé exemple", detail: "Travail" }, { term: "Utilisation conjointe", detail: "Une conversation peut appartenir au projet et porter aussi le libellé Travail." }, { term: "Portée appareil", detail: "Libellés, épingles et favoris sont propres au navigateur." },
      ] },
      { id: sectionIds.lockShare, title: "5. Verrouillage et partage", description: "Le verrou protège les actions; le partage publie un instantané limité en lecture seule.", items: [
        { term: "Verrouiller", detail: "Définissez un mot de passe; ouverture, partage, téléchargement et modification exigent une vérification." }, { term: "Déverrouiller", detail: "Saisissez le mot de passe; les erreurs répétées peuvent être limitées." }, { term: "Mot de passe oublié", detail: "Tomverse ne peut ni afficher ni récupérer l’original; contactez le support pour les options disponibles." }, { term: "Pas un chiffrement", detail: "Le fournisseur IA reçoit toujours les données nécessaires à la génération." }, { term: "Partager", detail: "Toute personne avec le lien peut lire l’instantané jusqu’à expiration ou révocation." }, { term: "Actualiser ou révoquer", detail: "Actualiser crée un nouvel instantané et lien; révoquer désactive le lien courant." },
      ], note: "Les messages ajoutés après le partage ne rejoignent pas automatiquement l’instantané existant." },
      { id: sectionIds.models, title: "6. Modèles IA et panneaux", description: "Un modèle pour une réponse ciblée, jusqu’à trois pour comparer.", items: [
        { term: "Choisir", detail: "Vérifiez classe d’usage et crédits de base avant l’envoi." }, { term: "Actif", detail: "Seuls les panneaux activés reçoivent la prochaine question commune." }, { term: "Suivi ciblé", detail: "Utilisez le contrôle de suivi du panneau concerné." }, { term: "Pause", detail: "Désactive temporairement sans retirer." }, { term: "Fermer", detail: "Retire le panneau après confirmation." }, { term: "Limité", detail: "Consultez la raison et utilisez un modèle de secours." }, { term: "Estimation", detail: "Visible avant l’envoi; textes longs et fichiers peuvent l’augmenter." },
      ] },
      { id: sectionIds.review, title: "7. Utiliser AI Review", description: "Après deux ou trois réponses, ouvrez AI Review, choisissez le mode, vérifiez les crédits et lancez.", items: [
        { term: "Équilibré", detail: "Accords, différences, omissions, contradictions et utilité." }, { term: "Preuves", detail: "Appuis faibles, conflits et vérifications externes." }, { term: "Action", detail: "Options, compromis, risques et prochaines étapes." }, { term: "Résultat", detail: "Consensus, différences, contradictions, omissions et points à vérifier." },
      ], note: "AI Review compare uniquement les réponses fournies; il ne navigue pas, ne vérifie pas indépendamment les faits et ne garantit pas la bonne réponse." },
      { id: sectionIds.files, title: "8. Fichiers et Google Drive", description: "Jusqu’à 5 fichiers, 10 Mo chacun et 25 Mo au total par requête pour les plans autorisés.", items: [
        { term: "Pris en charge", detail: "PNG, JPEG, WebP, PDF, texte, Word, Excel, PowerPoint, OpenDocument et exports Drive compatibles." }, { term: "Échec", detail: "Retirez le mot de passe, réexportez, réduisez ou collez le texte essentiel." }, { term: "Selon le modèle", detail: "Images et longs documents peuvent être traités différemment." }, { term: "Private Mode", detail: "L’historique n’est pas stocké, mais le fichier peut être transmis au fournisseur." }, { term: "Données sensibles", detail: "N’envoyez que ce que vous êtes autorisé à faire traiter." },
      ] },
      { id: sectionIds.credits, title: "9. Crédits et offres", description: "Une unité commune malgré les différences de coût et de raisonnement.", items: [
        { term: "Bases", detail: "Standard 1, Advanced 4, Premium 8, Reasoning 12–16, Research 20–30 pour une demande courte typique." }, { term: "Longue entrée", detail: "Au-delà de 16k, 50k et 100k tokens estimés: 1,5×, 2× et 3×." }, { term: "Fichiers", detail: "Le contenu extrait compte dans l’entrée." }, { term: "AI Review", detail: "Affiche sa propre estimation avant exécution." }, { term: "Deux soldes", detail: "Les crédits du plan se réinitialisent; les crédits achetés restent séparés selon leurs conditions." }, { term: "Échecs", detail: "Erreurs fournisseur et réponses vides sont remboursées; l’annulation rend la réservation inutilisée." },
      ] },
      { id: sectionIds.troubleshooting, title: "10. Dépannage", description: "Réessayez une fois au plus petit périmètre puis conservez les preuves.", items: [
        { term: "Aucune réponse", detail: "Vérifiez le statut, réessayez et utilisez un secours recommandé." }, { term: "Un modèle échoue", detail: "Continuez avec les panneaux réussis et consultez la raison." }, { term: "Échec d’envoi", detail: "Vérifiez format, taille, mot de passe et réseau puis un seul fichier." }, { term: "Crédits", detail: "Actualisez après règlement et contactez le support si l’écart persiste." }, { term: "Trace ID", detail: "Joignez identifiant, heure, modèle, navigateur et état des pièces jointes." }, { term: "Statut", detail: "Consultez tomverse.app/status." },
      ] },
    ],
    reviewVideoTitle: "Exemple du flux AI Review", reviewVideoCaption: "Données de démonstration contrôlées; aucune conversation privée réelle.", openChat: "Ouvrir Tomverse Chat", allHelp: "Voir tout le Centre d’aide",
  },
  de: {
    eyebrow: "Hilfe · Chat-Workspace", title: "Leitfaden für den Tomverse Chat-Workspace", description: "Erklärungen zu Chats, Projekten, persönlichen Labels, Sperren, Freigaben, Modell-Panels, AI Review, Dateien und Credits.", updated: "Aktualisiert am 16. Juli 2026", contents: "Auf dieser Seite", tourTitle: "1. Chat-Oberfläche kennenlernen", tourDescription: "Wählen Sie eine Nummer in der Workspace-Karte, ohne private Chatinhalte anzuzeigen.",
    tourItems: [
      { term: "Neuer Chat", detail: "Startet eine unabhängige Unterhaltung mit den Standardmodellen." }, { term: "Private Mode", detail: "Speichert Raum und Nachrichten nicht in Tomverse, sendet Anfragen aber an den gewählten Anbieter." }, { term: "Chats suchen", detail: "Sucht Titel und angemeldet auch passende gespeicherte Nachrichtentexte." }, { term: "Statusfilter", detail: "Zeigt gesperrte oder aktuell geteilte Chats." }, { term: "Persönliche Labels", detail: "Filtert Arbeit, Recherche und Privat im aktuellen Browser." }, { term: "Projekte", detail: "Ordnet Konto-Chats wie Ordner." }, { term: "Chat-Menü", detail: "Umbenennen, anheften, favorisieren, labeln, verschieben, teilen, laden, sperren oder löschen." },
    ],
    sections: [
      { id: sectionIds.states, title: "2. Status, Labels und Projekte", description: "Sie können gleichzeitig erscheinen, bedeuten aber Unterschiedliches.", items: [
        { term: "Gesperrt", detail: "Passwortprüfung für geschützte Lese- und Änderungsaktionen." }, { term: "Geteilt", detail: "Ein öffentlicher Nur-Lese-Snapshot-Link ist aktiv." }, { term: "Arbeit", detail: "Browserlokales Label für Arbeitschats." }, { term: "Recherche", detail: "Browserlokales Label für Forschung." }, { term: "Privat", detail: "Browserlokales Label für persönliche Ordnung." }, { term: "Projekt", detail: "Kontobasierter Ordner für zusammengehörige Chats." },
      ], note: "Projekte teilen Inhalte, Dateien oder KI-Gedächtnis nicht automatisch. Labels bleiben im Browser und ändern weder Antwortverhalten noch Sichtbarkeit." },
      { id: sectionIds.projects, title: "3. Projekte verwenden", description: "Projekt erstellen und Chats über ihr Menü verschieben.", items: [
        { term: "Erstellen", detail: "Neu neben Projekte wählen, Namen eingeben, bestätigen." }, { term: "Umbenennen", detail: "Stift neben dem Projektnamen verwenden." }, { term: "Verschieben", detail: "Im ⋮-Menü Zu Projekt verschieben wählen." }, { term: "Entfernen", detail: "Im selben Menü Aus Projekt entfernen." }, { term: "Projekt löschen", detail: "Chats bleiben im Konto und werden unkategorisiert." }, { term: "Kontextgrenze", detail: "Ein Projekt ist kein gemeinsamer Prompt, Dateispeicher oder Cross-Chat-Gedächtnis." },
      ] },
      { id: sectionIds.labels, title: "4. Persönliche Labels", description: "Im ⋮-Menü Arbeit, Recherche oder Privat wählen; erneut wählen zum Entfernen.", items: [
        { term: "Projektbeispiel", detail: "Tomverse-Launch 2026" }, { term: "Labelbeispiel", detail: "Arbeit" }, { term: "Gleichzeitig", detail: "Ein Chat kann im Launch-Projekt liegen und das Label Arbeit tragen." }, { term: "Geräteumfang", detail: "Labels, Pins und Favoriten sind browserlokal." },
      ] },
      { id: sectionIds.lockShare, title: "5. Sperren und Teilen", description: "Sperren schützt Aktionen; Teilen veröffentlicht einen begrenzten Nur-Lese-Snapshot.", items: [
        { term: "Sperren", detail: "Passwort festlegen; Öffnen, Teilen, Download und Bearbeitung erfordern Prüfung." }, { term: "Entsperren", detail: "Passwort eingeben; wiederholte Fehler können begrenzt werden." }, { term: "Passwort vergessen", detail: "Tomverse kann das Original nicht anzeigen oder wiederherstellen; Support zu verfügbaren Datenoptionen fragen." }, { term: "Keine Verschlüsselung", detail: "Der KI-Anbieter erhält weiterhin für die Generierung nötige Daten." }, { term: "Teilen", detail: "Jeder mit aktivem Link kann den Snapshot bis Ablauf oder Widerruf lesen." }, { term: "Aktualisieren/Widerrufen", detail: "Aktualisieren erstellt Snapshot und Link neu; Widerrufen deaktiviert den Link." },
      ], note: "Spätere Nachrichten werden nicht automatisch in den bestehenden Snapshot übernommen." },
      { id: sectionIds.models, title: "6. KI-Modelle und Panels", description: "Ein Modell für Fokus, bis zu drei für Vergleich.", items: [
        { term: "Auswählen", detail: "Nutzungsklasse und Basis-Credits vor dem Senden prüfen." }, { term: "Aktiv", detail: "Nur aktive Panels erhalten die nächste gemeinsame Frage." }, { term: "Gezielte Nachfrage", detail: "Nachfrage-Steuerung im Antwortpanel verwenden." }, { term: "Pause", detail: "Vorübergehend ausschalten, ohne zu entfernen." }, { term: "Schließen", detail: "Panel nach Bestätigung entfernen." }, { term: "Eingeschränkt", detail: "Grund öffnen und empfohlenes Ersatzmodell nutzen." }, { term: "Schätzung", detail: "Vor dem Senden sichtbar; lange Eingaben und Dateien können erhöhen." },
      ] },
      { id: sectionIds.review, title: "7. AI Review verwenden", description: "Nach zwei oder drei Antworten AI Review öffnen, Modus und Credits prüfen und starten.", items: [
        { term: "Ausgewogen", detail: "Übereinstimmungen, Unterschiede, Lücken, Widersprüche und Nutzen." }, { term: "Evidenz", detail: "Schwache Belege, Konflikte und externe Prüfung." }, { term: "Aktion", detail: "Optionen, Abwägungen, Risiken und nächste Schritte." }, { term: "Ergebnis", detail: "Konsens, Unterschiede, Widersprüche, Lücken und Prüfbedarf." },
      ], note: "AI Review vergleicht nur bereitgestellte Antworten, durchsucht nicht das Web, prüft Fakten nicht unabhängig und garantiert keine richtige Antwort." },
      { id: sectionIds.files, title: "8. Dateien und Google Drive", description: "Bis zu 5 Dateien, je 10 MB und 25 MB gesamt pro Anfrage bei berechtigten Plänen.", items: [
        { term: "Unterstützt", detail: "PNG, JPEG, WebP, PDF, Text, Word, Excel, PowerPoint, OpenDocument und unterstützte Drive-Exporte." }, { term: "Fehler", detail: "Passwort entfernen, neu exportieren, verkleinern oder Kerntext einfügen." }, { term: "Modellunterschiede", detail: "Bilder und lange Dokumente können anders verarbeitet werden." }, { term: "Private Mode", detail: "Kein Chatverlauf, Dateiinhalt kann aber an den Anbieter gehen." }, { term: "Sensible Dateien", detail: "Nur Inhalte mit entsprechender Verarbeitungsberechtigung anhängen." },
      ] },
      { id: sectionIds.credits, title: "9. Credits und Pläne", description: "Gemeinsame Nutzungseinheit trotz unterschiedlicher Modellkosten.", items: [
        { term: "Basis", detail: "Standard 1, Advanced 4, Premium 8, Reasoning 12–16, Research 20–30 für kurze typische Anfragen." }, { term: "Lange Eingabe", detail: "Über 16k, 50k, 100k geschätzte Tokens: 1,5×, 2×, 3×." }, { term: "Dateien", detail: "Extrahierter Inhalt zählt zur Eingabe." }, { term: "AI Review", detail: "Separate Schätzung vor Ausführung." }, { term: "Zwei Guthaben", detail: "Plan-Credits setzen zurück; gekaufte bleiben gemäß Bedingungen separat." }, { term: "Fehler", detail: "Anbieterfehler und leere Antworten werden erstattet; ungenutzte Reservierung bei Abbruch zurückgegeben." },
      ] },
      { id: sectionIds.troubleshooting, title: "10. Fehlerbehebung", description: "Einmal klein neu versuchen und bei Fortbestehen Nachweise sichern.", items: [
        { term: "Keine Antwort", detail: "Status prüfen, einmal neu versuchen, Ersatzmodell nutzen." }, { term: "Ein Modell", detail: "Erfolgreiche Panels weiterverwenden und Grund prüfen." }, { term: "Upload", detail: "Format, Größe, Passwort, Netzwerk prüfen und eine Datei testen." }, { term: "Credits", detail: "Nach Abrechnung aktualisieren und bei Abweichung Support kontaktieren." }, { term: "Trace ID", detail: "ID, Zeit, Modell, Browser und Anhänge mitsenden." }, { term: "Status", detail: "tomverse.app/status öffnen." },
      ] },
    ],
    reviewVideoTitle: "Beispiel für AI Review", reviewVideoCaption: "Kontrollierte Demodaten; keine privaten Nutzerdialoge.", openChat: "Tomverse Chat öffnen", allHelp: "Alle Hilfeartikel ansehen",
  },
  es: {
    eyebrow: "Centro de ayuda · Espacio Chat", title: "Guía del espacio Chat de Tomverse", description: "Aprende conversaciones, proyectos, etiquetas personales, bloqueo, compartir, paneles, AI Review, archivos y créditos.", updated: "Actualizado el 16 de julio de 2026", contents: "En esta página", tourTitle: "1. Recorrido por Chat", tourDescription: "Selecciona un número del mapa para ir a su explicación sin mostrar conversaciones privadas.",
    tourItems: [
      { term: "Nuevo chat", detail: "Inicia una conversación independiente con los modelos predeterminados." }, { term: "Private Mode", detail: "No guarda sala ni mensajes en Tomverse, pero envía la solicitud al proveedor elegido." }, { term: "Buscar", detail: "Busca títulos y, con sesión iniciada, texto coincidente en mensajes guardados." }, { term: "Estados", detail: "Filtra chats bloqueados o con enlace compartido activo." }, { term: "Etiquetas", detail: "Filtra Trabajo, Investigación y Personal guardadas en este navegador." }, { term: "Proyectos", detail: "Agrupa chats de la cuenta como carpetas." }, { term: "Menú", detail: "Renombrar, fijar, marcar favorito, etiquetar, mover, compartir, descargar, bloquear o eliminar." },
    ],
    sections: [
      { id: sectionIds.states, title: "2. Estados, etiquetas y proyectos", description: "Pueden coexistir, pero significan cosas distintas.", items: [
        { term: "Bloqueado", detail: "Requiere contraseña para lecturas y acciones protegidas." }, { term: "Compartido", detail: "Hay un enlace público de instantánea de solo lectura activo." }, { term: "Trabajo", detail: "Etiqueta local para chats laborales." }, { term: "Investigación", detail: "Etiqueta local para chats de investigación." }, { term: "Personal", detail: "Etiqueta local para organización personal." }, { term: "Proyecto", detail: "Carpeta vinculada a la cuenta." },
      ], note: "Los proyectos no comparten automáticamente contenido, archivos ni memoria de IA. Las etiquetas quedan en el navegador y no cambian respuestas ni visibilidad." },
      { id: sectionIds.projects, title: "3. Usar proyectos", description: "Crea un proyecto y mueve chats desde su menú.", items: [
        { term: "Crear", detail: "Elige Nuevo junto a Proyectos, escribe un nombre y confirma." }, { term: "Renombrar", detail: "Usa el lápiz junto al nombre." }, { term: "Mover", detail: "En ⋮, abre Mover al proyecto y elige destino." }, { term: "Quitar", detail: "Elige Quitar del proyecto en el mismo menú." }, { term: "Eliminar", detail: "Los chats permanecen en la cuenta y quedan sin categoría." }, { term: "Límite de contexto", detail: "Es una carpeta, no un prompt, biblioteca o memoria compartida." },
      ] },
      { id: sectionIds.labels, title: "4. Usar etiquetas", description: "En ⋮ elige Trabajo, Investigación o Personal; repite para quitarla.", items: [
        { term: "Proyecto de ejemplo", detail: "Lanzamiento Tomverse 2026" }, { term: "Etiqueta", detail: "Trabajo" }, { term: "Uso conjunto", detail: "Un chat puede estar en el proyecto y tener a la vez la etiqueta Trabajo." }, { term: "Ámbito", detail: "Etiquetas, fijados y favoritos son locales al navegador." },
      ] },
      { id: sectionIds.lockShare, title: "5. Bloquear y compartir", description: "El bloqueo protege acciones; compartir publica una instantánea limitada de solo lectura.", items: [
        { term: "Bloquear", detail: "Define contraseña; abrir, compartir, descargar y editar requieren verificación." }, { term: "Desbloquear", detail: "Introduce la contraseña; errores repetidos pueden limitarse." }, { term: "Contraseña olvidada", detail: "Tomverse no puede mostrar ni recuperar la original; consulta soporte sobre opciones de datos." }, { term: "No es cifrado", detail: "El proveedor de IA sigue recibiendo lo necesario para generar." }, { term: "Compartir", detail: "Cualquiera con el enlace puede leer hasta que caduque o se revoque." }, { term: "Actualizar/revocar", detail: "Actualizar crea nueva instantánea y enlace; revocar desactiva el actual." },
      ], note: "Los mensajes posteriores no se añaden automáticamente a la instantánea existente." },
      { id: sectionIds.models, title: "6. Modelos y paneles", description: "Un modelo para foco; hasta tres para comparar.", items: [
        { term: "Seleccionar", detail: "Revisa clase de uso y créditos base antes de enviar." }, { term: "Activo", detail: "Solo paneles activos reciben la pregunta común." }, { term: "Seguimiento individual", detail: "Usa el control del panel de respuesta." }, { term: "Pausar", detail: "Desactiva temporalmente sin quitar." }, { term: "Cerrar", detail: "Quita el panel tras confirmar." }, { term: "Limitado", detail: "Consulta el motivo y usa un sustituto recomendado." }, { term: "Estimación", detail: "Visible antes de enviar; textos largos y archivos pueden aumentar." },
      ] },
      { id: sectionIds.review, title: "7. Usar AI Review", description: "Tras dos o tres respuestas, abre AI Review, elige modo, revisa créditos y ejecuta.", items: [
        { term: "Equilibrado", detail: "Acuerdos, diferencias, omisiones, contradicciones y utilidad." }, { term: "Evidencia", detail: "Soporte débil, conflictos y verificación externa." }, { term: "Acción", detail: "Opciones, compensaciones, riesgos y próximos pasos." }, { term: "Resultado", detail: "Consenso, diferencias, contradicciones, omisiones y verificación." },
      ], note: "AI Review solo compara las respuestas aportadas; no navega, no verifica hechos de forma independiente ni garantiza la respuesta correcta." },
      { id: sectionIds.files, title: "8. Archivos y Google Drive", description: "Hasta 5 archivos, 10 MB cada uno y 25 MB totales por solicitud en planes habilitados.", items: [
        { term: "Compatibles", detail: "PNG, JPEG, WebP, PDF, texto, Word, Excel, PowerPoint, OpenDocument y exportaciones Drive." }, { term: "Fallo", detail: "Quita contraseña, reexporta, reduce o pega el texto clave." }, { term: "Por modelo", detail: "Imágenes y documentos largos pueden procesarse distinto." }, { term: "Private Mode", detail: "No guarda historial, pero el archivo puede enviarse al proveedor." }, { term: "Sensible", detail: "Adjunta solo contenido que puedas autorizar para procesamiento." },
      ] },
      { id: sectionIds.credits, title: "9. Créditos y planes", description: "Unidad común pese a costes y razonamiento diferentes.", items: [
        { term: "Bases", detail: "Standard 1, Advanced 4, Premium 8, Reasoning 12–16 y Research 20–30 en solicitudes cortas típicas." }, { term: "Entrada larga", detail: "Más de 16k, 50k y 100k tokens estimados: 1,5×, 2× y 3×." }, { term: "Archivos", detail: "El contenido extraído cuenta como entrada." }, { term: "AI Review", detail: "Muestra estimación separada antes de ejecutar." }, { term: "Dos saldos", detail: "Créditos del plan se reinician; comprados permanecen separados según condiciones." }, { term: "Fallos", detail: "Errores y respuestas vacías se reembolsan; la cancelación devuelve reserva no usada." },
      ] },
      { id: sectionIds.troubleshooting, title: "10. Solución de problemas", description: "Reintenta una vez con el menor alcance y conserva evidencias.", items: [
        { term: "Sin respuesta", detail: "Consulta estado, reintenta y usa un modelo alternativo." }, { term: "Un modelo", detail: "Continúa con paneles correctos y revisa el motivo." }, { term: "Carga", detail: "Comprueba formato, tamaño, contraseña y red con un archivo." }, { term: "Créditos", detail: "Actualiza tras liquidación y contacta soporte si persiste." }, { term: "Trace ID", detail: "Incluye ID, hora, modelo, navegador y adjuntos." }, { term: "Estado", detail: "Abre tomverse.app/status." },
      ] },
    ],
    reviewVideoTitle: "Ejemplo del flujo AI Review", reviewVideoCaption: "Datos de demostración controlados; no muestra chats privados reales.", openChat: "Abrir Tomverse Chat", allHelp: "Ver todo el Centro de ayuda",
  },
  pt: {
    eyebrow: "Centro de ajuda · Workspace Chat", title: "Guia do workspace Chat do Tomverse", description: "Aprenda conversas, projetos, etiquetas pessoais, bloqueio, partilha, painéis, AI Review, ficheiros e créditos.", updated: "Atualizado em 16 de julho de 2026", contents: "Nesta página", tourTitle: "1. Conhecer o ecrã Chat", tourDescription: "Selecione um número no mapa para ir à explicação, sem mostrar conversas privadas.",
    tourItems: [
      { term: "Novo chat", detail: "Inicia uma conversa independente com os modelos padrão." }, { term: "Private Mode", detail: "Não guarda sala nem mensagens no Tomverse, mas envia o pedido ao fornecedor escolhido." }, { term: "Pesquisar", detail: "Pesquisa títulos e, com sessão iniciada, texto correspondente nas mensagens guardadas." }, { term: "Estados", detail: "Filtra chats bloqueados ou com ligação partilhada ativa." }, { term: "Etiquetas", detail: "Filtra Trabalho, Pesquisa e Pessoal guardadas neste navegador." }, { term: "Projetos", detail: "Agrupa chats da conta como pastas." }, { term: "Menu", detail: "Renomear, fixar, favoritar, etiquetar, mover, partilhar, descarregar, bloquear ou eliminar." },
    ],
    sections: [
      { id: sectionIds.states, title: "2. Estados, etiquetas e projetos", description: "Podem coexistir, mas têm significados diferentes.", items: [
        { term: "Bloqueado", detail: "Exige palavra-passe para leituras e ações protegidas." }, { term: "Partilhado", detail: "Está ativa uma ligação pública para um snapshot só de leitura." }, { term: "Trabalho", detail: "Etiqueta local para chats de trabalho." }, { term: "Pesquisa", detail: "Etiqueta local para investigação." }, { term: "Pessoal", detail: "Etiqueta local para organização pessoal." }, { term: "Projeto", detail: "Pasta associada à conta." },
      ], note: "Projetos não partilham automaticamente conteúdo, ficheiros ou memória de IA. As etiquetas ficam no navegador e não mudam respostas nem visibilidade." },
      { id: sectionIds.projects, title: "3. Usar projetos", description: "Crie um projeto e mova chats pelo respetivo menu.", items: [
        { term: "Criar", detail: "Escolha Novo junto de Projetos, introduza o nome e confirme." }, { term: "Renomear", detail: "Use o lápis junto do nome." }, { term: "Mover", detail: "No menu ⋮, escolha Mover para projeto." }, { term: "Remover", detail: "Escolha Remover do projeto no mesmo menu." }, { term: "Eliminar", detail: "Os chats permanecem na conta e ficam sem categoria." }, { term: "Limite de contexto", detail: "É uma pasta, não um prompt, biblioteca ou memória partilhada." },
      ] },
      { id: sectionIds.labels, title: "4. Usar etiquetas", description: "No ⋮ escolha Trabalho, Pesquisa ou Pessoal; escolha novamente para remover.", items: [
        { term: "Projeto exemplo", detail: "Lançamento Tomverse 2026" }, { term: "Etiqueta", detail: "Trabalho" }, { term: "Em conjunto", detail: "Um chat pode estar no projeto e ter também a etiqueta Trabalho." }, { term: "Escopo", detail: "Etiquetas, fixados e favoritos são locais ao navegador." },
      ] },
      { id: sectionIds.lockShare, title: "5. Bloqueio e partilha", description: "O bloqueio protege ações; a partilha publica um snapshot limitado só de leitura.", items: [
        { term: "Bloquear", detail: "Defina palavra-passe; abrir, partilhar, descarregar e editar exigem verificação." }, { term: "Desbloquear", detail: "Introduza a palavra-passe; erros repetidos podem ser limitados." }, { term: "Esquecida", detail: "O Tomverse não mostra nem recupera a original; consulte o suporte sobre opções de dados." }, { term: "Não é encriptação", detail: "O fornecedor de IA continua a receber o necessário para gerar." }, { term: "Partilhar", detail: "Quem tem a ligação pode ler até expirar ou ser revogada." }, { term: "Atualizar/revogar", detail: "Atualizar cria novo snapshot e ligação; revogar desativa a atual." },
      ], note: "Mensagens posteriores não entram automaticamente no snapshot existente." },
      { id: sectionIds.models, title: "6. Modelos e painéis", description: "Um modelo para foco; até três para comparação.", items: [
        { term: "Selecionar", detail: "Veja classe de uso e créditos base antes de enviar." }, { term: "Ativo", detail: "Só painéis ativos recebem a pergunta comum." }, { term: "Seguimento individual", detail: "Use o controlo do painel de resposta." }, { term: "Pausar", detail: "Desativa temporariamente sem remover." }, { term: "Fechar", detail: "Remove o painel após confirmação." }, { term: "Limitado", detail: "Consulte o motivo e use uma alternativa recomendada." }, { term: "Estimativa", detail: "Visível antes de enviar; textos longos e ficheiros podem aumentar." },
      ] },
      { id: sectionIds.review, title: "7. Usar AI Review", description: "Após duas ou três respostas, abra AI Review, escolha modo, veja créditos e execute.", items: [
        { term: "Equilibrado", detail: "Acordos, diferenças, omissões, contradições e utilidade." }, { term: "Evidência", detail: "Suporte fraco, conflitos e verificação externa." }, { term: "Ação", detail: "Opções, compromissos, riscos e próximos passos." }, { term: "Resultado", detail: "Consenso, diferenças, contradições, omissões e verificação." },
      ], note: "AI Review só compara as respostas fornecidas; não navega, não verifica factos de forma independente nem garante a resposta correta." },
      { id: sectionIds.files, title: "8. Ficheiros e Google Drive", description: "Até 5 ficheiros, 10 MB cada e 25 MB no total por pedido em planos elegíveis.", items: [
        { term: "Suportados", detail: "PNG, JPEG, WebP, PDF, texto, Word, Excel, PowerPoint, OpenDocument e exportações Drive." }, { term: "Falha", detail: "Retire palavra-passe, reexporte, reduza ou cole o texto essencial." }, { term: "Por modelo", detail: "Imagens e documentos longos podem ser tratados de modo diferente." }, { term: "Private Mode", detail: "Não guarda histórico, mas o ficheiro pode ser enviado ao fornecedor." }, { term: "Sensível", detail: "Anexe apenas conteúdo autorizado para processamento." },
      ] },
      { id: sectionIds.credits, title: "9. Créditos e planos", description: "Unidade comum apesar de custos e raciocínio diferentes.", items: [
        { term: "Bases", detail: "Standard 1, Advanced 4, Premium 8, Reasoning 12–16 e Research 20–30 em pedidos curtos típicos." }, { term: "Entrada longa", detail: "Mais de 16k, 50k e 100k tokens estimados: 1,5×, 2× e 3×." }, { term: "Ficheiros", detail: "O conteúdo extraído conta como entrada." }, { term: "AI Review", detail: "Mostra estimativa separada antes de executar." }, { term: "Dois saldos", detail: "Créditos do plano reiniciam; comprados ficam separados segundo os termos." }, { term: "Falhas", detail: "Erros e respostas vazias são reembolsados; cancelamento devolve reserva não usada." },
      ] },
      { id: sectionIds.troubleshooting, title: "10. Resolução de problemas", description: "Tente uma vez no menor âmbito e guarde evidências.", items: [
        { term: "Sem resposta", detail: "Veja o estado, tente novamente e use um modelo alternativo." }, { term: "Um modelo", detail: "Continue com painéis bem-sucedidos e veja o motivo." }, { term: "Upload", detail: "Verifique formato, tamanho, palavra-passe e rede com um ficheiro." }, { term: "Créditos", detail: "Atualize após liquidação e contacte suporte se persistir." }, { term: "Trace ID", detail: "Inclua ID, hora, modelo, navegador e anexos." }, { term: "Estado", detail: "Abra tomverse.app/status." },
      ] },
    ],
    reviewVideoTitle: "Exemplo do fluxo AI Review", reviewVideoCaption: "Dados de demonstração controlados; não mostra chats privados reais.", openChat: "Abrir Tomverse Chat", allHelp: "Ver todo o Centro de ajuda",
  },
};
