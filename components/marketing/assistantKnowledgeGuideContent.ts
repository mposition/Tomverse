import type { Language } from "@/components/LanguageProvider";
import type {
  AssistantKnowledgeGuideStep,
} from "@/lib/assistantKnowledgeGuide";

type GuidePath = {
  label: string;
  title: string;
  body: string;
  steps: string[];
};

type DetailedStep = {
  number: string;
  title: string;
  where: string;
  action: string;
  result: string;
};

export type AssistantKnowledgeGuideCopy = {
  eyebrow: string;
  title: string;
  description: string;
  outcomeLabel: string;
  outcomeTitle: string;
  outcomeItems: string[];
  videoLabel: string;
  videoHint: string;
  demoEyebrow: string;
  demoTitle: string;
  demoDescription: string;
  supademoLabel: string;
  nativeDemoLabel: string;
  nativeDemoNote: string;
  stepProgress: (current: number, total: number) => string;
  demoPrevious: string;
  demoNext: string;
  demoRestart: string;
  steps: Array<{
    id: AssistantKnowledgeGuideStep;
    label: string;
    title: string;
    body: string;
    screenTitle: string;
    screenHint: string;
    targetLabel: string;
    result: string;
  }>;
  choosePathEyebrow: string;
  choosePathTitle: string;
  choosePathDescription: string;
  createPath: GuidePath;
  importPath: GuidePath;
  importAvailableLabel: string;
  importUnavailableLabel: string;
  importAvailableBody: string;
  importUnavailableBody: string;
  importBoundary: string;
  detailsEyebrow: string;
  detailsTitle: string;
  detailsDescription: string;
  detailedSteps: DetailedStep[];
  boundariesEyebrow: string;
  boundariesTitle: string;
  boundaryItems: string[];
  helpEyebrow: string;
  helpTitle: string;
  helpItems: Array<{ title: string; body: string }>;
  ctaAuthenticated: string;
  ctaGuest: string;
  ctaHint: string;
  exampleTitle: string;
  exampleMaterialLabel: string;
  exampleMaterial: string;
  examplePromptLabel: string;
  examplePrompt: string;
  exampleNote: string;
  exampleOutputLabel: string;
  exampleOutput: string;
};

