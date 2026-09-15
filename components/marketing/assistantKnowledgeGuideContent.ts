import type {
  AssistantKnowledgeGuideContentLanguage,
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
};

export const assistantKnowledgeGuideContent: Record<
  AssistantKnowledgeGuideContentLanguage,
  AssistantKnowledgeGuideCopy
> = {
  ko: {
    eyebrow: "나의 AI 어시스턴트 + Knowledge",
    title: "설명만 듣지 말고, 직접 만들어 보세요",
    description:
      "내가 원하는 답변 방식과 자주 쓰는 자료를 하나의 비공개 AI 어시스턴트에 담는 과정을 실제 Tomverse 화면으로 안내합니다.",
    outcomeLabel: "이 가이드가 끝나면",
    outcomeTitle: "자료를 근거로 답하는 내 전용 어시스턴트가 준비됩니다",
    outcomeItems: [
      "답변 방식이 저장된 AI 어시스턴트",
      "질문과 관련된 Knowledge 발췌",
      "새 대화에서 바로 선택할 수 있는 구성",
    ],
    videoLabel: "한국어 화면 · 한국어 음성",
    videoHint: "소리를 끄더라도 같은 내용의 한국어 자막을 볼 수 있습니다.",
    demoEyebrow: "클릭형 실습",
    demoTitle: "버튼을 눌러 실제 순서를 익혀보세요",
    demoDescription:
      "계정이나 파일을 바꾸지 않는 연습 화면입니다. 각 강조 버튼을 누르면 다음 단계로 이동합니다.",
    supademoLabel: "Supademo 인터랙티브 실습",
    nativeDemoLabel: "Tomverse 단계별 실습",
    nativeDemoNote:
      "외부 데모 제공 여부와 관계없이 전체 경로를 복습할 수 있도록 같은 순서의 키보드 접근 가능 안내를 항상 함께 제공합니다.",
    stepProgress: (current, total) => `${total}단계 중 ${current}단계`,
    demoPrevious: "이전",
    demoNext: "다음 단계",
    demoRestart: "처음부터 다시",
    steps: [
      {
        id: "create_assistant",
        label: "1단계",
        title: "어시스턴트 만들기",
        body: "설정의 ‘나의 AI 어시스턴트’에서 새 구성을 시작합니다.",
        screenTitle: "설정 / 나의 AI 어시스턴트",
        screenHint:
          "새 AI 어시스턴트를 만들거나 Agent Skill·Tomverse 패키지를 가져오는 곳입니다.",
        targetLabel: "새 어시스턴트 만들기",
        result: "이름과 설명을 입력하는 편집 화면이 열립니다.",
      },
      {
        id: "add_knowledge",
        label: "2단계",
        title: "Knowledge 추가하고 저장하기",
        body: "답변 방식과 파일을 정한 뒤 새 버전으로 저장합니다.",
        screenTitle: "AI 어시스턴트 편집",
        screenHint: "예: 결론과 근거를 먼저 쓰고, 다음 행동을 짧게 제안합니다.",
        targetLabel: "파일 추가 → 지시문과 모델 저장",
        result: "처리가 끝난 파일이 현재 버전의 Knowledge로 선택됩니다.",
      },
      {
        id: "start_chat",
        label: "3단계",
        title: "대화에서 사용하기",
        body: "대화 도구에서 저장한 어시스턴트를 선택하고 첫 질문을 보냅니다.",
        screenTitle: "새 대화 / AI 어시스턴트",
        screenHint: "질문과 관련된 발췌만 답변의 참고 맥락으로 전달됩니다.",
        targetLabel: "프로젝트 브리핑 도우미 선택",
        result: "답변 아래에서 사용된 Knowledge 발췌 수를 확인할 수 있습니다.",
      },
    ],
    choosePathEyebrow: "시작 방법",
    choosePathTitle: "처음 만들거나, 이미 쓰던 구성을 가져오세요",
    choosePathDescription:
      "첫 결과를 만드는 데 필요한 경로만 선택하세요. 고급 설정은 나중에 바꿀 수 있습니다.",
    createPath: {
      label: "처음 만들기",
      title: "이름과 지시문부터 시작",
      body: "기존 구성이 없다면 가장 짧은 세 단계로 첫 답변을 확인합니다.",
      steps: ["이름과 답변 방식 입력", "Knowledge 파일 하나 추가", "대화에서 선택하고 질문"],
    },
    importPath: {
      label: "기존 구성 가져오기",
      title: "Agent Skill 또는 Tomverse 패키지 가져오기",
      body: "패키지를 검토한 뒤 지시문과 자료 후보를 새 어시스턴트로 변환합니다.",
      steps: ["ZIP 또는 Tomverse 패키지 선택", "가져오지 못하는 항목 확인", "Knowledge와 모델을 검토하고 게시"],
    },
    importAvailableLabel: "이 계정에서 가져오기 사용 가능",
    importUnavailableLabel: "가져오기는 단계적으로 제공 중",
    importAvailableBody:
      "설정 → 나의 AI 어시스턴트에서 ‘구성 가져오기’를 선택할 수 있습니다.",
    importUnavailableBody:
      "버튼이 보이지 않으면 수동 생성 경로를 사용하세요. 제공되기 전에는 가져오기를 약속하지 않습니다.",
    importBoundary:
      "Agent Skill의 SKILL.md·references·일부 assets와 Tomverse 패키지를 지원합니다. 스크립트는 실행하지 않으며, 외부 도구와 모델은 자동 연결하지 않습니다. ChatGPT GPT 설정 파일을 자동 변환하는 기능은 아직 지원하지 않습니다.",
    detailsEyebrow: "화면별 안내",
    detailsTitle: "어디에서 무엇을 눌러야 하는지",
    detailsDescription:
      "영상이 빠르거나 특정 단계에서 막혔다면 아래 경로와 저장 결과를 확인하세요.",
    detailedSteps: [
      {
        number: "01",
        title: "새 어시스턴트 생성",
        where: "설정 → 나의 AI 어시스턴트",
        action: "새 구성의 이름과 설명을 입력합니다.",
        result: "편집 가능한 초안이 만들어집니다.",
      },
      {
        number: "02",
        title: "답변 방식 지정",
        where: "AI 어시스턴트 편집 → 지시문",
        action: "말투보다 결과의 형식과 판단 순서를 구체적으로 적습니다.",
        result: "이후 새 답변에 동일한 방식이 적용됩니다.",
      },
      {
        number: "03",
        title: "Knowledge 연결",
        where: "AI 어시스턴트 편집 → 이 계정이 사용할 지식 파일",
        action: "파일을 추가하고 처리 완료 상태를 확인한 뒤 선택합니다.",
        result: "선택한 파일이 저장된 버전에 고정됩니다.",
      },
      {
        number: "04",
        title: "첫 질문 보내기",
        where: "대화 → AI 어시스턴트",
        action: "방금 저장한 구성을 선택하고 자료와 관련된 질문을 보냅니다.",
        result: "답변에 사용된 Knowledge 여부를 확인할 수 있습니다.",
      },
    ],
    boundariesEyebrow: "알아둘 점",
    boundariesTitle: "비공개이지만, 답변은 원문과 함께 확인하세요",
    boundaryItems: [
      "어시스턴트와 Knowledge는 공개 목록이나 다른 사용자에게 공유되지 않습니다.",
      "Knowledge의 관련 발췌는 답변을 생성하는 AI 제공자에게 참고 자료로 전달됩니다.",
      "파일 속 문장은 지시가 아닌 참고 자료로 처리됩니다.",
      "중요한 수치와 결정은 답변만 믿지 말고 원문에서 다시 확인하세요.",
    ],
    helpEyebrow: "막혔을 때",
    helpTitle: "자주 생기는 세 가지 상황",
    helpItems: [
      { title: "파일을 선택할 수 없어요", body: "처리 중인 파일은 선택할 수 없습니다. 상태가 준비됨으로 바뀐 뒤 다시 선택하세요." },
      { title: "대화에서 어시스턴트가 안 보여요", body: "지시문과 모델 저장을 완료했는지 확인하세요. 초안만 만든 구성은 대화에서 사용할 수 없습니다." },
      { title: "자료 내용이 답변에 없어요", body: "질문에 파일명, 문서의 주제나 찾을 표현을 구체적으로 적고 다시 질문하세요." },
    ],
    ctaAuthenticated: "Tomverse에서 직접 만들기",
    ctaGuest: "로그인하고 직접 만들기",
    ctaHint: "실제 설정 가이드는 저장 결과를 기준으로 다음 단계부터 이어집니다.",
  },
  en: {
    eyebrow: "My AI Assistant + Knowledge",
    title: "Build it yourself, instead of only watching",
    description:
      "Use the real Tomverse interface to combine the way you want answers written with the material you use often in one private AI assistant.",
    outcomeLabel: "By the end",
    outcomeTitle: "You will have an assistant that can answer with your material",
    outcomeItems: [
      "An AI assistant with a saved response style",
      "Relevant excerpts from your Knowledge",
      "A configuration ready to select in a new conversation",
    ],
    videoLabel: "English interface · English voiceover",
    videoHint: "English captions cover the same instructions when audio is muted.",
    demoEyebrow: "Interactive practice",
    demoTitle: "Select the controls to learn the real sequence",
    demoDescription:
      "This practice view does not change an account or upload a file. Select each highlighted control to continue.",
    supademoLabel: "Supademo interactive walkthrough",
    nativeDemoLabel: "Tomverse step-by-step practice",
    nativeDemoNote:
      "This keyboard-accessible walkthrough remains available alongside the external demo, so the complete path can always be reviewed in the same order.",
    stepProgress: (current, total) => `Step ${current} of ${total}`,
    demoPrevious: "Previous",
    demoNext: "Next step",
    demoRestart: "Start again",
    steps: [
      {
        id: "create_assistant",
        label: "Step 1",
        title: "Create your assistant",
        body: "Start a new configuration in My AI Assistants under Settings.",
        screenTitle: "Settings / My AI Assistants",
        screenHint: "Create an assistant or bring in an external configuration here.",
        targetLabel: "Create new assistant",
        result: "The editor opens for a name and description.",
      },
      {
        id: "add_knowledge",
        label: "Step 2",
        title: "Add Knowledge and save",
        body: "Set the response style, choose a file, and save a new version.",
        screenTitle: "Edit AI Assistant",
        screenHint: "Example: Lead with the conclusion and evidence, then suggest the next action briefly.",
        targetLabel: "Add file → Save instructions and models",
        result: "A processed file is selected as Knowledge for the current version.",
      },
      {
        id: "start_chat",
        label: "Step 3",
        title: "Use it in a conversation",
        body: "Choose the saved assistant from the conversation tools and send the first question.",
        screenTitle: "New conversation / AI Assistant",
        screenHint: "Only excerpts relevant to the question are supplied as reference context.",
        targetLabel: "Select Project briefing assistant",
        result: "The answer shows how many Knowledge excerpts were used.",
      },
    ],
    choosePathEyebrow: "Choose a starting point",
    choosePathTitle: "Start fresh, or bring in a configuration you already use",
    choosePathDescription:
      "Pick only the path needed for the first useful answer. Advanced settings can wait.",
    createPath: {
      label: "Start fresh",
      title: "Begin with a name and instructions",
      body: "If you have no existing configuration, reach the first grounded answer in three short steps.",
      steps: ["Enter a name and response style", "Add one Knowledge file", "Select it in chat and ask"],
    },
    importPath: {
      label: "Bring in an existing setup",
      title: "Import an Agent Skill or Tomverse package",
      body: "Review a package, then turn its instructions and material candidates into an assistant.",
      steps: ["Choose a ZIP or Tomverse package", "Review what cannot be carried over", "Review Knowledge and models, then publish"],
    },
    importAvailableLabel: "Import is available for this account",
    importUnavailableLabel: "Import is being released gradually",
    importAvailableBody:
      "Choose Import external configuration from Settings → My AI Assistants.",
    importUnavailableBody:
      "If the button is absent, use the manual path. Tomverse does not promise import before it is available to the account.",
    importBoundary:
      "Tomverse supports Agent Skill packages with SKILL.md, references, selected assets, and native Tomverse packages. It does not run scripts or automatically connect external tools and models. Automatic conversion of ChatGPT GPT configuration files is not supported yet.",
    detailsEyebrow: "Screen-by-screen",
    detailsTitle: "Where to go and what to select",
    detailsDescription:
      "Use these paths and saved outcomes when the video moves too quickly or one step does not work.",
    detailedSteps: [
      { number: "01", title: "Create an assistant", where: "Settings → My AI Assistants", action: "Enter a name and description for the new configuration.", result: "Tomverse creates an editable draft." },
      { number: "02", title: "Set the response method", where: "Edit AI Assistant → Instructions", action: "Describe the output structure and decision order, not only a tone of voice.", result: "New answers use the same method after you save." },
      { number: "03", title: "Connect Knowledge", where: "Edit AI Assistant → Knowledge files this account can use", action: "Add a file, wait until it is ready, then select it.", result: "The saved version pins the selected file." },
      { number: "04", title: "Send the first question", where: "Conversation → AI Assistant", action: "Select the configuration and ask a question related to the material.", result: "The answer indicates whether Knowledge was used." },
    ],
    boundariesEyebrow: "Before you start",
    boundariesTitle: "Private to your account, with important answers checked against the source",
    boundaryItems: [
      "Assistants and Knowledge are not published or shared with other users.",
      "Relevant Knowledge excerpts are sent to the AI provider generating the answer as reference material.",
      "Text inside a file is treated as reference material, not as instructions to the assistant.",
      "Verify important numbers and decisions against the source document.",
    ],
    helpEyebrow: "If you get stuck",
    helpTitle: "Three common situations",
    helpItems: [
      { title: "I cannot select a file", body: "Files still processing cannot be selected. Wait until the status changes to ready." },
      { title: "The assistant is missing in chat", body: "Confirm that you saved instructions and models. A configuration that only has a draft cannot be used in a conversation." },
      { title: "The answer did not use my material", body: "Mention the document topic, filename, or wording you expect to find, then ask again." },
    ],
    ctaAuthenticated: "Build it in Tomverse",
    ctaGuest: "Sign in and build it",
    ctaHint: "The in-product guide resumes from what has actually been saved.",
  },
  zh: {
    eyebrow: "我的 AI 助手 + Knowledge",
    title: "不只是观看，亲手完成一次设置",
    description:
      "通过真实的中文 Tomverse 界面，把你希望的回答方式和常用资料放进一个仅限自己使用的 AI 助手。",
    outcomeLabel: "完成本指南后",
    outcomeTitle: "你将拥有一个能参考自己资料回答的专属助手",
    outcomeItems: ["已保存回答方式的 AI 助手", "与问题相关的 Knowledge 摘录", "可在新对话中直接选择的配置"],
    videoLabel: "中文界面 · 中文语音",
    videoHint: "关闭声音后，仍可通过中文字幕获得相同说明。",
    demoEyebrow: "点击练习",
    demoTitle: "点击按钮，熟悉实际操作顺序",
    demoDescription: "这是不会修改账户或上传文件的练习画面。点击每个高亮控件即可继续。",
    supademoLabel: "Supademo 交互式操作指南",
    nativeDemoLabel: "Tomverse 分步练习",
    nativeDemoNote: "无论是否提供外部演示，支持键盘操作的指南都会同时保留，方便按相同步骤随时复习完整流程。",
    stepProgress: (current, total) => `第 ${current} 步，共 ${total} 步`,
    demoPrevious: "上一步",
    demoNext: "下一步",
    demoRestart: "重新开始",
    steps: [
      { id: "create_assistant", label: "第 1 步", title: "创建助手", body: "在“设置”的“我的 AI 配置”中创建新配置。", screenTitle: "设置 / 我的 AI 配置", screenHint: "在这里创建助手，或导入外部配置。", targetLabel: "新建配置", result: "系统会打开用于填写名称和说明的编辑页面。" },
      { id: "add_knowledge", label: "第 2 步", title: "添加 Knowledge 并保存", body: "设置回答方式、选择文件，然后保存新修订。", screenTitle: "编辑 AI 配置", screenHint: "示例：先给出结论和依据，再简短建议下一步行动。", targetLabel: "添加文件 → 保存指令与模型", result: "处理完成的文件会被选为当前修订的 Knowledge。" },
      { id: "start_chat", label: "第 3 步", title: "在对话中使用", body: "从对话工具中选择已保存的助手，并发送第一个问题。", screenTitle: "新对话 / AI 助手", screenHint: "系统只会把与问题相关的摘录作为参考上下文。", targetLabel: "选择项目简报助手", result: "回答下方会显示使用了多少条 Knowledge 摘录。" },
    ],
    choosePathEyebrow: "选择开始方式",
    choosePathTitle: "从头创建，或导入你已经在使用的配置",
    choosePathDescription: "只选择获得第一个有效回答所需的路径。高级设置可以稍后调整。",
    createPath: { label: "从头创建", title: "从名称和指令开始", body: "如果没有现有配置，只需三个简短步骤即可获得第一个基于资料的回答。", steps: ["填写名称和回答方式", "添加一个 Knowledge 文件", "在对话中选择并提问"] },
    importPath: { label: "导入现有配置", title: "导入 Agent Skill 或 Tomverse 包", body: "先审阅包内容，再把其中的指令和资料候选转换为助手。", steps: ["选择 ZIP 或 Tomverse 包", "确认无法带入的项目", "检查 Knowledge 和模型后发布"] },
    importAvailableLabel: "此账户可以使用导入功能",
    importUnavailableLabel: "导入功能正在逐步开放",
    importAvailableBody: "前往“设置 → 我的 AI 配置”，选择“导入外部配置”。",
    importUnavailableBody: "如果没有看到该按钮，请使用手动创建路径。在功能开放前，Tomverse 不会承诺可以导入。",
    importBoundary: "Tomverse 支持包含 SKILL.md、references、部分 assets 的 Agent Skill 包，以及 Tomverse 原生包。系统不会运行脚本，也不会自动连接外部工具或模型。目前还不支持自动转换 ChatGPT GPT 配置文件。",
    detailsEyebrow: "逐屏说明",
    detailsTitle: "去哪里，点击什么",
    detailsDescription: "如果视频过快，或某一步没有成功，请对照下面的路径和保存结果。",
    detailedSteps: [
      { number: "01", title: "创建助手", where: "设置 → 我的 AI 配置", action: "输入新配置的名称和说明。", result: "Tomverse 会创建一个可编辑的草稿。" },
      { number: "02", title: "指定回答方式", where: "编辑 AI 配置 → 指令", action: "具体说明输出结构和判断顺序，而不只是语气。", result: "保存后，新回答会采用相同方式。" },
      { number: "03", title: "连接 Knowledge", where: "编辑 AI 配置 → 此账户可使用的知识文件", action: "添加文件，等待状态变为就绪，然后选中它。", result: "已保存的修订会固定使用所选文件。" },
      { number: "04", title: "发送第一个问题", where: "对话 → AI 助手", action: "选择刚保存的配置，并提出与资料相关的问题。", result: "你可以确认回答是否使用了 Knowledge。" },
    ],
    boundariesEyebrow: "开始前须知",
    boundariesTitle: "内容仅限你的账户，但重要回答仍需核对原文",
    boundaryItems: ["助手和 Knowledge 不会公开，也不会与其他用户共享。", "相关 Knowledge 摘录会作为参考资料发送给生成回答的 AI 提供商。", "文件中的文字会被当作参考资料，而不是对助手的指令。", "重要数字和决定请回到原始文档再次确认。"],
    helpEyebrow: "遇到问题时",
    helpTitle: "三种常见情况",
    helpItems: [
      { title: "无法选择文件", body: "仍在处理的文件不能选择。请等待状态变为“已就绪”后再试。" },
      { title: "对话中找不到助手", body: "请确认已经保存指令和模型。只有草稿、尚未发布修订的配置不能用于对话。" },
      { title: "回答没有使用我的资料", body: "请写明文档主题、文件名或希望查找的具体措辞，然后再次提问。" },
    ],
    ctaAuthenticated: "在 Tomverse 中亲自创建",
    ctaGuest: "登录并亲自创建",
    ctaHint: "产品内指南会根据实际保存结果，从下一步继续。",
  },
};