export const assistantKnowledgeGuideContent: Record<Language, AssistantKnowledgeGuideCopy> = {
  "ko": {
    stepProgress: (current, total) => `${total}단계 중 ${current}단계`,
    "eyebrow": "나의 AI 어시스턴트 + Knowledge",
    "title": "내 자료와 답변 방식으로 만드는 AI 어시스턴트",
    "description": "내가 원하는 답변 방식과 자주 쓰는 자료를 하나의 비공개 AI 어시스턴트에 담는 과정을 실제 Tomverse 화면으로 안내합니다.",
    "outcomeLabel": "이 가이드가 끝나면",
    "outcomeTitle": "자료를 근거로 답하는 내 전용 어시스턴트가 준비됩니다",
    "outcomeItems": [
      "답변 방식이 저장된 AI 어시스턴트",
      "질문과 관련된 Knowledge 발췌",
      "새 대화에서 바로 선택할 수 있는 구성"
    ],
    "videoLabel": "한국어 화면 · 한국어 음성",
    "videoHint": "소리를 끄더라도 같은 내용의 한국어 자막을 볼 수 있습니다.",
    "demoEyebrow": "클릭형 실습",
    "demoTitle": "버튼을 눌러 실제 순서를 익혀보세요",
    "demoDescription": "계정이나 파일을 바꾸지 않는 연습 화면입니다. 각 강조 버튼을 누르면 다음 단계로 이동합니다.",
    "supademoLabel": "단계별 화면 연습",
    "nativeDemoLabel": "Tomverse 단계별 실습",
    "nativeDemoNote": "버튼이나 키보드로 단계를 이동하며 저장·질문 순서를 익힐 수 있습니다. 실제 계정이나 파일을 변경하지 않습니다.",
    "demoPrevious": "이전",
    "demoNext": "다음 단계",
    "demoRestart": "처음부터 다시",
    "steps": [
      {
        "id": "create_assistant",
        "label": "1단계",
        "title": "어시스턴트 만들기",
        "body": "설정의 ‘나의 AI 어시스턴트’에서 새 구성을 시작합니다.",
        "screenTitle": "설정 / 나의 AI 어시스턴트",
        "screenHint": "새 AI 어시스턴트를 만들거나 Agent Skill·Tomverse 패키지를 가져오는 곳입니다.",
        "targetLabel": "새 어시스턴트 만들기",
        "result": "이름과 설명을 입력하는 편집 화면이 열립니다."
      },
      {
        "id": "add_knowledge",
        "label": "2단계",
        "title": "Knowledge 추가하고 저장하기",
        "body": "답변 방식과 파일을 정한 뒤 새 버전으로 저장합니다.",
        "screenTitle": "AI 어시스턴트 편집",
        "screenHint": "예: 원문에 있는 일정과 준비물만 정리하고, 없는 정보는 미정으로 표시하며 근거 문장을 붙여 주세요.",
        "targetLabel": "파일 추가 → 지시문과 모델 저장",
        "result": "처리가 끝난 파일이 현재 버전의 Knowledge로 선택됩니다."
      },
      {
        "id": "start_chat",
        "label": "3단계",
        "title": "대화에서 사용하기",
        "body": "대화 도구에서 저장한 어시스턴트를 선택하고 첫 질문을 보냅니다.",
        "screenTitle": "새 대화 / AI 어시스턴트",
        "screenHint": "질문과 관련된 발췌만 답변의 참고 맥락으로 전달됩니다.",
        "targetLabel": "독서 모임 도우미 선택",
        "result": "답변 아래에서 사용된 Knowledge 발췌 수를 확인할 수 있습니다."
      }
    ],
    "choosePathEyebrow": "시작 방법",
    "choosePathTitle": "처음 만들거나, 이미 쓰던 구성을 가져오세요",
    "choosePathDescription": "첫 결과를 만드는 데 필요한 경로만 선택하세요. 고급 설정은 나중에 바꿀 수 있습니다.",
    "createPath": {
      "label": "처음 만들기",
      "title": "이름과 지시문부터 시작",
      "body": "기존 구성이 없다면 가장 짧은 세 단계로 첫 답변을 확인합니다.",
      "steps": [
        "이름과 답변 방식 입력",
        "Knowledge 파일 하나 추가",
        "대화에서 선택하고 질문"
      ]
    },
    "importPath": {
      "label": "기존 구성 가져오기",
      "title": "Agent Skill 또는 Tomverse 패키지 가져오기",
      "body": "패키지를 검토한 뒤 지시문과 자료 후보를 새 어시스턴트로 변환합니다.",
      "steps": [
        "ZIP 또는 Tomverse 패키지 선택",
        "가져오지 못하는 항목 확인",
        "Knowledge와 모델을 검토하고 게시"
      ]
    },
    "importAvailableLabel": "이 계정에서 가져오기 사용 가능",
    "importUnavailableLabel": "가져오기는 단계적으로 제공 중",
    "importAvailableBody": "설정 → 나의 AI 어시스턴트에서 ‘구성 가져오기’를 선택할 수 있습니다.",
    "importUnavailableBody": "버튼이 보이지 않으면 이름과 지시문을 입력하고 자료를 추가하는 수동 생성 경로를 사용하세요.",
    "importBoundary": "Agent Skill의 SKILL.md·references·일부 assets와 Tomverse 패키지를 지원합니다. 스크립트는 실행하지 않으며, 외부 도구와 모델은 자동 연결하지 않습니다. ChatGPT GPT 설정 파일을 자동 변환하는 기능은 아직 지원하지 않습니다.",
    "detailsEyebrow": "화면별 안내",
    "detailsTitle": "어디에서 무엇을 눌러야 하는지",
    "detailsDescription": "영상이 빠르거나 특정 단계에서 막혔다면 아래 경로와 저장 결과를 확인하세요.",
    "detailedSteps": [
      {
        "number": "01",
        "title": "새 어시스턴트 생성",
        "where": "설정 → 나의 AI 어시스턴트",
        "action": "새 구성의 이름과 설명을 입력합니다.",
        "result": "편집 가능한 초안이 만들어집니다."
      },
      {
        "number": "02",
        "title": "답변 방식 지정",
        "where": "AI 어시스턴트 편집 → 지시문",
        "action": "말투보다 결과의 형식과 판단 순서를 구체적으로 적습니다.",
        "result": "이후 새 답변에 동일한 방식이 적용됩니다."
      },
      {
        "number": "03",
        "title": "Knowledge 연결",
        "where": "AI 어시스턴트 편집 → 이 계정이 사용할 지식 파일",
        "action": "파일을 추가하고 처리 완료 상태를 확인한 뒤 선택합니다.",
        "result": "선택한 파일이 저장된 버전에 고정됩니다."
      },
      {
        "number": "04",
        "title": "첫 질문 보내기",
        "where": "대화 → AI 어시스턴트",
        "action": "방금 저장한 구성을 선택하고 자료와 관련된 질문을 보냅니다.",
        "result": "답변에 사용된 Knowledge 여부를 확인할 수 있습니다."
      }
    ],
    "boundariesEyebrow": "알아둘 점",
    "boundariesTitle": "비공개이지만, 답변은 원문과 함께 확인하세요",
    "boundaryItems": [
      "어시스턴트와 Knowledge는 공개 목록이나 다른 사용자에게 공유되지 않습니다.",
      "Knowledge의 관련 발췌는 답변을 생성하는 AI 제공자에게 참고 자료로 전달됩니다.",
      "파일 속 문장은 지시가 아닌 참고 자료로 처리됩니다.",
      "중요한 수치와 결정은 답변만 믿지 말고 원문에서 다시 확인하세요."
    ],
    "helpEyebrow": "막혔을 때",
    "helpTitle": "자주 생기는 세 가지 상황",
    "helpItems": [
      {
        "title": "파일을 선택할 수 없어요",
        "body": "처리 중인 파일은 선택할 수 없습니다. 상태가 준비됨으로 바뀐 뒤 다시 선택하세요."
      },
      {
        "title": "대화에서 어시스턴트가 안 보여요",
        "body": "지시문과 모델 저장을 완료했는지 확인하세요. 초안만 만든 구성은 대화에서 사용할 수 없습니다."
      },
      {
        "title": "자료 내용이 답변에 없어요",
        "body": "질문에 파일명, 문서의 주제나 찾을 표현을 구체적으로 적고 다시 질문하세요."
      }
    ],
    "ctaAuthenticated": "Tomverse에서 직접 만들기",
    "ctaGuest": "로그인하고 직접 만들기",
    "ctaHint": "실제 설정 가이드는 저장 결과를 기준으로 다음 단계부터 이어집니다.",
    "exampleTitle": "내 자료로 질문해 보는 가상 예제",
    "exampleMaterialLabel": "Knowledge에 넣을 가상 자료",
    "examplePromptLabel": "첫 질문",
    "exampleMaterial": "가상 공지: 독서 모임은 11월 7일 오후 2시에 시작합니다. 읽은 책 한 권과 메모를 가져오세요. 참석 여부는 11월 3일까지 알려주세요. 장소는 추후 안내합니다.",
    "examplePrompt": "동호회 안내문을 참고해서 모임 날짜, 준비물, 회신 기한을 알려줘. 장소가 아직 정해지지 않았다면 그렇게 말하고, 각 항목에 근거 문장을 붙여 줘.",
    "exampleNote": "편집용 가상 자료와 시연 답변입니다. 실제 모델 실행 결과가 아니며 파일을 자동 학습했다는 뜻이 아닙니다. 원래 영상은 기존 UI 경로를 보여 줍니다.",
    "exampleOutputLabel": "원문과 대조할 시연 답변",
    "exampleOutput": "모임: 11월 7일 오후 2시 — “독서 모임은 11월 7일 오후 2시에 시작합니다.”\n준비물: 읽은 책 한 권과 메모 — “읽은 책 한 권과 메모를 가져오세요.”\n회신: 11월 3일까지 — “참석 여부는 11월 3일까지 알려주세요.”\n장소: 미정 — “장소는 추후 안내합니다.”"
  },
  "en": {
    stepProgress: (current, total) => `Step ${current} of ${total}`,
    "eyebrow": "My AI Assistant + Knowledge",
    "title": "An AI assistant built around your material and response style",
    "description": "Use the real Tomverse interface to combine the way you want answers written with the material you use often in one private AI assistant.",
    "outcomeLabel": "By the end",
    "outcomeTitle": "You will have an assistant that can answer with your material",
    "outcomeItems": [
      "An AI assistant with a saved response style",
      "Relevant excerpts from your Knowledge",
      "A configuration ready to select in a new conversation"
    ],
    "videoLabel": "English interface · English voiceover",
    "videoHint": "English captions cover the same instructions when audio is muted.",
    "demoEyebrow": "Interactive practice",
    "demoTitle": "Select the controls to learn the real sequence",
    "demoDescription": "This practice view does not change an account or upload a file. Select each highlighted control to continue.",
    "supademoLabel": "Step-by-step screen practice",
    "nativeDemoLabel": "Tomverse step-by-step practice",
    "nativeDemoNote": "Use the controls or keyboard to practise saving and asking in order. This view does not change your account or files.",
    "demoPrevious": "Previous",
    "demoNext": "Next step",
    "demoRestart": "Start again",
    "steps": [
      {
        "id": "create_assistant",
        "label": "Step 1",
        "title": "Create your assistant",
        "body": "Start a new configuration in My AI Assistants under Settings.",
        "screenTitle": "Settings / My AI Assistants",
        "screenHint": "Create an assistant or bring in an external configuration here.",
        "targetLabel": "Create new assistant",
        "result": "The editor opens for a name and description."
      },
      {
        "id": "add_knowledge",
        "label": "Step 2",
        "title": "Add Knowledge and save",
        "body": "Set the response style, choose a file, and save a new version.",
        "screenTitle": "Edit AI Assistant",
        "screenHint": "Example: list only dates and items in the source, mark missing information as unknown and quote supporting sentences.",
        "targetLabel": "Add file → Save instructions and models",
        "result": "A processed file is selected as Knowledge for the current version."
      },
      {
        "id": "start_chat",
        "label": "Step 3",
        "title": "Use it in a conversation",
        "body": "Choose the saved assistant from the conversation tools and send the first question.",
        "screenTitle": "New conversation / AI Assistant",
        "screenHint": "Only excerpts relevant to the question are supplied as reference context.",
        "targetLabel": "Select Book-club assistant",
        "result": "The answer shows how many Knowledge excerpts were used."
      }
    ],
    "choosePathEyebrow": "Choose a starting point",
    "choosePathTitle": "Start fresh, or bring in a configuration you already use",
    "choosePathDescription": "Pick only the path needed for the first useful answer. Advanced settings can wait.",
    "createPath": {
      "label": "Start fresh",
      "title": "Begin with a name and instructions",
      "body": "If you have no existing configuration, reach the first grounded answer in three short steps.",
      "steps": [
        "Enter a name and response style",
        "Add one Knowledge file",
        "Select it in chat and ask"
      ]
    },
    "importPath": {
      "label": "Bring in an existing setup",
      "title": "Import an Agent Skill or Tomverse package",
      "body": "Review a package, then turn its instructions and material candidates into an assistant.",
      "steps": [
        "Choose a ZIP or Tomverse package",
        "Review what cannot be carried over",
        "Review Knowledge and models, then publish"
      ]
    },
    "importAvailableLabel": "Import is available for this account",
    "importUnavailableLabel": "Import is being released gradually",
    "importAvailableBody": "Choose Import external configuration from Settings → My AI Assistants.",
    "importUnavailableBody": "If the button is absent, use the manual path: enter a name and instructions, then add your material.",
    "importBoundary": "Tomverse supports Agent Skill packages with SKILL.md, references, selected assets, and native Tomverse packages. It does not run scripts or automatically connect external tools and models. Automatic conversion of ChatGPT GPT configuration files is not supported yet.",
    "detailsEyebrow": "Screen-by-screen",
    "detailsTitle": "Where to go and what to select",
    "detailsDescription": "Use these paths and saved outcomes when the video moves too quickly or one step does not work.",
    "detailedSteps": [
      {
        "number": "01",
        "title": "Create an assistant",
        "where": "Settings → My AI Assistants",
        "action": "Enter a name and description for the new configuration.",
        "result": "Tomverse creates an editable draft."
      },
      {
        "number": "02",
        "title": "Set the response method",
        "where": "Edit AI Assistant → Instructions",
        "action": "Describe the output structure and decision order, not only a tone of voice.",
        "result": "New answers use the same method after you save."
      },
      {
        "number": "03",
        "title": "Connect Knowledge",
        "where": "Edit AI Assistant → Knowledge files this account can use",
        "action": "Add a file, wait until it is ready, then select it.",
        "result": "The saved version pins the selected file."
      },
      {
        "number": "04",
        "title": "Send the first question",
        "where": "Conversation → AI Assistant",
        "action": "Select the configuration and ask a question related to the material.",
        "result": "The answer indicates whether Knowledge was used."
      }
    ],
    "boundariesEyebrow": "Before you start",
    "boundariesTitle": "Private to your account, with important answers checked against the source",
    "boundaryItems": [
      "Assistants and Knowledge are not published or shared with other users.",
      "Relevant Knowledge excerpts are sent to the AI provider generating the answer as reference material.",
      "Text inside a file is treated as reference material, not as instructions to the assistant.",
      "Verify important numbers and decisions against the source document."
    ],
    "helpEyebrow": "If you get stuck",
    "helpTitle": "Three common situations",
    "helpItems": [
      {
        "title": "I cannot select a file",
        "body": "Files still processing cannot be selected. Wait until the status changes to ready."
      },
      {
        "title": "The assistant is missing in chat",
        "body": "Confirm that you saved instructions and models. A configuration that only has a draft cannot be used in a conversation."
      },
      {
        "title": "The answer did not use my material",
        "body": "Mention the document topic, filename, or wording you expect to find, then ask again."
      }
    ],
    "ctaAuthenticated": "Build it in Tomverse",
    "ctaGuest": "Sign in and build it",
    "ctaHint": "The in-product guide resumes from what has actually been saved.",
    "exampleTitle": "A fictional example with your material",
    "exampleMaterialLabel": "Fictional material for Knowledge",
    "examplePromptLabel": "First question",
    "exampleMaterial": "Fictional notice: The book club starts on 7 November at 2 pm. Bring one book you have read and your notes. Confirm attendance by 3 November. The venue will be announced later.",
    "examplePrompt": "Use the club notice to list the meeting date, what to bring and the reply deadline. Say if the venue is still undecided, and quote the sentence supporting each item.",
    "exampleNote": "Fictional material and an editorial demonstration answer, not a real model result or automatic training on a file. The original video shows the existing UI path.",
    "exampleOutputLabel": "Demonstration answer to check against the source",
    "exampleOutput": "Meeting: 7 November at 2 pm — “The book club starts on 7 November at 2 pm.”\nBring: one book and notes — “Bring one book you have read and your notes.”\nReply: by 3 November — “Confirm attendance by 3 November.”\nVenue: undecided — “The venue will be announced later.”"
  },
  "zh": {
    stepProgress: (current, total) => `第 ${current} 步，共 ${total} 步`,
    "eyebrow": "我的 AI 助手 + Knowledge",
    "title": "用自己的资料与回答方式创建 AI 助手",
    "description": "通过真实的中文 Tomverse 界面，把你希望的回答方式和常用资料放进一个仅限自己使用的 AI 助手。",
    "outcomeLabel": "完成本指南后",
    "outcomeTitle": "你将拥有一个能参考自己资料回答的专属助手",
    "outcomeItems": [
      "已保存回答方式的 AI 助手",
      "与问题相关的 Knowledge 摘录",
      "可在新对话中直接选择的配置"
    ],
    "videoLabel": "中文界面 · 中文语音",
    "videoHint": "关闭声音后，仍可通过中文字幕获得相同说明。",
    "demoEyebrow": "点击练习",
    "demoTitle": "点击按钮，熟悉实际操作顺序",
    "demoDescription": "这是不会修改账户或上传文件的练习画面。点击每个高亮控件即可继续。",
    "supademoLabel": "分步界面练习",
    "nativeDemoLabel": "Tomverse 分步练习",
    "nativeDemoNote": "用按钮或键盘练习保存与提问顺序，不会修改真实账户或文件。",
    "demoPrevious": "上一步",
    "demoNext": "下一步",
    "demoRestart": "重新开始",
    "steps": [
      {
        "id": "create_assistant",
        "label": "第 1 步",
        "title": "创建助手",
        "body": "在“设置”的“我的 AI 配置”中创建新配置。",
        "screenTitle": "设置 / 我的 AI 配置",
        "screenHint": "在这里创建助手，或导入外部配置。",
        "targetLabel": "新建配置",
        "result": "系统会打开用于填写名称和说明的编辑页面。"
      },
      {
        "id": "add_knowledge",
        "label": "第 2 步",
        "title": "添加 Knowledge 并保存",
        "body": "设置回答方式、选择文件，然后保存新修订。",
        "screenTitle": "编辑 AI 配置",
        "screenHint": "示例：只整理原文中的日期与准备物品，缺失信息标为未定并附依据句子。",
        "targetLabel": "添加文件 → 保存指令与模型",
        "result": "处理完成的文件会被选为当前修订的 Knowledge。"
      },
      {
        "id": "start_chat",
        "label": "第 3 步",
        "title": "在对话中使用",
        "body": "从对话工具中选择已保存的助手，并发送第一个问题。",
        "screenTitle": "新对话 / AI 助手",
        "screenHint": "系统只会把与问题相关的摘录作为参考上下文。",
        "targetLabel": "选择读书会助手",
        "result": "回答下方会显示使用了多少条 Knowledge 摘录。"
      }
    ],
    "choosePathEyebrow": "选择开始方式",
    "choosePathTitle": "从头创建，或导入你已经在使用的配置",
    "choosePathDescription": "只选择获得第一个有效回答所需的路径。高级设置可以稍后调整。",
    "createPath": {
      "label": "从头创建",
      "title": "从名称和指令开始",
      "body": "如果没有现有配置，只需三个简短步骤即可获得第一个基于资料的回答。",
      "steps": [
        "填写名称和回答方式",
        "添加一个 Knowledge 文件",
        "在对话中选择并提问"
      ]
    },
    "importPath": {
      "label": "导入现有配置",
      "title": "导入 Agent Skill 或 Tomverse 包",
      "body": "先审阅包内容，再把其中的指令和资料候选转换为助手。",
      "steps": [
        "选择 ZIP 或 Tomverse 包",
        "确认无法带入的项目",
        "检查 Knowledge 和模型后发布"
      ]
    },
    "importAvailableLabel": "此账户可以使用导入功能",
    "importUnavailableLabel": "导入功能正在逐步开放",
    "importAvailableBody": "前往“设置 → 我的 AI 配置”，选择“导入外部配置”。",
    "importUnavailableBody": "如果没有该按钮，请手动创建：填写名称与指令，再添加资料。",
    "importBoundary": "Tomverse 支持包含 SKILL.md、references、部分 assets 的 Agent Skill 包，以及 Tomverse 原生包。系统不会运行脚本，也不会自动连接外部工具或模型。目前还不支持自动转换 ChatGPT GPT 配置文件。",
    "detailsEyebrow": "逐屏说明",
    "detailsTitle": "去哪里，点击什么",
    "detailsDescription": "如果视频过快，或某一步没有成功，请对照下面的路径和保存结果。",
    "detailedSteps": [
      {
        "number": "01",
        "title": "创建助手",
        "where": "设置 → 我的 AI 配置",
        "action": "输入新配置的名称和说明。",
        "result": "Tomverse 会创建一个可编辑的草稿。"
      },
      {
        "number": "02",
        "title": "指定回答方式",
        "where": "编辑 AI 配置 → 指令",
        "action": "具体说明输出结构和判断顺序，而不只是语气。",
        "result": "保存后，新回答会采用相同方式。"
      },
      {
        "number": "03",
        "title": "连接 Knowledge",
        "where": "编辑 AI 配置 → 此账户可使用的知识文件",
        "action": "添加文件，等待状态变为就绪，然后选中它。",
        "result": "已保存的修订会固定使用所选文件。"
      },
      {
        "number": "04",
        "title": "发送第一个问题",
        "where": "对话 → AI 助手",
        "action": "选择刚保存的配置，并提出与资料相关的问题。",
        "result": "你可以确认回答是否使用了 Knowledge。"
      }
    ],
    "boundariesEyebrow": "开始前须知",
    "boundariesTitle": "内容仅限你的账户，但重要回答仍需核对原文",
    "boundaryItems": [
      "助手和 Knowledge 不会公开，也不会与其他用户共享。",
      "相关 Knowledge 摘录会作为参考资料发送给生成回答的 AI 提供商。",
      "文件中的文字会被当作参考资料，而不是对助手的指令。",
      "重要数字和决定请回到原始文档再次确认。"
    ],
    "helpEyebrow": "遇到问题时",
    "helpTitle": "三种常见情况",
    "helpItems": [
      {
        "title": "无法选择文件",
        "body": "仍在处理的文件不能选择。请等待状态变为“已就绪”后再试。"
      },
      {
        "title": "对话中找不到助手",
        "body": "请确认已经保存指令和模型。只有草稿、尚未发布修订的配置不能用于对话。"
      },
      {
        "title": "回答没有使用我的资料",
        "body": "请写明文档主题、文件名或希望查找的具体措辞，然后再次提问。"
      }
    ],
    "ctaAuthenticated": "在 Tomverse 中亲自创建",
    "ctaGuest": "登录并亲自创建",
    "ctaHint": "产品内指南会根据实际保存结果，从下一步继续。",
    "exampleTitle": "使用自己资料的虚构示例",
    "exampleMaterialLabel": "用于 Knowledge 的虚构资料",
    "examplePromptLabel": "第一个问题",
    "exampleMaterial": "虚构通知：读书会于11月7日下午2点开始。请带一本读过的书和笔记。请在11月3日前确认是否参加。地点稍后通知。",
    "examplePrompt": "请参考社团通知，列出活动日期、准备物品和回复截止时间。地点尚未确定时请明确说明，并为每项附上依据句子。",
    "exampleNote": "这是虚构资料与编辑演示回答，不是真实模型结果，也不表示自动训练文件。原视频展示现有界面路径。",
    "exampleOutputLabel": "与原文核对的演示回答",
    "exampleOutput": "活动：11月7日下午2点 — “读书会于11月7日下午2点开始。”\n准备：一本书和笔记 — “请带一本读过的书和笔记。”\n回复：11月3日前 — “请在11月3日前确认是否参加。”\n地点：未定 — “地点稍后通知。”"
  },
  "fr": {
    stepProgress: (current, total) => `Étape ${current} sur ${total}`,
    "eyebrow": "Mon assistant d’IA + Knowledge",
    "description": "Associez votre façon de répondre et vos documents habituels à un assistant privé. Ce guide présente les étapes d’enregistrement, la sélection de Knowledge et la vérification des extraits utilisés.",
    "outcomeLabel": "À la fin",
    "outcomeTitle": "Un assistant qui peut consulter vos documents",
    "outcomeItems": [
      "Une méthode de réponse enregistrée",
      "Des extraits Knowledge pertinents",
      "Une configuration à choisir dans une nouvelle conversation"
    ],
    "videoLabel": "Interface, voix et sous-titres en anglais",
    "videoHint": "La vidéo disponible est en anglais. Les instructions écrites et l’exercice ci-dessous sont en français.",
    "demoEyebrow": "Exercice interactif",
    "demoTitle": "Apprenez la séquence en sélectionnant les boutons",
    "demoDescription": "Cet exercice ne modifie aucun compte et ne téléverse aucun fichier. Sélectionnez le bouton mis en évidence pour avancer.",
    "nativeDemoLabel": "Exercice Tomverse étape par étape",
    "demoPrevious": "Précédent",
    "demoNext": "Étape suivante",
    "demoRestart": "Recommencer",
    "choosePathEyebrow": "Pour commencer",
    "choosePathTitle": "Créez un assistant ou importez votre configuration",
    "choosePathDescription": "Choisissez le chemin nécessaire au premier résultat. Les réglages avancés pourront attendre.",
    "createPath": {
      "label": "Créer",
      "title": "Un nom et des instructions",
      "body": "Créez votre premier assistant avec des documents en trois étapes.",
      "steps": [
        "Saisir le nom et la méthode de réponse",
        "Ajouter un fichier Knowledge",
        "Choisir l’assistant et poser une question"
      ]
    },
    "importPath": {
      "label": "Importer",
      "title": "Importer un Agent Skill ou un paquet Tomverse",
      "body": "Examinez le paquet avant de convertir ses instructions et documents en assistant.",
      "steps": [
        "Choisir le ZIP ou le paquet Tomverse",
        "Examiner les éléments non importables",
        "Vérifier Knowledge et les modèles, puis publier"
      ]
    },
    "importAvailableLabel": "Import disponible pour ce compte",
    "importUnavailableLabel": "Import en cours de déploiement",
    "importAvailableBody": "Dans Paramètres → Mes assistants d’IA, choisissez l’import de configuration externe.",
    "importBoundary": "Les paquets Agent Skill avec SKILL.md, references et certains assets, ainsi que les paquets Tomverse, sont pris en charge. Aucun script n’est exécuté ; outils et modèles externes ne sont pas connectés automatiquement. La conversion automatique des configurations ChatGPT GPT n’est pas prise en charge.",
    "detailsEyebrow": "Écran par écran",
    "detailsTitle": "Où aller et quoi sélectionner",
    "detailsDescription": "Si la vidéo est trop rapide, retrouvez ici les chemins et les résultats à enregistrer.",
    "boundariesEyebrow": "À savoir",
    "boundariesTitle": "Privé à votre compte, avec les réponses à vérifier dans la source",
    "boundaryItems": [
      "Assistants et Knowledge ne sont ni publiés ni partagés avec d’autres utilisateurs.",
      "Les extraits Knowledge pertinents sont transmis au fournisseur d’IA qui génère la réponse.",
      "Le texte des fichiers sert de référence, pas d’instruction à l’assistant.",
      "Vérifiez les chiffres et décisions importants dans le document original."
    ],
    "helpEyebrow": "En cas de problème",
    "helpTitle": "Trois situations fréquentes",
    "helpItems": [
      {
        "title": "Je ne peux pas sélectionner le fichier",
        "body": "Attendez que le traitement soit terminé et que le fichier soit prêt."
      },
      {
        "title": "L’assistant manque dans la conversation",
        "body": "Vérifiez l’enregistrement des instructions et modèles. Un simple brouillon ne peut pas être utilisé."
      },
      {
        "title": "Mes documents ne sont pas utilisés",
        "body": "Précisez le sujet, le nom du fichier ou les mots à chercher, puis posez à nouveau la question."
      }
    ],
    "ctaAuthenticated": "Créer dans Tomverse",
    "ctaGuest": "Se connecter et créer",
    "ctaHint": "Le guide du produit reprend selon les éléments réellement enregistrés.",
    "steps": [
      {
        "id": "create_assistant",
        "label": "1",
        "title": "Créer l’assistant",
        "body": "Saisissez un nom et une description dans Paramètres.",
        "screenTitle": "Paramètres / Mes assistants d’IA",
        "screenHint": "Exemple : listez uniquement dates et objets de la source, signalez l’inconnu et citez les phrases justificatives.",
        "targetLabel": "Créer un assistant",
        "result": "Un brouillon s’ouvre pour le nom et la description."
      },
      {
        "id": "add_knowledge",
        "label": "2",
        "title": "Ajouter Knowledge et enregistrer",
        "body": "Rédigez les instructions, choisissez un fichier prêt et enregistrez une version.",
        "screenTitle": "Modifier l’assistant d’IA",
        "screenHint": "Exemple : listez uniquement dates et objets de la source, signalez l’inconnu et citez les phrases justificatives.",
        "targetLabel": "Ajouter un fichier → Enregistrer instructions et modèles",
        "result": "Le fichier Knowledge choisi est fixé à la version enregistrée."
      },
      {
        "id": "start_chat",
        "label": "3",
        "title": "Utiliser dans la conversation",
        "body": "Choisissez l’assistant enregistré dans les outils de conversation et posez une question sur les documents.",
        "screenTitle": "Nouvelle conversation / Assistant d’IA",
        "screenHint": "Exemple : listez uniquement dates et objets de la source, signalez l’inconnu et citez les phrases justificatives.",
        "targetLabel": "Choisir l’assistant du club de lecture",
        "result": "Examinez les extraits Knowledge utilisés sous la réponse."
      }
    ],
    "detailedSteps": [
      {
        "number": "01",
        "title": "Créer l’assistant",
        "where": "Paramètres / Mes assistants d’IA",
        "action": "Saisissez un nom et une description dans Paramètres.",
        "result": "Un brouillon s’ouvre pour le nom et la description."
      },
      {
        "number": "02",
        "title": "Définir la méthode de réponse",
        "where": "Modifier l’assistant d’IA",
        "action": "Demandez de conserver uniquement les informations de la source et de signaler les éléments absents.",
        "result": "Après enregistrement, les nouvelles questions peuvent employer cette méthode."
      },
      {
        "number": "03",
        "title": "Ajouter Knowledge et enregistrer",
        "where": "Modifier l’assistant d’IA",
        "action": "Rédigez les instructions, choisissez un fichier prêt et enregistrez une version.",
        "result": "Le fichier Knowledge choisi est fixé à la version enregistrée."
      },
      {
        "number": "04",
        "title": "Utiliser dans la conversation",
        "where": "Nouvelle conversation / Assistant d’IA",
        "action": "Choisissez l’assistant enregistré dans les outils de conversation et posez une question sur les documents.",
        "result": "Examinez les extraits Knowledge utilisés sous la réponse."
      }
    ],
    "title": "Un assistant d’IA adapté à vos documents et à vos réponses",
    "supademoLabel": "Exercice étape par étape",
    "nativeDemoNote": "Utilisez les boutons ou le clavier pour apprendre à enregistrer puis poser une question. Cet exercice ne modifie ni votre compte ni vos fichiers.",
    "importUnavailableBody": "Si le bouton est absent, créez manuellement l’assistant : nom, instructions puis documents.",
    "exampleTitle": "Un exemple fictif avec vos documents",
    "exampleMaterialLabel": "Document fictif pour Knowledge",
    "examplePromptLabel": "Première question",
    "exampleMaterial": "Annonce fictive : le club de lecture commence le 7 novembre à 14 h. Apportez un livre lu et vos notes. Confirmez votre présence avant le 3 novembre. Le lieu sera communiqué ultérieurement.",
    "examplePrompt": "À partir de l’annonce du club, donne la date, les objets à apporter et le délai de réponse. Signale si le lieu est indécis et cite la phrase de chaque élément.",
    "exampleNote": "Document fictif et réponse rédigée pour la démonstration, sans résultat réel de modèle ni entraînement automatique sur un fichier. La vidéo montre le chemin de l’interface existante.",
    "exampleOutputLabel": "Réponse de démonstration à comparer à la source",
    "exampleOutput": "Réunion : 7 novembre à 14 h — « le club de lecture commence le 7 novembre à 14 h. »\nÀ apporter : un livre et des notes — « Apportez un livre lu et vos notes. »\nRéponse : avant le 3 novembre — « Confirmez votre présence avant le 3 novembre. »\nLieu : indéterminé — « Le lieu sera communiqué ultérieurement. »"
  },
  "de": {
    stepProgress: (current, total) => `Schritt ${current} von ${total}`,
    "eyebrow": "Mein KI-Assistent + Knowledge",
    "description": "Verbinden Sie Ihre Antwortweise und häufig genutzte Materialien in einem privaten Assistenten. Der Leitfaden zeigt Speichern, Knowledge-Auswahl und die Prüfung verwendeter Auszüge.",
    "outcomeLabel": "Am Ende",
    "outcomeTitle": "Ein Assistent, der Ihre Materialien nutzen kann",
    "outcomeItems": [
      "Eine gespeicherte Antwortweise",
      "Passende Knowledge-Auszüge",
      "Eine Konfiguration für neue Gespräche"
    ],
    "videoLabel": "Oberfläche, Sprache und Untertitel auf Englisch",
    "videoHint": "Das verfügbare Video ist auf Englisch. Schriftliche Anleitung und Übung darunter sind auf Deutsch.",
    "demoEyebrow": "Interaktive Übung",
    "demoTitle": "Lernen Sie den Ablauf mit den Schaltflächen",
    "demoDescription": "Diese Übung verändert kein Konto und lädt keine Datei hoch. Wählen Sie das hervorgehobene Element zum Fortfahren.",
    "nativeDemoLabel": "Tomverse Schritt für Schritt",
    "demoPrevious": "Zurück",
    "demoNext": "Nächster Schritt",
    "demoRestart": "Neu beginnen",
    "choosePathEyebrow": "Einstieg wählen",
    "choosePathTitle": "Neu erstellen oder eine Konfiguration importieren",
    "choosePathDescription": "Wählen Sie den Weg zur ersten nützlichen Antwort. Erweiterte Einstellungen können später folgen.",
    "createPath": {
      "label": "Neu erstellen",
      "title": "Mit Name und Anweisungen beginnen",
      "body": "Erstellen Sie in drei Schritten einen Assistenten mit Ihren Materialien.",
      "steps": [
        "Name und Antwortweise eingeben",
        "Eine Knowledge-Datei hinzufügen",
        "Assistenten wählen und fragen"
      ]
    },
    "importPath": {
      "label": "Importieren",
      "title": "Agent Skill oder Tomverse-Paket importieren",
      "body": "Prüfen Sie ein Paket, bevor Anweisungen und Materialien in einen Assistenten übernommen werden.",
      "steps": [
        "ZIP oder Tomverse-Paket wählen",
        "Nicht übernehmbare Elemente prüfen",
        "Knowledge und Modelle prüfen und veröffentlichen"
      ]
    },
    "importAvailableLabel": "Import für dieses Konto verfügbar",
    "importUnavailableLabel": "Import wird schrittweise bereitgestellt",
    "importAvailableBody": "Wählen Sie unter Einstellungen → Meine KI-Assistenten den Import externer Konfigurationen.",
    "importBoundary": "Unterstützt werden Agent-Skill-Pakete mit SKILL.md, references und bestimmten assets sowie Tomverse-Pakete. Skripte werden nicht ausgeführt, externe Werkzeuge und Modelle nicht automatisch verbunden. Eine automatische Umwandlung von ChatGPT-GPT-Konfigurationen wird nicht unterstützt.",
    "detailsEyebrow": "Bildschirm für Bildschirm",
    "detailsTitle": "Wo Sie klicken und was gespeichert wird",
    "detailsDescription": "Ist das Video zu schnell, helfen diese Pfade und gespeicherten Ergebnisse.",
    "boundariesEyebrow": "Vor dem Start",
    "boundariesTitle": "Für Ihr Konto privat; wichtige Antworten an der Quelle prüfen",
    "boundaryItems": [
      "Assistenten und Knowledge werden nicht veröffentlicht oder mit anderen Nutzern geteilt.",
      "Relevante Knowledge-Auszüge gehen an den KI-Anbieter, der die Antwort erstellt.",
      "Dateitexte dienen als Referenz, nicht als Anweisungen an den Assistenten.",
      "Prüfen Sie wichtige Zahlen und Entscheidungen im Originaldokument."
    ],
    "helpEyebrow": "Bei Problemen",
    "helpTitle": "Drei häufige Situationen",
    "helpItems": [
      {
        "title": "Datei lässt sich nicht wählen",
        "body": "Warten Sie, bis die Verarbeitung beendet und die Datei bereit ist."
      },
      {
        "title": "Assistent fehlt im Gespräch",
        "body": "Prüfen Sie gespeicherte Anweisungen und Modelle. Ein bloßer Entwurf ist nicht verwendbar."
      },
      {
        "title": "Material fehlt in der Antwort",
        "body": "Nennen Sie Thema, Dateiname oder gesuchten Ausdruck und fragen Sie erneut."
      }
    ],
    "ctaAuthenticated": "In Tomverse erstellen",
    "ctaGuest": "Anmelden und erstellen",
    "ctaHint": "Die Produktanleitung setzt anhand tatsächlich gespeicherter Ergebnisse fort.",
    "steps": [
      {
        "id": "create_assistant",
        "label": "1",
        "title": "Assistenten erstellen",
        "body": "Geben Sie in Einstellungen Name und Beschreibung ein.",
        "screenTitle": "Einstellungen / Meine KI-Assistenten",
        "screenHint": "Beispiel: Nur Termine und Mitbringsel aus der Quelle nennen, Fehlendes als offen markieren und Belegsätze zitieren.",
        "targetLabel": "Assistenten erstellen",
        "result": "Ein Entwurf für Name und Beschreibung öffnet sich."
      },
      {
        "id": "add_knowledge",
        "label": "2",
        "title": "Knowledge hinzufügen und speichern",
        "body": "Schreiben Sie Anweisungen, wählen Sie eine bereite Datei und speichern Sie eine Version.",
        "screenTitle": "KI-Assistent bearbeiten",
        "screenHint": "Beispiel: Nur Termine und Mitbringsel aus der Quelle nennen, Fehlendes als offen markieren und Belegsätze zitieren.",
        "targetLabel": "Datei hinzufügen → Anweisungen und Modelle speichern",
        "result": "Die gewählte Knowledge-Datei wird an die gespeicherte Version gebunden."
      },
      {
        "id": "start_chat",
        "label": "3",
        "title": "Im Gespräch verwenden",
        "body": "Wählen Sie den gespeicherten Assistenten in den Gesprächswerkzeugen und fragen Sie zu den Materialien.",
        "screenTitle": "Neues Gespräch / KI-Assistent",
        "screenHint": "Beispiel: Nur Termine und Mitbringsel aus der Quelle nennen, Fehlendes als offen markieren und Belegsätze zitieren.",
        "targetLabel": "Lesekreis-Assistenten wählen",
        "result": "Prüfen Sie die verwendeten Knowledge-Auszüge unter der Antwort."
      }
    ],
    "detailedSteps": [
      {
        "number": "01",
        "title": "Assistenten erstellen",
        "where": "Einstellungen / Meine KI-Assistenten",
        "action": "Geben Sie in Einstellungen Name und Beschreibung ein.",
        "result": "Ein Entwurf für Name und Beschreibung öffnet sich."
      },
      {
        "number": "02",
        "title": "Antwortweise festlegen",
        "where": "KI-Assistent bearbeiten",
        "action": "Geben Sie an, nur Quelleninformationen zu verwenden und fehlende Angaben als unbekannt zu markieren.",
        "result": "Nach dem Speichern können neue Fragen dieselbe Antwortweise nutzen."
      },
      {
        "number": "03",
        "title": "Knowledge hinzufügen und speichern",
        "where": "KI-Assistent bearbeiten",
        "action": "Schreiben Sie Anweisungen, wählen Sie eine bereite Datei und speichern Sie eine Version.",
        "result": "Die gewählte Knowledge-Datei wird an die gespeicherte Version gebunden."
      },
      {
        "number": "04",
        "title": "Im Gespräch verwenden",
        "where": "Neues Gespräch / KI-Assistent",
        "action": "Wählen Sie den gespeicherten Assistenten in den Gesprächswerkzeugen und fragen Sie zu den Materialien.",
        "result": "Prüfen Sie die verwendeten Knowledge-Auszüge unter der Antwort."
      }
    ],
    "title": "Ein KI-Assistent für Ihre Materialien und Antwortweise",
    "supademoLabel": "Schrittweise Bildschirmübung",
    "nativeDemoNote": "Üben Sie mit Schaltflächen oder Tastatur das Speichern und Fragen. Dabei werden Konto und Dateien nicht geändert.",
    "importUnavailableBody": "Fehlt die Schaltfläche, erstellen Sie den Assistenten manuell: Name, Anweisungen und Materialien.",
    "exampleTitle": "Ein fiktives Beispiel mit Materialien",
    "exampleMaterialLabel": "Fiktives Material für Knowledge",
    "examplePromptLabel": "Erste Frage",
    "exampleMaterial": "Fiktive Nachricht: Der Lesekreis beginnt am 7. November um 14 Uhr. Bringen Sie ein gelesenes Buch und Notizen mit. Teilnahme bis 3. November bestätigen. Der Ort folgt später.",
    "examplePrompt": "Nenne anhand der Vereinsnachricht Termin, Mitbringsel und Antwortfrist. Sage, wenn der Ort noch offen ist, und zitiere zu jedem Punkt den passenden Satz.",
    "exampleNote": "Fiktives Material und redaktionelle Beispielantwort, kein echtes Modellresultat oder automatisches Training mit einer Datei. Das Video zeigt den bisherigen Oberflächenpfad.",
    "exampleOutputLabel": "Beispielantwort zum Quellenabgleich",
    "exampleOutput": "Treffen: 7. November um 14 Uhr — „Der Lesekreis beginnt am 7. November um 14 Uhr.“\nMitbringen: ein Buch und Notizen — „Bringen Sie ein gelesenes Buch und Notizen mit.“\nAntwort: bis 3. November — „Teilnahme bis 3. November bestätigen.“\nOrt: offen — „Der Ort folgt später.“"
  },
  "es": {
    stepProgress: (current, total) => `Paso ${current} de ${total}`,
    "eyebrow": "Mi asistente de IA + Knowledge",
    "description": "Combina tu forma de responder y tus materiales habituales en un asistente privado. La guía explica cómo guardar, seleccionar Knowledge y revisar los extractos utilizados.",
    "outcomeLabel": "Al terminar",
    "outcomeTitle": "Un asistente que puede consultar tu material",
    "outcomeItems": [
      "Una forma de responder guardada",
      "Extractos de Knowledge relevantes",
      "Una configuración para elegir en nuevas conversaciones"
    ],
    "videoLabel": "Interfaz, voz y subtítulos en inglés",
    "videoHint": "El vídeo disponible está en inglés. Las instrucciones escritas y la práctica de abajo están en español.",
    "demoEyebrow": "Práctica interactiva",
    "demoTitle": "Aprende la secuencia con los botones",
    "demoDescription": "Esta práctica no cambia cuentas ni sube archivos. Selecciona el control resaltado para avanzar.",
    "nativeDemoLabel": "Práctica Tomverse paso a paso",
    "demoPrevious": "Anterior",
    "demoNext": "Siguiente paso",
    "demoRestart": "Reiniciar",
    "choosePathEyebrow": "Cómo empezar",
    "choosePathTitle": "Crea un asistente o importa tu configuración",
    "choosePathDescription": "Elige la ruta para tu primera respuesta útil. Los ajustes avanzados pueden esperar.",
    "createPath": {
      "label": "Crear",
      "title": "Empieza con nombre e instrucciones",
      "body": "Crea un asistente con tus materiales en tres pasos.",
      "steps": [
        "Escribe el nombre y la forma de responder",
        "Añade un archivo de Knowledge",
        "Elige el asistente y pregunta"
      ]
    },
    "importPath": {
      "label": "Importar",
      "title": "Importa un Agent Skill o paquete Tomverse",
      "body": "Revisa el paquete antes de convertir instrucciones y materiales en un asistente.",
      "steps": [
        "Elige el ZIP o paquete Tomverse",
        "Revisa los elementos que no se pueden importar",
        "Comprueba Knowledge y modelos y publica"
      ]
    },
    "importAvailableLabel": "Importación disponible en esta cuenta",
    "importUnavailableLabel": "Importación en despliegue gradual",
    "importAvailableBody": "En Ajustes → Mis asistentes de IA, selecciona la importación de configuración externa.",
    "importBoundary": "Se admiten paquetes Agent Skill con SKILL.md, references y determinados assets, y paquetes Tomverse. No se ejecutan scripts ni se conectan automáticamente herramientas o modelos externos. No se admite la conversión automática de configuraciones ChatGPT GPT.",
    "detailsEyebrow": "Pantalla por pantalla",
    "detailsTitle": "Dónde ir y qué seleccionar",
    "detailsDescription": "Si el vídeo va rápido, consulta estas rutas y resultados guardados.",
    "boundariesEyebrow": "Antes de empezar",
    "boundariesTitle": "Privado para tu cuenta; comprueba lo importante con la fuente",
    "boundaryItems": [
      "Los asistentes y Knowledge no se publican ni comparten con otros usuarios.",
      "Los extractos relevantes se envían al proveedor de IA que genera la respuesta.",
      "El texto del archivo se trata como referencia, no como instrucciones para el asistente.",
      "Verifica cifras y decisiones importantes en el documento original."
    ],
    "helpEyebrow": "Si te atascas",
    "helpTitle": "Tres situaciones comunes",
    "helpItems": [
      {
        "title": "No puedo seleccionar el archivo",
        "body": "Espera a que termine el procesamiento y el archivo esté listo."
      },
      {
        "title": "El asistente no aparece",
        "body": "Comprueba que guardaste instrucciones y modelos. Un borrador sin guardar no se puede utilizar."
      },
      {
        "title": "La respuesta no usa mi material",
        "body": "Indica el tema, el nombre del archivo o las palabras que buscas y pregunta de nuevo."
      }
    ],
    "ctaAuthenticated": "Crear en Tomverse",
    "ctaGuest": "Iniciar sesión y crear",
    "ctaHint": "La guía del producto continúa según lo que se haya guardado realmente.",
    "steps": [
      {
        "id": "create_assistant",
        "label": "1",
        "title": "Crear el asistente",
        "body": "Escribe un nombre y descripción en Ajustes.",
        "screenTitle": "Ajustes / Mis asistentes de IA",
        "screenHint": "Ejemplo: indica solo fechas y objetos presentes, marca lo ausente como pendiente y cita las frases de apoyo.",
        "targetLabel": "Crear asistente",
        "result": "Se abre un borrador para nombre y descripción."
      },
      {
        "id": "add_knowledge",
        "label": "2",
        "title": "Añadir Knowledge y guardar",
        "body": "Escribe las instrucciones, elige un archivo listo y guarda una nueva versión.",
        "screenTitle": "Editar asistente de IA",
        "screenHint": "Ejemplo: indica solo fechas y objetos presentes, marca lo ausente como pendiente y cita las frases de apoyo.",
        "targetLabel": "Añadir archivo → Guardar instrucciones y modelos",
        "result": "El archivo elegido queda fijado a la versión guardada."
      },
      {
        "id": "start_chat",
        "label": "3",
        "title": "Usar en una conversación",
        "body": "Elige el asistente guardado en las herramientas de conversación y pregunta sobre el material.",
        "screenTitle": "Nueva conversación / Asistente de IA",
        "screenHint": "Ejemplo: indica solo fechas y objetos presentes, marca lo ausente como pendiente y cita las frases de apoyo.",
        "targetLabel": "Elegir asistente del club de lectura",
        "result": "Revisa los extractos usados debajo de la respuesta."
      }
    ],
    "detailedSteps": [
      {
        "number": "01",
        "title": "Crear el asistente",
        "where": "Ajustes / Mis asistentes de IA",
        "action": "Escribe un nombre y descripción en Ajustes.",
        "result": "Se abre un borrador para nombre y descripción."
      },
      {
        "number": "02",
        "title": "Definir la forma de responder",
        "where": "Editar asistente de IA",
        "action": "Indica que solo se use la información de la fuente y que se marque lo ausente como desconocido.",
        "result": "Después de guardar, las nuevas preguntas pueden usar la misma forma de responder."
      },
      {
        "number": "03",
        "title": "Añadir Knowledge y guardar",
        "where": "Editar asistente de IA",
        "action": "Escribe las instrucciones, elige un archivo listo y guarda una nueva versión.",
        "result": "El archivo elegido queda fijado a la versión guardada."
      },
      {
        "number": "04",
        "title": "Usar en una conversación",
        "where": "Nueva conversación / Asistente de IA",
        "action": "Elige el asistente guardado en las herramientas de conversación y pregunta sobre el material.",
        "result": "Revisa los extractos usados debajo de la respuesta."
      }
    ],
    "title": "Un asistente de IA con tu material y forma de responder",
    "supademoLabel": "Práctica paso a paso",
    "nativeDemoNote": "Usa los botones o el teclado para practicar cómo guardar y preguntar. Esta vista no cambia tu cuenta ni tus archivos.",
    "importUnavailableBody": "Si no aparece el botón, crea el asistente manualmente: nombre, instrucciones y material.",
    "exampleTitle": "Un ejemplo ficticio con tu material",
    "exampleMaterialLabel": "Material ficticio para Knowledge",
    "examplePromptLabel": "Primera pregunta",
    "exampleMaterial": "Aviso ficticio: el club de lectura empieza el 7 de noviembre a las 14:00. Lleva un libro que hayas leído y tus notas. Confirma antes del 3 de noviembre. El lugar se anunciará después.",
    "examplePrompt": "Usa el aviso del club para indicar la fecha, qué llevar y el plazo de respuesta. Di si el lugar sigue pendiente y cita la frase de cada punto.",
    "exampleNote": "Material ficticio y respuesta editada de demostración, no resultado real ni entrenamiento automático con un archivo. El vídeo muestra la ruta de la interfaz existente.",
    "exampleOutputLabel": "Respuesta ilustrativa para contrastar con la fuente",
    "exampleOutput": "Reunión: 7 de noviembre a las 14:00 — «el club de lectura empieza el 7 de noviembre a las 14:00.»\nLlevar: un libro y notas — «Lleva un libro que hayas leído y tus notas.»\nRespuesta: antes del 3 de noviembre — «Confirma antes del 3 de noviembre.»\nLugar: pendiente — «El lugar se anunciará después.»"
  },
  "pt": {
    stepProgress: (current, total) => `Etapa ${current} de ${total}`,
    "eyebrow": "Meu assistente de IA + Knowledge",
    "description": "Combine seu estilo de resposta e seus materiais frequentes em um assistente privado. O guia explica como salvar, selecionar Knowledge e conferir os trechos utilizados.",
    "outcomeLabel": "Ao terminar",
    "outcomeTitle": "Um assistente que pode consultar seus materiais",
    "outcomeItems": [
      "Um estilo de resposta salvo",
      "Trechos relevantes de Knowledge",
      "Uma configuração para novas conversas"
    ],
    "videoLabel": "Interface, voz e legendas em inglês",
    "videoHint": "O vídeo disponível está em inglês. As instruções escritas e a prática abaixo estão em português.",
    "demoEyebrow": "Prática interativa",
    "demoTitle": "Aprenda a sequência usando os botões",
    "demoDescription": "Esta prática não altera contas nem envia arquivos. Selecione o controle destacado para avançar.",
    "nativeDemoLabel": "Prática Tomverse passo a passo",
    "demoPrevious": "Anterior",
    "demoNext": "Próxima etapa",
    "demoRestart": "Recomeçar",
    "choosePathEyebrow": "Como começar",
    "choosePathTitle": "Crie um assistente ou importe sua configuração",
    "choosePathDescription": "Escolha o caminho para a primeira resposta útil. Os ajustes avançados podem esperar.",
    "createPath": {
      "label": "Criar",
      "title": "Comece com nome e instruções",
      "body": "Crie um assistente com seus materiais em três etapas.",
      "steps": [
        "Digite o nome e o estilo de resposta",
        "Adicione um arquivo de Knowledge",
        "Escolha o assistente e pergunte"
      ]
    },
    "importPath": {
      "label": "Importar",
      "title": "Importe um Agent Skill ou pacote Tomverse",
      "body": "Revise o pacote antes de converter instruções e materiais em um assistente.",
      "steps": [
        "Escolha o ZIP ou pacote Tomverse",
        "Confira os itens que não podem ser importados",
        "Confira Knowledge e modelos e publique"
      ]
    },
    "importAvailableLabel": "Importação disponível nesta conta",
    "importUnavailableLabel": "Importação em disponibilização gradual",
    "importAvailableBody": "Em Configurações → Meus assistentes de IA, escolha a importação de configuração externa.",
    "importBoundary": "São aceitos pacotes Agent Skill com SKILL.md, references e alguns assets, além de pacotes Tomverse. Scripts não são executados; ferramentas e modelos externos não são conectados automaticamente. Não há conversão automática de configurações ChatGPT GPT.",
    "detailsEyebrow": "Tela por tela",
    "detailsTitle": "Onde ir e o que selecionar",
    "detailsDescription": "Se o vídeo estiver rápido, consulte estes caminhos e resultados salvos.",
    "boundariesEyebrow": "Antes de começar",
    "boundariesTitle": "Privado para sua conta; confira o importante na fonte",
    "boundaryItems": [
      "Assistentes e Knowledge não são publicados nem compartilhados com outros usuários.",
      "Os trechos relevantes são enviados ao provedor de IA que gera a resposta.",
      "O texto do arquivo é referência, não instrução para o assistente.",
      "Confira números e decisões importantes no documento original."
    ],
    "helpEyebrow": "Se houver dificuldade",
    "helpTitle": "Três situações comuns",
    "helpItems": [
      {
        "title": "Não consigo selecionar o arquivo",
        "body": "Espere o processamento terminar e o arquivo ficar pronto."
      },
      {
        "title": "O assistente não aparece",
        "body": "Confira se salvou instruções e modelos. Uma configuração só em rascunho não pode ser usada."
      },
      {
        "title": "A resposta não usou meu material",
        "body": "Informe o tema, o nome do arquivo ou o trecho que procura e pergunte novamente."
      }
    ],
    "ctaAuthenticated": "Criar no Tomverse",
    "ctaGuest": "Entrar e criar",
    "ctaHint": "O guia do produto continua de acordo com o que foi realmente salvo.",
    "steps": [
      {
        "id": "create_assistant",
        "label": "1",
        "title": "Criar o assistente",
        "body": "Digite nome e descrição em Configurações.",
        "screenTitle": "Configurações / Meus assistentes de IA",
        "screenHint": "Exemplo: liste apenas datas e itens presentes, marque o ausente como indefinido e cite as frases de apoio.",
        "targetLabel": "Criar assistente",
        "result": "Um rascunho abre para nome e descrição."
      },
      {
        "id": "add_knowledge",
        "label": "2",
        "title": "Adicionar Knowledge e salvar",
        "body": "Escreva as instruções, escolha um arquivo pronto e salve uma nova versão.",
        "screenTitle": "Editar assistente de IA",
        "screenHint": "Exemplo: liste apenas datas e itens presentes, marque o ausente como indefinido e cite as frases de apoio.",
        "targetLabel": "Adicionar arquivo → Salvar instruções e modelos",
        "result": "O arquivo escolhido fica vinculado à versão salva."
      },
      {
        "id": "start_chat",
        "label": "3",
        "title": "Usar em uma conversa",
        "body": "Escolha o assistente salvo nas ferramentas de conversa e pergunte sobre o material.",
        "screenTitle": "Nova conversa / Assistente de IA",
        "screenHint": "Exemplo: liste apenas datas e itens presentes, marque o ausente como indefinido e cite as frases de apoio.",
        "targetLabel": "Escolher assistente do clube de leitura",
        "result": "Confira os trechos utilizados abaixo da resposta."
      }
    ],
    "detailedSteps": [
      {
        "number": "01",
        "title": "Criar o assistente",
        "where": "Configurações / Meus assistentes de IA",
        "action": "Digite nome e descrição em Configurações.",
        "result": "Um rascunho abre para nome e descrição."
      },
      {
        "number": "02",
        "title": "Definir o estilo de resposta",
        "where": "Editar assistente de IA",
        "action": "Instrua a usar apenas informações da fonte e marcar o ausente como desconhecido.",
        "result": "Após salvar, novas perguntas podem usar o mesmo estilo de resposta."
      },
      {
        "number": "03",
        "title": "Adicionar Knowledge e salvar",
        "where": "Editar assistente de IA",
        "action": "Escreva as instruções, escolha um arquivo pronto e salve uma nova versão.",
        "result": "O arquivo escolhido fica vinculado à versão salva."
      },
      {
        "number": "04",
        "title": "Usar em uma conversa",
        "where": "Nova conversa / Assistente de IA",
        "action": "Escolha o assistente salvo nas ferramentas de conversa e pergunte sobre o material.",
        "result": "Confira os trechos utilizados abaixo da resposta."
      }
    ],
    "title": "Um assistente de IA com seus materiais e estilo de resposta",
    "supademoLabel": "Prática passo a passo",
    "nativeDemoNote": "Use os botões ou o teclado para praticar como salvar e perguntar. Esta tela não altera sua conta nem seus arquivos.",
    "importUnavailableBody": "Se o botão não aparecer, crie o assistente manualmente: nome, instruções e materiais.",
    "exampleTitle": "Um exemplo fictício com seus materiais",
    "exampleMaterialLabel": "Material fictício para Knowledge",
    "examplePromptLabel": "Primeira pergunta",
    "exampleMaterial": "Aviso fictício: o clube de leitura começa em 7 de novembro às 14h. Leve um livro que já leu e suas anotações. Confirme até 3 de novembro. O local será informado depois.",
    "examplePrompt": "Use o aviso do clube para informar a data, o que levar e o prazo de resposta. Diga se o local está indefinido e cite a frase que apoia cada item.",
    "exampleNote": "Material fictício e resposta editada de demonstração, não resultado real nem treinamento automático com um arquivo. O vídeo mostra o caminho da interface existente.",
    "exampleOutputLabel": "Resposta ilustrativa para conferir na fonte",
    "exampleOutput": "Encontro: 7 de novembro às 14h — “o clube de leitura começa em 7 de novembro às 14h.”\nLevar: um livro e anotações — “Leve um livro que já leu e suas anotações.”\nResposta: até 3 de novembro — “Confirme até 3 de novembro.”\nLocal: indefinido — “O local será informado depois.”"
  }
};
