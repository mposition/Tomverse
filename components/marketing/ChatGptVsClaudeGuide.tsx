"use client";

import Image from "next/image";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  ArrowRight,
  CheckCircle2,
  Code2,
  FileText,
  PenLine,
  Scale,
  Sparkles,
} from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { CHATGPT_VS_CLAUDE_MODEL_IDS } from "@/lib/marketingModelReferences";
import { trackProductEvent } from "@/lib/productAnalyticsClient";

type TaskRow = {
  task: string;
  gpt: string;
  claude: string;
  decision: string;
};

type GuideCopy = {
  jumpLabel: string;
  jumpLinks: Array<{ label: string; href: string }>;
  scopeEyebrow: string;
  scopeTitle: string;
  reviewedLabel: string;
  reviewedDate: string;
  modelsLabel: string;
  scopeNote: string;
  resultsTitle: string;
  resultsBody: string;
  taskHeader: string;
  gptHeader: string;
  claudeHeader: string;
  decisionHeader: string;
  tasks: TaskRow[];
  resultTitle: string;
  resultBody: string;
  samplePromptLabel: string;
  samplePrompt: string;
  gptResult: string;
  claudeResult: string;
  resultTakeaway: string;
  resultDisclaimer: string;
  methodTitle: string;
  methodBody: string;
  methodSteps: string[];
  screenTitle: string;
  screenBody: string;
  screenPrompt: string;
  screenCaption: string;
  promptsTitle: string;
  promptsBody: string;
  promptExamples: Array<{ label: string; prompt: string }>;
  fitTitle: string;
  fitCards: Array<{ title: string; body: string }>;
  faqTitle: string;
  faqs: Array<{ question: string; answer: string }>;
  relatedTitle: string;
  relatedLinks: Array<{ label: string; href: string; body: string }>;
  ctaEyebrow: string;
  ctaTitle: string;
  ctaBody: string;
  ctaLabel: string;
  signInNote: string;
  independentNotice: string;
};

const guideCopy: Record<Language, GuideCopy> = {
  "ko": {
    "jumpLabel": "이 가이드의 구성",
    "scopeEyebrow": "비교할 모델과 예제 범위",
    "scopeTitle": "같은 질문, 같은 기준으로 비교하세요",
    "reviewedLabel": "시연의 성격",
    "reviewedDate": "편집용 가상 예제 · 모델 실험 아님",
    "modelsLabel": "준비된 비교의 모델",
    "scopeNote": "GPT-5.4 mini와 Claude Haiku 4.5는 이 가이드의 비교 링크에 설정된 모델 쌍입니다. 아래 문구는 실제 응답이나 성능 측정값이 아닙니다. 현재 모델 이용 여부와 기본 크레딧은 모델 목록에서 확인하세요.",
    "resultsTitle": "두 모델에 같은 체크리스트를 적용하세요",
    "resultsBody": "브랜드별 성향을 미리 정하지 말고 실제 질문의 목적부터 적어보세요. 아래 기준은 두 모델에 동일하게 적용합니다.",
    "taskHeader": "사용 상황",
    "gptHeader": "GPT에서 확인할 기준",
    "claudeHeader": "Claude에서 확인할 기준",
    "decisionHeader": "원문과 확인할 것",
    "resultTitle": "원문이 있는 가상 독서 모임 예제",
    "resultBody": "원문과 같은 질문을 함께 제공합니다. 아래 두 시연 출력은 같은 조건을 서로 다른 형식으로 정리한 편집 예제이며, 특정 모델의 실제 답변이 아닙니다.",
    "samplePromptLabel": "동일 질문과 가상 원문",
    "resultTakeaway": "확인 기준: 11월 7일 오후 2시, 책 한 권과 메모, 11월 3일 회신을 보존했는지 확인하세요. 장소는 미정이며 원문에 없는 연도·요일·주소는 추가하지 않습니다.",
    "resultDisclaimer": "설명을 위해 작성한 가상 출력입니다. 모델 실행·검증일·성능 결과를 나타내지 않습니다. 아래 링크는 질문과 원문을 입력창에 준비하며 전송은 직접 결정합니다.",
    "methodTitle": "직접 비교할 때의 순서",
    "methodBody": "같은 자료를 보내는 것에 더해, 무엇을 확인할지 먼저 정하면 답변의 말투에만 끌리지 않을 수 있습니다.",
    "screenTitle": "Tomverse Review에서 읽는 방식",
    "screenBody": "하나의 질문 옆에 답변을 나란히 두고 원문 조건과 대조합니다. 완료된 답변의 차이와 누락은 AI Review로도 살펴볼 수 있습니다.",
    "screenCaption": "비교 화면을 설명하는 재현 UI입니다. 두 출력은 위 가상 원문을 바탕으로 작성한 시연이며 실제 모델 결과가 아닙니다.",
    "promptsTitle": "내 자료로 바꿔 쓰는 질문",
    "promptsBody": "대괄호를 내 자료로 바꾸세요. 없는 항목을 채우도록 요구하지 않고, 두 모델에 같은 조건을 적용합니다.",
    "fitTitle": "내 질문에 맞는 답변을 고르는 기준",
    "faqTitle": "비교할 때 자주 묻는 질문",
    "relatedTitle": "비교를 이어가는 가이드",
    "ctaEyebrow": "같은 입력을 직접 비교",
    "ctaTitle": "GPT-5.4 mini와 Claude Haiku 4.5 비교 준비하기",
    "ctaBody": "이 링크는 선택된 두 모델, 위 질문과 가상 원문을 Review 입력창에 준비합니다. 이 준비된 비교 링크는 로그인 후 열립니다. 전송 전 기본 크레딧과 현재 모델 이용 범위를 확인하세요.",
    "ctaLabel": "같은 입력으로 비교 준비하기",
    "signInNote": "로그인 후 준비된 비교 화면으로 돌아옵니다. 이는 이 링크의 조건이며 모든 게스트 Review 체험이 로그인 필수라는 뜻은 아닙니다.",
    "jumpLinks": [
      {
        "href": "#task-comparison",
        "label": "두 모델에 같은 체크리스트를 적용하세요"
      },
      {
        "href": "#methodology",
        "label": "직접 비교할 때의 순서"
      },
      {
        "href": "#prompt-examples",
        "label": "내 자료로 바꿔 쓰는 질문"
      },
      {
        "href": "#comparison-faq",
        "label": "비교할 때 자주 묻는 질문"
      }
    ],
    "tasks": [
      {
        "task": "학습 설명",
        "gpt": "쉬운 예시가 개념과 맞고 내가 다시 설명할 수 있는지",
        "claude": "쉬운 예시가 개념과 맞고 내가 다시 설명할 수 있는지",
        "decision": "핵심 개념을 교재와 대조"
      },
      {
        "task": "메시지 다듬기",
        "gpt": "친절함을 더해도 원래 의도와 거절 조건을 유지하는지",
        "claude": "친절함을 더해도 원래 의도와 거절 조건을 유지하는지",
        "decision": "원래 초안의 의도와 대조"
      },
      {
        "task": "문서 요약",
        "gpt": "날짜·숫자·준비물·미정 사항을 원문대로 남기는지",
        "claude": "날짜·숫자·준비물·미정 사항을 원문대로 남기는지",
        "decision": "공지 원문과 항목별 대조"
      }
    ],
    "samplePrompt": "아래 가상 동호회 공지에서 일정과 준비물을 3개 항목 이내로 정리해 줘. 날짜와 시간을 그대로 쓰고, 공지에 없는 내용은 추가하지 마.\n\n가상 공지: 독서 모임은 11월 7일 오후 2시에 시작합니다. 읽은 책 한 권과 메모를 가져오세요. 참석 여부는 11월 3일까지 알려주세요. 장소는 추후 안내합니다.",
    "gptResult": "• 모임: 11월 7일 오후 2시. 장소는 추후 안내.\n• 준비물: 읽은 책 한 권과 메모.\n• 참석 여부: 11월 3일까지 회신.",
    "claudeResult": "• 11월 7일 오후 2시에 시작하는 독서 모임이며 장소는 아직 안내되지 않았습니다.\n• 읽은 책 한 권과 메모를 가져옵니다.\n• 11월 3일까지 참석 여부를 알립니다.",
    "methodSteps": [
      "같은 질문·원문·언어·첨부 조건을 사용합니다.",
      "먼저 보존할 사실과 출력 형식을 적습니다.",
      "전체 답변과 인용을 원문과 대조합니다. 중요한 정보는 별도로 확인합니다.",
      "실제 실행을 기록한다면 모델명·실행일·조건을 남기고 필요한 작업으로 반복합니다."
    ],
    "screenPrompt": "아래 가상 동호회 공지에서 일정과 준비물을 3개 항목 이내로 정리해 줘. 날짜와 시간을 그대로 쓰고, 공지에 없는 내용은 추가하지 마.\n\n가상 공지: 독서 모임은 11월 7일 오후 2시에 시작합니다. 읽은 책 한 권과 메모를 가져오세요. 참석 여부는 11월 3일까지 알려주세요. 장소는 추후 안내합니다.",
    "promptExamples": [
      {
        "label": "학습 설명",
        "prompt": "[개념]을 일상 예시로 설명해 줘. 핵심 용어를 남기고 내가 이해했는지 확인할 질문 하나를 붙여 줘."
      },
      {
        "label": "부드러운 거절",
        "prompt": "[초안]을 친구에게 보내는 3문장 이내 메시지로 다듬어 줘. 거절 의도는 유지하고 새로운 약속은 추가하지 마."
      },
      {
        "label": "문서 항목 추출",
        "prompt": "[문서]에 실제로 있는 일정·준비물·회신 기한만 추출해 줘. 각 항목에 근거 문장을 붙이고 없는 정보는 미정이라고 표시해 줘."
      },
      {
        "label": "코드 검토",
        "prompt": "[코드]의 문제를 심각도별로 설명해 줘. 최소 수정안과 확인할 테스트를 제안하고, 실행하지 않았다면 그렇게 밝혀 줘."
      }
    ],
    "fitCards": [
      {
        "title": "원래 조건 보존",
        "body": "내 질문의 날짜·목표·의도가 빠지지 않은 답변부터 살펴보세요."
      },
      {
        "title": "추측 대신 미정 표시",
        "body": "원문에 없는 정보는 없다고 표시했는지 확인하세요."
      },
      {
        "title": "수정해야 할 부분 확인",
        "body": "말투만 고르는 대신 인용·누락·불명확한 조건을 대조하세요."
      }
    ],
    "faqs": [
      {
        "question": "ChatGPT와 Claude 중 어느 쪽이 더 좋나요?",
        "answer": "모든 작업의 승자는 없습니다. 내가 사용할 모델 버전과 실제 질문을 같은 기준으로 비교하세요."
      },
      {
        "question": "같은 질문이면 완전히 공정한가요?",
        "answer": "비교 조건을 맞추는 데 도움이 되지만 제공자 지시·도구·문맥 처리·모델 업데이트는 다를 수 있습니다."
      },
      {
        "question": "AI Review가 정답을 골라주나요?",
        "answer": "제공된 답변의 공통점·차이·누락을 비교하는 기능입니다. 웹 검색이나 독립적인 사실검증을 수행하지 않으며 중요한 정보는 원문·출처와 확인하세요."
      },
      {
        "question": "Tomverse는 OpenAI 또는 Anthropic과 제휴했나요?",
        "answer": "아닙니다. Tomverse는 독립적인 멀티모델 워크스페이스이며 OpenAI 또는 Anthropic과 제휴하거나 보증받지 않았습니다."
      }
    ],
    "independentNotice": "Tomverse는 독립 서비스입니다. ChatGPT, GPT, Claude, OpenAI, Anthropic 명칭과 상표는 각 소유자에게 귀속됩니다.",
    "relatedLinks": [
      {
        "href": "/ko/compare-ai-models",
        "label": "AI 모델 비교",
        "body": "더 많은 모델에 같은 기준 적용하기"
      },
      {
        "href": "/ko/ai-for-file-analysis",
        "label": "AI 파일 분석",
        "body": "파일에서 조건·근거 찾기"
      },
      {
        "href": "/ko/models",
        "label": "모델 목록",
        "body": "기본 크레딧·이용 범위·상태 확인"
      }
    ]
  },
  "en": {
    "jumpLabel": "In this guide",
    "scopeEyebrow": "Models and example scope",
    "scopeTitle": "Same question. Same criteria.",
    "reviewedLabel": "About this demonstration",
    "reviewedDate": "Fictional editorial example · not a model test",
    "modelsLabel": "Models in the prepared comparison",
    "scopeNote": "GPT-5.4 mini and Claude Haiku 4.5 are the pair configured in this guide’s comparison link. The text below is not a live response or a performance measurement. Check the model catalogue for current access and base credits.",
    "resultsTitle": "Apply one checklist to both models",
    "resultsBody": "Start with what your question needs, rather than an assumed brand personality. Apply the criteria below equally to both models.",
    "taskHeader": "Situation",
    "gptHeader": "Criteria for GPT",
    "claudeHeader": "Criteria for Claude",
    "decisionHeader": "What to verify",
    "resultTitle": "A fictional book-club example with its source",
    "resultBody": "The source and shared question are provided together. Both demonstration outputs are editorial examples of the same conditions in different formats, not actual responses from either model.",
    "samplePromptLabel": "Shared question and fictional source",
    "resultTakeaway": "Checklist: keep 7 November at 2 pm, one book and notes, and the 3 November reply deadline. The venue is undecided; do not add a year, weekday or address absent from the source.",
    "resultDisclaimer": "Fictional outputs written for explanation. They do not represent a model run, verification date or performance result. The link below prepares the question and source in the composer; you decide whether to send.",
    "methodTitle": "How to run your own comparison",
    "methodBody": "Define what to check before sending the same material, so confident wording alone does not decide the result.",
    "screenTitle": "Reading in Tomverse Review",
    "screenBody": "Read answers beside one question and check them against the source conditions. AI Review can also help examine differences and omissions in completed answers.",
    "screenCaption": "Recreated UI explaining comparison. Both outputs demonstrate the fictional source above and are not real model results.",
    "promptsTitle": "Questions to adapt to your material",
    "promptsBody": "Replace brackets with your material. Do not ask models to fill absent items; apply the same conditions to both.",
    "fitTitle": "Choosing an answer for your question",
    "faqTitle": "Comparison FAQ",
    "relatedTitle": "Continue with these guides",
    "ctaEyebrow": "Compare the same input yourself",
    "ctaTitle": "Prepare a GPT-5.4 mini and Claude Haiku 4.5 comparison",
    "ctaBody": "This link prepares the two selected models, question and fictional source in Review. This prepared comparison link opens after sign-in. Check base credits and current model access before sending.",
    "ctaLabel": "Prepare the same-input comparison",
    "signInNote": "After sign-in you return to the prepared comparison. This is a condition of this link, not a claim that every guest Review trial requires sign-in.",
    "jumpLinks": [
      {
        "href": "#task-comparison",
        "label": "Apply one checklist to both models"
      },
      {
        "href": "#methodology",
        "label": "How to run your own comparison"
      },
      {
        "href": "#prompt-examples",
        "label": "Questions to adapt to your material"
      },
      {
        "href": "#comparison-faq",
        "label": "Comparison FAQ"
      }
    ],
    "tasks": [
      {
        "task": "Learning explanations",
        "gpt": "Whether examples fit the concept and you can explain it back",
        "claude": "Whether examples fit the concept and you can explain it back",
        "decision": "Check the concept against learning material"
      },
      {
        "task": "Rewriting a message",
        "gpt": "Whether kindness preserves the original intent and refusal",
        "claude": "Whether kindness preserves the original intent and refusal",
        "decision": "Check the intent against the original draft"
      },
      {
        "task": "Document summaries",
        "gpt": "Whether dates, numbers, items and undecided points stay faithful",
        "claude": "Whether dates, numbers, items and undecided points stay faithful",
        "decision": "Check each item against the notice"
      }
    ],
    "samplePrompt": "Summarise the schedule and what to bring from the fictional club notice below in no more than three bullets. Keep dates and times unchanged; don’t add information that isn’t in the notice.\n\nFictional notice: The book club starts on 7 November at 2 pm. Bring one book you have read and your notes. Confirm attendance by 3 November. The venue will be announced later.",
    "gptResult": "• Meeting: 7 November at 2 pm; venue announced later.\n• Bring: one book you have read and your notes.\n• Confirm attendance by 3 November.",
    "claudeResult": "• The book club starts on 7 November at 2 pm; the venue is not yet announced.\n• Bring a book you have read, along with notes.\n• Reply about attendance by 3 November.",
    "methodSteps": [
      "Use the same question, source, language and attachments.",
      "Write down facts and format requirements first.",
      "Check complete answers and quotes against the source; verify important information separately.",
      "For real runs, record model names, run date and conditions; repeat representative tasks."
    ],
    "screenPrompt": "Summarise the schedule and what to bring from the fictional club notice below in no more than three bullets. Keep dates and times unchanged; don’t add information that isn’t in the notice.\n\nFictional notice: The book club starts on 7 November at 2 pm. Bring one book you have read and your notes. Confirm attendance by 3 November. The venue will be announced later.",
    "promptExamples": [
      {
        "label": "Learning",
        "prompt": "Explain [concept] with an everyday example. Keep the key terms and add one question to check my understanding."
      },
      {
        "label": "A kind refusal",
        "prompt": "Rewrite [draft] as a message to a friend in no more than three sentences. Keep the refusal and add no new promises."
      },
      {
        "label": "Document extraction",
        "prompt": "Extract only the dates, items and reply deadlines present in [document]. Quote support for each item and mark missing information as unknown."
      },
      {
        "label": "Code review",
        "prompt": "Review [code] by issue severity. Suggest a minimal fix and tests to check; say if you have not executed it."
      }
    ],
    "fitCards": [
      {
        "title": "Preserve original conditions",
        "body": "Start with answers that keep your dates, goals and intent."
      },
      {
        "title": "Mark unknowns instead of guessing",
        "body": "Check that information absent from the source stays absent."
      },
      {
        "title": "Identify what needs revision",
        "body": "Compare quotes, omissions and unclear conditions, not tone alone."
      }
    ],
    "faqs": [
      {
        "question": "Is ChatGPT or Claude better?",
        "answer": "There is no winner for every task. Compare the exact model versions and real question using the same criteria."
      },
      {
        "question": "Does the same question make it perfectly fair?",
        "answer": "It helps align inputs, but provider instructions, tools, context handling and updates may differ."
      },
      {
        "question": "Does AI Review pick the correct answer?",
        "answer": "It compares agreement, differences and omissions in supplied answers. It does not browse or independently fact-check; verify important information against sources."
      },
      {
        "question": "Is Tomverse affiliated with OpenAI or Anthropic?",
        "answer": "No. Tomverse is an independent multi-model workspace and is not affiliated with or endorsed by OpenAI or Anthropic."
      }
    ],
    "independentNotice": "Tomverse is an independent service. ChatGPT, GPT, Claude, OpenAI, and Anthropic names and trademarks belong to their respective owners.",
    "relatedLinks": [
      {
        "href": "/compare-ai-models",
        "label": "AI model comparison",
        "body": "Apply the same criteria to more models"
      },
      {
        "href": "/ai-for-file-analysis",
        "label": "AI file analysis",
        "body": "Find conditions and evidence in files"
      },
      {
        "href": "/models",
        "label": "Model catalogue",
        "body": "Check base credits, access and status"
      }
    ]
  },
  "zh": {
    "jumpLabel": "本指南内容",
    "scopeEyebrow": "模型与示例范围",
    "scopeTitle": "相同问题，相同标准",
    "reviewedLabel": "关于本演示",
    "reviewedDate": "虚构编辑示例 · 并非模型测试",
    "modelsLabel": "预设比较中的模型",
    "scopeNote": "GPT-5.4 mini 和 Claude Haiku 4.5 是本指南比较链接中预设的模型。下文不是实时回答或性能测量，请在模型目录查看当前权限与基础积分。",
    "resultsTitle": "对两个模型使用同一清单",
    "resultsBody": "先明确问题的目的，不要预设品牌风格。把下列标准同样用于两个模型。",
    "taskHeader": "使用场景",
    "gptHeader": "GPT 的检查标准",
    "claudeHeader": "Claude 的检查标准",
    "decisionHeader": "需核对的内容",
    "resultTitle": "附原文的虚构读书会示例",
    "resultBody": "这里同时提供原文与相同问题。下方两个输出是将同一条件用不同格式整理的编辑示例，不是任何模型的真实回答。",
    "samplePromptLabel": "相同问题与虚构原文",
    "resultTakeaway": "清单：保留11月7日下午2点、一本书与笔记、11月3日回复期限。地点未定，不添加原文没有的年份、星期或地址。",
    "resultDisclaimer": "这些是为说明而编写的虚构输出，不代表模型运行、验证日期或性能结果。下方链接将问题和原文准备在输入框中，由你决定是否发送。",
    "methodTitle": "自己比较的步骤",
    "methodBody": "除提供相同资料外，还要先决定检查内容，避免只被自信语气影响。",
    "screenTitle": "在 Tomverse Review 中阅读",
    "screenBody": "把回答放在同一问题旁，与原文条件核对。也可用 AI Review 查看已完成回答的差异与遗漏。",
    "screenCaption": "这是说明比较方式的重现界面。两个输出基于上述虚构原文编写，不是真实模型结果。",
    "promptsTitle": "换成自己资料的问题",
    "promptsBody": "把括号换成自己的资料。不要求补全缺失信息，对两个模型使用相同条件。",
    "fitTitle": "为自己的问题选择回答",
    "faqTitle": "比较常见问题",
    "relatedTitle": "继续阅读这些指南",
    "ctaEyebrow": "自己比较相同输入",
    "ctaTitle": "准备比较 GPT-5.4 mini 与 Claude Haiku 4.5",
    "ctaBody": "此链接在 Review 中准备两个所选模型、问题与虚构原文。该预设比较链接登录后打开；发送前请查看基础积分与当前模型权限。",
    "ctaLabel": "准备相同输入的比较",
    "signInNote": "登录后返回预设比较。这是此链接的条件，并不表示所有访客 Review 体验都必须登录。",
    "jumpLinks": [
      {
        "href": "#task-comparison",
        "label": "对两个模型使用同一清单"
      },
      {
        "href": "#methodology",
        "label": "自己比较的步骤"
      },
      {
        "href": "#prompt-examples",
        "label": "换成自己资料的问题"
      },
      {
        "href": "#comparison-faq",
        "label": "比较常见问题"
      }
    ],
    "tasks": [
      {
        "task": "学习解释",
        "gpt": "示例是否符合概念，能否自己复述",
        "claude": "示例是否符合概念，能否自己复述",
        "decision": "与教材核对核心概念"
      },
      {
        "task": "润色消息",
        "gpt": "语气变温和后是否保留原意与拒绝条件",
        "claude": "语气变温和后是否保留原意与拒绝条件",
        "decision": "与原草稿核对意图"
      },
      {
        "task": "文档摘要",
        "gpt": "日期、数字、准备物品与未定事项是否忠于原文",
        "claude": "日期、数字、准备物品与未定事项是否忠于原文",
        "decision": "逐项核对通知原文"
      }
    ],
    "samplePrompt": "请把下方虚构社团通知中的日程与准备物品整理为最多三条。保留原日期和时间，不添加通知中没有的信息。\n\n虚构通知：读书会于11月7日下午2点开始。请带一本读过的书和笔记。请在11月3日前确认是否参加。地点稍后通知。",
    "gptResult": "• 活动：11月7日下午2点；地点稍后通知。\n• 准备：一本读过的书和笔记。\n• 11月3日前确认参加。",
    "claudeResult": "• 读书会于11月7日下午2点开始；地点尚未公布。\n• 带一本读过的书与笔记。\n• 11月3日前回复是否参加。",
    "methodSteps": [
      "使用相同问题、原文、语言与附件。",
      "先写明须保留的事实和格式。",
      "把完整回答与引文和原文核对，重要信息另行验证。",
      "实际运行时记录模型名、日期与条件，并重复有代表性的任务。"
    ],
    "screenPrompt": "请把下方虚构社团通知中的日程与准备物品整理为最多三条。保留原日期和时间，不添加通知中没有的信息。\n\n虚构通知：读书会于11月7日下午2点开始。请带一本读过的书和笔记。请在11月3日前确认是否参加。地点稍后通知。",
    "promptExamples": [
      {
        "label": "学习解释",
        "prompt": "用日常例子解释[概念]，保留关键术语并加一个理解检查问题。"
      },
      {
        "label": "温和拒绝",
        "prompt": "把[草稿]改成发给朋友的最多三句消息。保留拒绝意图，不添加新承诺。"
      },
      {
        "label": "文档提取",
        "prompt": "只提取[文档]实际存在的日期、物品和回复期限，逐项引用依据，缺失信息标为未定。"
      },
      {
        "label": "代码审查",
        "prompt": "按严重程度审查[代码]，建议最小修复与测试；没有执行就说明。"
      }
    ],
    "fitCards": [
      {
        "title": "保留原有条件",
        "body": "先看保留日期、目标与意图的回答。"
      },
      {
        "title": "未知就明确标注",
        "body": "检查是否明确标注原文没有的信息。"
      },
      {
        "title": "找出须修改之处",
        "body": "比较引文、遗漏与含糊条件，不只看语气。"
      }
    ],
    "faqs": [
      {
        "question": "ChatGPT 与 Claude 哪个更好？",
        "answer": "没有适合所有任务的赢家。对具体模型版本与实际问题使用相同标准。"
      },
      {
        "question": "相同问题就完全公平吗？",
        "answer": "有助于对齐输入，但提供商指令、工具、上下文处理和更新可能不同。"
      },
      {
        "question": "AI Review 会选出正确答案吗？",
        "answer": "它比较所提供回答的共识、差异与遗漏，不浏览或独立核验；重要信息请与原文和来源核对。"
      },
      {
        "question": "Is Tomverse affiliated with OpenAI or Anthropic?",
        "answer": "No. Tomverse is an independent multi-model workspace and is not affiliated with or endorsed by OpenAI or Anthropic."
      }
    ],
    "independentNotice": "Tomverse is an independent service. ChatGPT, GPT, Claude, OpenAI, and Anthropic names and trademarks belong to their respective owners.",
    "relatedLinks": [
      {
        "href": "/zh/compare-ai-models",
        "label": "AI 模型比较",
        "body": "对更多模型使用相同标准"
      },
      {
        "href": "/zh/ai-for-file-analysis",
        "label": "AI 文件分析",
        "body": "从文件找出条件与依据"
      },
      {
        "href": "/zh/models",
        "label": "模型目录",
        "body": "查看基础积分、权限与状态"
      }
    ]
  },
  "fr": {
    "jumpLabel": "Dans ce guide",
    "scopeEyebrow": "Modèles et portée de l’exemple",
    "scopeTitle": "La même question, les mêmes critères",
    "reviewedLabel": "À propos de la démonstration",
    "reviewedDate": "Exemple fictif rédigé · aucun test de modèle",
    "modelsLabel": "Modèles de la comparaison préparée",
    "scopeNote": "GPT-5.4 mini et Claude Haiku 4.5 sont les modèles configurés dans le lien de comparaison. Le texte ci-dessous n’est ni une réponse réelle ni une mesure de performance. Consultez le catalogue pour l’accès actuel et les crédits de base.",
    "resultsTitle": "Une seule grille pour les deux modèles",
    "resultsBody": "Commencez par l’objectif de votre question, sans présumer d’un style propre à la marque. Appliquez les critères ci-dessous aux deux modèles.",
    "taskHeader": "Situation",
    "gptHeader": "Critères pour GPT",
    "claudeHeader": "Critères pour Claude",
    "decisionHeader": "À vérifier",
    "resultTitle": "Un exemple fictif de club de lecture avec sa source",
    "resultBody": "La source et la question commune sont fournies ensemble. Les deux sorties sont des exemples rédigés présentant les mêmes conditions différemment, et non des réponses réelles des modèles.",
    "samplePromptLabel": "Question commune et source fictive",
    "resultTakeaway": "Vérifiez le 7 novembre à 14 h, un livre et des notes, et la réponse avant le 3 novembre. Le lieu reste indéterminé ; n’ajoutez ni année, jour de semaine ni adresse absente.",
    "resultDisclaimer": "Ces sorties fictives servent à expliquer la méthode, sans exécution, date de vérification ni résultat de performance. Le lien prépare la question et la source dans l’éditeur ; vous décidez de l’envoyer.",
    "methodTitle": "Réaliser votre propre comparaison",
    "methodBody": "Définissez les éléments à vérifier avant d’envoyer les mêmes documents, afin de ne pas juger sur le seul ton assuré.",
    "screenTitle": "Lire dans Tomverse Review",
    "screenBody": "Lisez les réponses à côté de la même question et comparez-les aux conditions de la source. AI Review aide aussi à examiner les différences et omissions des réponses terminées.",
    "screenCaption": "Interface reconstituée pour expliquer la comparaison. Les deux sorties illustrent la source fictive ci-dessus, sans résultats réels de modèles.",
    "promptsTitle": "Questions à adapter à vos documents",
    "promptsBody": "Remplacez les crochets par vos documents, sans demander d’inventer les éléments absents. Gardez les mêmes conditions pour les deux modèles.",
    "fitTitle": "Choisir la réponse adaptée à votre question",
    "faqTitle": "Questions fréquentes sur la comparaison",
    "relatedTitle": "Poursuivre avec ces guides",
    "ctaEyebrow": "Comparer vous-même les mêmes entrées",
    "ctaTitle": "Préparer une comparaison GPT-5.4 mini et Claude Haiku 4.5",
    "ctaBody": "Ce lien prépare les deux modèles, la question et la source fictive dans Review. Cette comparaison préparée s’ouvre après connexion. Vérifiez les crédits de base et l’accès actuel avant l’envoi.",
    "ctaLabel": "Préparer cette comparaison",
    "signInNote": "Après connexion, vous retrouvez la comparaison préparée. Cette condition concerne ce lien, pas tous les essais de Review sans compte.",
    "jumpLinks": [
      {
        "href": "#task-comparison",
        "label": "Une seule grille pour les deux modèles"
      },
      {
        "href": "#methodology",
        "label": "Réaliser votre propre comparaison"
      },
      {
        "href": "#prompt-examples",
        "label": "Questions à adapter à vos documents"
      },
      {
        "href": "#comparison-faq",
        "label": "Questions fréquentes sur la comparaison"
      }
    ],
    "tasks": [
      {
        "task": "Explications pour apprendre",
        "gpt": "Exemples cohérents et idée que vous pouvez reformuler",
        "claude": "Exemples cohérents et idée que vous pouvez reformuler",
        "decision": "Comparer au support d’apprentissage"
      },
      {
        "task": "Reformuler un message",
        "gpt": "Intention et refus conservés malgré un ton plus aimable",
        "claude": "Intention et refus conservés malgré un ton plus aimable",
        "decision": "Comparer à l’intention du brouillon"
      },
      {
        "task": "Résumer un document",
        "gpt": "Dates, chiffres, objets et éléments indéterminés fidèles",
        "claude": "Dates, chiffres, objets et éléments indéterminés fidèles",
        "decision": "Comparer chaque élément à l’annonce"
      }
    ],
    "samplePrompt": "Résume le calendrier et les objets à apporter de l’annonce fictive ci-dessous en trois points maximum. Conserve les dates et heures et n’ajoute aucune information absente.\n\nAnnonce fictive : le club de lecture commence le 7 novembre à 14 h. Apportez un livre lu et vos notes. Confirmez votre présence avant le 3 novembre. Le lieu sera communiqué ultérieurement.",
    "gptResult": "• Réunion : 7 novembre à 14 h ; lieu communiqué plus tard.\n• À apporter : un livre lu et vos notes.\n• Confirmer avant le 3 novembre.",
    "claudeResult": "• Le club commence le 7 novembre à 14 h ; le lieu n’est pas encore annoncé.\n• Apportez un livre lu et des notes.\n• Répondez avant le 3 novembre.",
    "methodSteps": [
      "Utilisez la même question, source, langue et les mêmes pièces jointes.",
      "Notez d’abord les faits et le format à conserver.",
      "Comparez les réponses complètes et citations à la source ; vérifiez séparément les informations importantes.",
      "Pour de vraies exécutions, notez modèles, date et conditions et répétez des tâches représentatives."
    ],
    "screenPrompt": "Résume le calendrier et les objets à apporter de l’annonce fictive ci-dessous en trois points maximum. Conserve les dates et heures et n’ajoute aucune information absente.\n\nAnnonce fictive : le club de lecture commence le 7 novembre à 14 h. Apportez un livre lu et vos notes. Confirmez votre présence avant le 3 novembre. Le lieu sera communiqué ultérieurement.",
    "promptExamples": [
      {
        "label": "Apprendre",
        "prompt": "Explique [concept] avec un exemple quotidien. Garde les termes clés et ajoute une question de compréhension."
      },
      {
        "label": "Refuser aimablement",
        "prompt": "Reformule [brouillon] pour un ami en trois phrases maximum. Conserve le refus sans ajouter de promesse."
      },
      {
        "label": "Extraire un document",
        "prompt": "Extrais uniquement dates, objets et délais présents dans [document]. Cite chaque élément et signale les informations absentes."
      },
      {
        "label": "Revue de code",
        "prompt": "Examine [code] par gravité. Propose une correction minimale et des tests ; précise si tu ne l’as pas exécuté."
      }
    ],
    "fitCards": [
      {
        "title": "Conserver les conditions",
        "body": "Commencez par les réponses qui conservent dates, objectifs et intention."
      },
      {
        "title": "Signaler l’inconnu",
        "body": "Vérifiez que les informations absentes ne sont pas inventées."
      },
      {
        "title": "Repérer les corrections",
        "body": "Comparez citations, omissions et conditions floues, pas seulement le ton."
      }
    ],
    "faqs": [
      {
        "question": "ChatGPT ou Claude : lequel est meilleur ?",
        "answer": "Il n’existe pas de vainqueur pour toutes les tâches. Comparez les versions précises et votre vraie question avec les mêmes critères."
      },
      {
        "question": "La même question garantit-elle une comparaison parfaite ?",
        "answer": "Cela aligne les entrées, mais instructions, outils, gestion du contexte et mises à jour peuvent varier."
      },
      {
        "question": "AI Review choisit-il la bonne réponse ?",
        "answer": "Il compare accords, différences et omissions des réponses fournies, sans navigation ni vérification indépendante. Vérifiez les informations importantes dans les sources."
      },
      {
        "question": "Is Tomverse affiliated with OpenAI or Anthropic?",
        "answer": "No. Tomverse is an independent multi-model workspace and is not affiliated with or endorsed by OpenAI or Anthropic."
      }
    ],
    "independentNotice": "Tomverse is an independent service. ChatGPT, GPT, Claude, OpenAI, and Anthropic names and trademarks belong to their respective owners.",
    "relatedLinks": [
      {
        "href": "/fr/compare-ai-models",
        "label": "Comparaison de modèles",
        "body": "Appliquer la grille à d’autres modèles"
      },
      {
        "href": "/fr/ai-for-file-analysis",
        "label": "Analyse de fichiers",
        "body": "Retrouver conditions et preuves"
      },
      {
        "href": "/fr/models",
        "label": "Catalogue de modèles",
        "body": "Vérifier crédits, accès et état"
      }
    ]
  },
  "de": {
    "jumpLabel": "In diesem Leitfaden",
    "scopeEyebrow": "Modelle und Beispielumfang",
    "scopeTitle": "Dieselbe Frage, dieselben Kriterien",
    "reviewedLabel": "Über diese Darstellung",
    "reviewedDate": "Fiktives redaktionelles Beispiel · kein Modelltest",
    "modelsLabel": "Modelle des vorbereiteten Vergleichs",
    "scopeNote": "GPT-5.4 mini und Claude Haiku 4.5 sind im Vergleichslink voreingestellt. Die folgenden Texte sind weder echte Antworten noch Leistungsmessungen. Aktuellen Zugriff und Basis-Credits finden Sie im Modellkatalog.",
    "resultsTitle": "Eine Checkliste für beide Modelle",
    "resultsBody": "Beginnen Sie mit dem Ziel Ihrer Frage statt mit angenommenen Markeneigenschaften. Wenden Sie die Kriterien auf beide Modelle gleichermaßen an.",
    "taskHeader": "Situation",
    "gptHeader": "Kriterien für GPT",
    "claudeHeader": "Kriterien für Claude",
    "decisionHeader": "Was Sie prüfen sollten",
    "resultTitle": "Fiktiver Lesekreis mit Ausgangstext",
    "resultBody": "Ausgangstext und gemeinsame Frage stehen zusammen. Beide Ausgaben sind redaktionelle Beispiele derselben Bedingungen in verschiedener Form, keine tatsächlichen Modellantworten.",
    "samplePromptLabel": "Gemeinsame Frage und fiktive Quelle",
    "resultTakeaway": "Prüfen Sie den 7. November um 14 Uhr, ein Buch und Notizen sowie die Antwortfrist am 3. November. Der Ort bleibt offen; Jahr, Wochentag und Adresse werden nicht ergänzt.",
    "resultDisclaimer": "Fiktive Ausgaben zur Erklärung, keine Ausführung, kein Prüfdatum und kein Leistungsergebnis. Der Link bereitet Frage und Quelle im Eingabefeld vor; Sie entscheiden über das Senden.",
    "methodTitle": "So führen Sie einen Vergleich durch",
    "methodBody": "Legen Sie vor dem Senden fest, was Sie prüfen, damit ein selbstbewusster Ton nicht allein entscheidet.",
    "screenTitle": "Antworten in Tomverse Review lesen",
    "screenBody": "Lesen Sie Antworten neben derselben Frage und prüfen Sie die Bedingungen der Quelle. AI Review hilft bei Unterschieden und Lücken fertiger Antworten.",
    "screenCaption": "Nachgebildete Oberfläche zur Erklärung. Beide Ausgaben zeigen die fiktive Quelle, keine echten Modellresultate.",
    "promptsTitle": "Fragen für Ihre eigenen Materialien",
    "promptsBody": "Ersetzen Sie Klammern durch Ihre Materialien. Lassen Sie fehlende Angaben nicht erfinden und nutzen Sie für beide Modelle dieselben Bedingungen.",
    "fitTitle": "Eine passende Antwort auswählen",
    "faqTitle": "Häufige Vergleichsfragen",
    "relatedTitle": "Weitere Leitfäden",
    "ctaEyebrow": "Dieselbe Eingabe selbst vergleichen",
    "ctaTitle": "Vergleich von GPT-5.4 mini und Claude Haiku 4.5 vorbereiten",
    "ctaBody": "Der Link bereitet beide Modelle, Frage und fiktive Quelle in Review vor. Dieser vorbereitete Vergleich öffnet sich nach der Anmeldung. Prüfen Sie vor dem Senden Basis-Credits und Modellzugriff.",
    "ctaLabel": "Vergleich vorbereiten",
    "signInNote": "Nach der Anmeldung kehren Sie zum vorbereiteten Vergleich zurück. Dies betrifft diesen Link, nicht sämtliche Review-Gasttests.",
    "jumpLinks": [
      {
        "href": "#task-comparison",
        "label": "Eine Checkliste für beide Modelle"
      },
      {
        "href": "#methodology",
        "label": "So führen Sie einen Vergleich durch"
      },
      {
        "href": "#prompt-examples",
        "label": "Fragen für Ihre eigenen Materialien"
      },
      {
        "href": "#comparison-faq",
        "label": "Häufige Vergleichsfragen"
      }
    ],
    "tasks": [
      {
        "task": "Lernerklärungen",
        "gpt": "Passende Beispiele und eigene Wiedergabe der Idee",
        "claude": "Passende Beispiele und eigene Wiedergabe der Idee",
        "decision": "Mit Lernmaterial abgleichen"
      },
      {
        "task": "Nachrichten überarbeiten",
        "gpt": "Ursprüngliche Absicht und Absage trotz freundlichem Ton",
        "claude": "Ursprüngliche Absicht und Absage trotz freundlichem Ton",
        "decision": "Mit ursprünglichem Entwurf abgleichen"
      },
      {
        "task": "Dokumente zusammenfassen",
        "gpt": "Termine, Zahlen, Mitbringsel und offene Punkte unverändert",
        "claude": "Termine, Zahlen, Mitbringsel und offene Punkte unverändert",
        "decision": "Jeden Punkt mit der Nachricht abgleichen"
      }
    ],
    "samplePrompt": "Fasse Termine und Mitbringsel aus der fiktiven Vereinsnachricht unten in höchstens drei Punkten zusammen. Übernimm Datum und Uhrzeit unverändert und ergänze nichts.\n\nFiktive Nachricht: Der Lesekreis beginnt am 7. November um 14 Uhr. Bringen Sie ein gelesenes Buch und Notizen mit. Teilnahme bis 3. November bestätigen. Der Ort folgt später.",
    "gptResult": "• Treffen: 7. November um 14 Uhr; Ort folgt später.\n• Mitbringen: ein gelesenes Buch und Notizen.\n• Teilnahme bis 3. November bestätigen.",
    "claudeResult": "• Der Lesekreis startet am 7. November um 14 Uhr; der Ort steht noch nicht fest.\n• Ein gelesenes Buch und Notizen mitbringen.\n• Bis 3. November zur Teilnahme antworten.",
    "methodSteps": [
      "Verwenden Sie dieselbe Frage, Quelle, Sprache und Anhänge.",
      "Notieren Sie zuerst Fakten und Ausgabeformat.",
      "Prüfen Sie vollständige Antworten und Zitate an der Quelle; wichtige Angaben separat.",
      "Dokumentieren Sie echte Ausführungen mit Modellnamen, Datum und Bedingungen und wiederholen Sie typische Aufgaben."
    ],
    "screenPrompt": "Fasse Termine und Mitbringsel aus der fiktiven Vereinsnachricht unten in höchstens drei Punkten zusammen. Übernimm Datum und Uhrzeit unverändert und ergänze nichts.\n\nFiktive Nachricht: Der Lesekreis beginnt am 7. November um 14 Uhr. Bringen Sie ein gelesenes Buch und Notizen mit. Teilnahme bis 3. November bestätigen. Der Ort folgt später.",
    "promptExamples": [
      {
        "label": "Lernen",
        "prompt": "Erkläre [Begriff] mit einem Alltagsbeispiel. Behalte Fachbegriffe und ergänze eine Verständnisfrage."
      },
      {
        "label": "Freundliche Absage",
        "prompt": "Überarbeite [Entwurf] als Nachricht an einen Freund in höchstens drei Sätzen. Bewahre die Absage ohne neue Versprechen."
      },
      {
        "label": "Dokumentauswertung",
        "prompt": "Nenne nur Termine, Mitbringsel und Fristen aus [Dokument]. Zitiere jeden Beleg und markiere fehlende Angaben als offen."
      },
      {
        "label": "Codeprüfung",
        "prompt": "Prüfe [Code] nach Schweregrad. Schlage eine kleine Korrektur und Tests vor; sage, wenn du nichts ausgeführt hast."
      }
    ],
    "fitCards": [
      {
        "title": "Bedingungen bewahren",
        "body": "Prüfen Sie zuerst erhaltene Termine, Ziele und Absichten."
      },
      {
        "title": "Unbekanntes kennzeichnen",
        "body": "Fehlende Informationen sollten nicht erfunden werden."
      },
      {
        "title": "Korrekturen erkennen",
        "body": "Vergleichen Sie Zitate, Lücken und unklare Bedingungen, nicht nur den Ton."
      }
    ],
    "faqs": [
      {
        "question": "Ist ChatGPT oder Claude besser?",
        "answer": "Es gibt keinen Sieger für alle Aufgaben. Vergleichen Sie genaue Modellversionen und Ihre Frage mit denselben Kriterien."
      },
      {
        "question": "Ist dieselbe Frage vollkommen fair?",
        "answer": "Es gleicht Eingaben an, doch Anbieteranweisungen, Werkzeuge, Kontextverarbeitung und Updates können abweichen."
      },
      {
        "question": "Wählt AI Review die richtige Antwort?",
        "answer": "Es vergleicht Gemeinsamkeiten, Unterschiede und Lücken gelieferter Antworten, ohne Websuche oder unabhängige Faktenprüfung. Prüfen Sie Wichtiges an Quellen."
      },
      {
        "question": "Is Tomverse affiliated with OpenAI or Anthropic?",
        "answer": "No. Tomverse is an independent multi-model workspace and is not affiliated with or endorsed by OpenAI or Anthropic."
      }
    ],
    "independentNotice": "Tomverse is an independent service. ChatGPT, GPT, Claude, OpenAI, and Anthropic names and trademarks belong to their respective owners.",
    "relatedLinks": [
      {
        "href": "/de/compare-ai-models",
        "label": "KI-Modellvergleich",
        "body": "Kriterien für weitere Modelle"
      },
      {
        "href": "/de/ai-for-file-analysis",
        "label": "KI-Dateianalyse",
        "body": "Bedingungen und Belege in Dateien"
      },
      {
        "href": "/de/models",
        "label": "Modellkatalog",
        "body": "Basis-Credits, Zugriff und Status"
      }
    ]
  },
  "es": {
    "jumpLabel": "En esta guía",
    "scopeEyebrow": "Modelos y alcance del ejemplo",
    "scopeTitle": "La misma pregunta y los mismos criterios",
    "reviewedLabel": "Sobre esta demostración",
    "reviewedDate": "Ejemplo ficticio editado · no es una prueba de modelos",
    "modelsLabel": "Modelos de la comparación preparada",
    "scopeNote": "GPT-5.4 mini y Claude Haiku 4.5 son los modelos configurados en el enlace. El texto siguiente no es una respuesta real ni una medición de rendimiento. Consulta el catálogo para ver acceso y créditos base actuales.",
    "resultsTitle": "Aplica una misma lista a ambos modelos",
    "resultsBody": "Empieza por el objetivo de tu pregunta sin presuponer rasgos de cada marca. Aplica estos criterios por igual a ambos modelos.",
    "taskHeader": "Situación",
    "gptHeader": "Criterios para GPT",
    "claudeHeader": "Criterios para Claude",
    "decisionHeader": "Qué verificar",
    "resultTitle": "Un ejemplo ficticio de club de lectura con su fuente",
    "resultBody": "Se incluyen la fuente y la pregunta común. Ambas salidas son ejemplos editados que presentan las mismas condiciones con distintos formatos, no respuestas reales de los modelos.",
    "samplePromptLabel": "Pregunta común y fuente ficticia",
    "resultTakeaway": "Comprueba el 7 de noviembre a las 14:00, un libro y notas, y la respuesta antes del 3 de noviembre. El lugar sigue pendiente; no añadas año, día de la semana ni dirección ausente.",
    "resultDisclaimer": "Son salidas ficticias para explicar el método, sin ejecución, fecha de verificación ni resultado de rendimiento. El enlace prepara la pregunta y la fuente; tú decides si las envías.",
    "methodTitle": "Cómo hacer tu propia comparación",
    "methodBody": "Define qué comprobar antes de enviar el mismo material para no decidir solo por el tono seguro.",
    "screenTitle": "Leer en Tomverse Review",
    "screenBody": "Lee las respuestas junto a la misma pregunta y comprueba las condiciones de la fuente. AI Review también ayuda a examinar diferencias y omisiones en respuestas terminadas.",
    "screenCaption": "Interfaz recreada para explicar la comparación. Ambas salidas ilustran la fuente ficticia, no resultados reales.",
    "promptsTitle": "Preguntas para adaptar a tu material",
    "promptsBody": "Sustituye los corchetes por tu material. No pidas inventar datos ausentes y aplica las mismas condiciones a ambos modelos.",
    "fitTitle": "Elegir una respuesta para tu pregunta",
    "faqTitle": "Preguntas frecuentes al comparar",
    "relatedTitle": "Continúa con estas guías",
    "ctaEyebrow": "Compara la misma entrada",
    "ctaTitle": "Prepara una comparación de GPT-5.4 mini y Claude Haiku 4.5",
    "ctaBody": "El enlace prepara los dos modelos, la pregunta y la fuente ficticia en Review. Esta comparación preparada se abre tras iniciar sesión. Revisa los créditos base y el acceso antes de enviar.",
    "ctaLabel": "Preparar la comparación",
    "signInNote": "Tras iniciar sesión vuelves a la comparación preparada. Esta condición es del enlace y no de todas las pruebas de Review como visitante.",
    "jumpLinks": [
      {
        "href": "#task-comparison",
        "label": "Aplica una misma lista a ambos modelos"
      },
      {
        "href": "#methodology",
        "label": "Cómo hacer tu propia comparación"
      },
      {
        "href": "#prompt-examples",
        "label": "Preguntas para adaptar a tu material"
      },
      {
        "href": "#comparison-faq",
        "label": "Preguntas frecuentes al comparar"
      }
    ],
    "tasks": [
      {
        "task": "Explicaciones para aprender",
        "gpt": "Ejemplos adecuados e idea que puedes explicar",
        "claude": "Ejemplos adecuados e idea que puedes explicar",
        "decision": "Contrastar con el material de estudio"
      },
      {
        "task": "Mejorar un mensaje",
        "gpt": "Intención y negativa conservadas con un tono amable",
        "claude": "Intención y negativa conservadas con un tono amable",
        "decision": "Contrastar con el borrador original"
      },
      {
        "task": "Resumir documentos",
        "gpt": "Fechas, cifras, objetos y puntos pendientes fieles",
        "claude": "Fechas, cifras, objetos y puntos pendientes fieles",
        "decision": "Contrastar cada punto con el aviso"
      }
    ],
    "samplePrompt": "Resume las fechas y qué llevar del aviso ficticio de abajo en un máximo de tres puntos. Conserva fechas y horas y no añadas datos que no aparecen.\n\nAviso ficticio: el club de lectura empieza el 7 de noviembre a las 14:00. Lleva un libro que hayas leído y tus notas. Confirma antes del 3 de noviembre. El lugar se anunciará después.",
    "gptResult": "• Reunión: 7 de noviembre a las 14:00; lugar por anunciar.\n• Llevar: un libro leído y tus notas.\n• Confirmar antes del 3 de noviembre.",
    "claudeResult": "• El club empieza el 7 de noviembre a las 14:00; el lugar aún no se anuncia.\n• Lleva un libro leído y notas.\n• Responde antes del 3 de noviembre.",
    "methodSteps": [
      "Usa la misma pregunta, fuente, idioma y adjuntos.",
      "Anota primero los hechos y el formato que deben mantenerse.",
      "Comprueba respuestas completas y citas con la fuente; verifica por separado lo importante.",
      "En ejecuciones reales, registra modelos, fecha y condiciones y repite tareas representativas."
    ],
    "screenPrompt": "Resume las fechas y qué llevar del aviso ficticio de abajo en un máximo de tres puntos. Conserva fechas y horas y no añadas datos que no aparecen.\n\nAviso ficticio: el club de lectura empieza el 7 de noviembre a las 14:00. Lleva un libro que hayas leído y tus notas. Confirma antes del 3 de noviembre. El lugar se anunciará después.",
    "promptExamples": [
      {
        "label": "Aprender",
        "prompt": "Explica [concepto] con un ejemplo cotidiano. Conserva términos clave y añade una pregunta de comprensión."
      },
      {
        "label": "Rechazar amablemente",
        "prompt": "Mejora [borrador] para un amigo en un máximo de tres frases. Mantén la negativa sin añadir promesas."
      },
      {
        "label": "Extraer un documento",
        "prompt": "Extrae solo fechas, objetos y plazos presentes en [documento]. Cita cada apoyo y marca lo ausente como pendiente."
      },
      {
        "label": "Revisar código",
        "prompt": "Revisa [código] por gravedad. Propón una corrección mínima y pruebas; indica si no lo has ejecutado."
      }
    ],
    "fitCards": [
      {
        "title": "Conservar condiciones",
        "body": "Empieza por respuestas que conservan fechas, objetivos e intención."
      },
      {
        "title": "Señalar lo desconocido",
        "body": "Comprueba que no se invente información ausente."
      },
      {
        "title": "Identificar correcciones",
        "body": "Compara citas, omisiones y condiciones poco claras, no solo el tono."
      }
    ],
    "faqs": [
      {
        "question": "¿Es mejor ChatGPT o Claude?",
        "answer": "No hay un ganador para todas las tareas. Compara versiones concretas y tu pregunta real con los mismos criterios."
      },
      {
        "question": "¿La misma pregunta hace la comparación perfecta?",
        "answer": "Ayuda a igualar entradas, pero instrucciones, herramientas, contexto y actualizaciones pueden variar."
      },
      {
        "question": "¿AI Review elige la respuesta correcta?",
        "answer": "Compara acuerdos, diferencias y omisiones en respuestas proporcionadas, sin navegar ni verificar de forma independiente. Contrasta lo importante con las fuentes."
      },
      {
        "question": "Is Tomverse affiliated with OpenAI or Anthropic?",
        "answer": "No. Tomverse is an independent multi-model workspace and is not affiliated with or endorsed by OpenAI or Anthropic."
      }
    ],
    "independentNotice": "Tomverse is an independent service. ChatGPT, GPT, Claude, OpenAI, and Anthropic names and trademarks belong to their respective owners.",
    "relatedLinks": [
      {
        "href": "/es/compare-ai-models",
        "label": "Comparar modelos",
        "body": "Aplicar criterios a más modelos"
      },
      {
        "href": "/es/ai-for-file-analysis",
        "label": "Analizar archivos",
        "body": "Buscar condiciones y evidencias"
      },
      {
        "href": "/es/models",
        "label": "Catálogo de modelos",
        "body": "Ver créditos, acceso y estado"
      }
    ]
  },
  "pt": {
    "jumpLabel": "Neste guia",
    "scopeEyebrow": "Modelos e escopo do exemplo",
    "scopeTitle": "A mesma pergunta e os mesmos critérios",
    "reviewedLabel": "Sobre esta demonstração",
    "reviewedDate": "Exemplo fictício editado · não é um teste de modelos",
    "modelsLabel": "Modelos da comparação preparada",
    "scopeNote": "GPT-5.4 mini e Claude Haiku 4.5 são os modelos configurados no link. O texto abaixo não é uma resposta real nem uma medição de desempenho. Confira o acesso e os créditos-base atuais no catálogo.",
    "resultsTitle": "Use a mesma lista nos dois modelos",
    "resultsBody": "Comece pelo objetivo da pergunta, sem presumir características de cada marca. Aplique os critérios igualmente aos dois modelos.",
    "taskHeader": "Situação",
    "gptHeader": "Critérios para GPT",
    "claudeHeader": "Critérios para Claude",
    "decisionHeader": "O que conferir",
    "resultTitle": "Exemplo fictício de clube de leitura com a fonte",
    "resultBody": "A fonte e a pergunta comum aparecem juntas. As duas saídas são exemplos editados das mesmas condições em formatos diferentes, não respostas reais dos modelos.",
    "samplePromptLabel": "Pergunta comum e fonte fictícia",
    "resultTakeaway": "Confira 7 de novembro às 14h, um livro e anotações, e a resposta até 3 de novembro. O local segue indefinido; não acrescente ano, dia da semana ou endereço ausente.",
    "resultDisclaimer": "São saídas fictícias para explicar o método, sem execução, data de verificação ou resultado de desempenho. O link prepara a pergunta e a fonte; você decide se envia.",
    "methodTitle": "Como fazer sua comparação",
    "methodBody": "Defina o que conferir antes de enviar o mesmo material para não decidir apenas pelo tom confiante.",
    "screenTitle": "Ler no Tomverse Review",
    "screenBody": "Leia as respostas ao lado da mesma pergunta e confira as condições da fonte. O AI Review também ajuda a examinar diferenças e lacunas nas respostas concluídas.",
    "screenCaption": "Interface recriada para explicar a comparação. As duas saídas ilustram a fonte fictícia, não resultados reais.",
    "promptsTitle": "Perguntas para adaptar ao seu material",
    "promptsBody": "Troque os colchetes pelo seu material. Não peça para inventar itens ausentes e use as mesmas condições nos dois modelos.",
    "fitTitle": "Escolher a resposta para sua pergunta",
    "faqTitle": "Dúvidas sobre comparação",
    "relatedTitle": "Continue com estes guias",
    "ctaEyebrow": "Compare a mesma entrada",
    "ctaTitle": "Prepare uma comparação de GPT-5.4 mini e Claude Haiku 4.5",
    "ctaBody": "O link prepara os dois modelos, a pergunta e a fonte fictícia no Review. Esta comparação preparada abre após o login. Confira os créditos-base e o acesso antes de enviar.",
    "ctaLabel": "Preparar a comparação",
    "signInNote": "Após o login, você volta à comparação preparada. Essa condição é do link e não de todas as experiências de Review como visitante.",
    "jumpLinks": [
      {
        "href": "#task-comparison",
        "label": "Use a mesma lista nos dois modelos"
      },
      {
        "href": "#methodology",
        "label": "Como fazer sua comparação"
      },
      {
        "href": "#prompt-examples",
        "label": "Perguntas para adaptar ao seu material"
      },
      {
        "href": "#comparison-faq",
        "label": "Dúvidas sobre comparação"
      }
    ],
    "tasks": [
      {
        "task": "Explicações para aprender",
        "gpt": "Exemplos coerentes e ideia que você consegue explicar",
        "claude": "Exemplos coerentes e ideia que você consegue explicar",
        "decision": "Conferir com o material de estudo"
      },
      {
        "task": "Aprimorar mensagens",
        "gpt": "Intenção e recusa preservadas com um tom gentil",
        "claude": "Intenção e recusa preservadas com um tom gentil",
        "decision": "Conferir com o rascunho original"
      },
      {
        "task": "Resumir documentos",
        "gpt": "Datas, números, itens e pontos indefinidos fiéis",
        "claude": "Datas, números, itens e pontos indefinidos fiéis",
        "decision": "Conferir cada item com o aviso"
      }
    ],
    "samplePrompt": "Resuma as datas e o que levar do aviso fictício abaixo em até três tópicos. Preserve datas e horários e não acrescente informações ausentes.\n\nAviso fictício: o clube de leitura começa em 7 de novembro às 14h. Leve um livro que já leu e suas anotações. Confirme até 3 de novembro. O local será informado depois.",
    "gptResult": "• Encontro: 7 de novembro às 14h; local a informar.\n• Levar: um livro lido e anotações.\n• Confirmar até 3 de novembro.",
    "claudeResult": "• O clube começa em 7 de novembro às 14h; o local ainda não foi informado.\n• Leve um livro lido e anotações.\n• Responda até 3 de novembro.",
    "methodSteps": [
      "Use a mesma pergunta, fonte, idioma e anexos.",
      "Anote primeiro os fatos e o formato a preservar.",
      "Confira respostas completas e citações na fonte; verifique informações importantes separadamente.",
      "Em execuções reais, registre modelos, data e condições e repita tarefas representativas."
    ],
    "screenPrompt": "Resuma as datas e o que levar do aviso fictício abaixo em até três tópicos. Preserve datas e horários e não acrescente informações ausentes.\n\nAviso fictício: o clube de leitura começa em 7 de novembro às 14h. Leve um livro que já leu e suas anotações. Confirme até 3 de novembro. O local será informado depois.",
    "promptExamples": [
      {
        "label": "Aprender",
        "prompt": "Explique [conceito] com um exemplo cotidiano. Preserve termos-chave e acrescente uma pergunta de compreensão."
      },
      {
        "label": "Recusar com gentileza",
        "prompt": "Aprimore [rascunho] para um amigo em até três frases. Preserve a recusa sem acrescentar promessas."
      },
      {
        "label": "Extrair um documento",
        "prompt": "Extraia apenas datas, itens e prazos presentes em [documento]. Cite cada apoio e marque o ausente como indefinido."
      },
      {
        "label": "Revisar código",
        "prompt": "Revise [código] por gravidade. Sugira uma correção mínima e testes; diga se não executou."
      }
    ],
    "fitCards": [
      {
        "title": "Preservar condições",
        "body": "Comece pelas respostas que preservam datas, objetivos e intenção."
      },
      {
        "title": "Indicar o desconhecido",
        "body": "Confira se informações ausentes não foram inventadas."
      },
      {
        "title": "Identificar correções",
        "body": "Compare citações, lacunas e condições pouco claras, não só o tom."
      }
    ],
    "faqs": [
      {
        "question": "ChatGPT ou Claude é melhor?",
        "answer": "Não há um vencedor para todas as tarefas. Compare versões específicas e sua pergunta real com os mesmos critérios."
      },
      {
        "question": "A mesma pergunta torna a comparação perfeita?",
        "answer": "Ajuda a igualar as entradas, mas instruções, ferramentas, contexto e atualizações podem variar."
      },
      {
        "question": "O AI Review escolhe a resposta correta?",
        "answer": "Compara consensos, diferenças e lacunas das respostas fornecidas, sem navegar ou verificar fatos de forma independente. Confira o importante nas fontes."
      },
      {
        "question": "Is Tomverse affiliated with OpenAI or Anthropic?",
        "answer": "No. Tomverse is an independent multi-model workspace and is not affiliated with or endorsed by OpenAI or Anthropic."
      }
    ],
    "independentNotice": "Tomverse is an independent service. ChatGPT, GPT, Claude, OpenAI, and Anthropic names and trademarks belong to their respective owners.",
    "relatedLinks": [
      {
        "href": "/pt/compare-ai-models",
        "label": "Comparar modelos",
        "body": "Aplicar critérios a mais modelos"
      },
      {
        "href": "/pt/ai-for-file-analysis",
        "label": "Analisar arquivos",
        "body": "Encontrar condições e evidências"
      },
      {
        "href": "/pt/models",
        "label": "Catálogo de modelos",
        "body": "Ver créditos, acesso e status"
      }
    ]
  }
};

// Shared with tests/marketingModelReferences.test.mjs, which fails if either
// id stops being publicly selectable. The prose, badges, result cards and
// preview panels below name these same two models by hand -- changing this
// list alone is not enough, see docs/policy/default-model-luna-migration.md.
const comparisonModelIds = [...CHATGPT_VS_CLAUDE_MODEL_IDS];

export function ChatGptVsClaudeGuide() {
  const { lang } = useLanguage();
  const { status } = useSession();
  const copy = guideCopy[lang];
  const comparisonParams = new URLSearchParams({
    lang,
    models: comparisonModelIds.join(","),
    prompt: copy.samplePrompt,
    source: "chatgpt-vs-claude",
  });
  const comparisonPath = `/review?${comparisonParams.toString()}`;
  const comparisonHref =
    status === "authenticated"
      ? comparisonPath
      : `/auth/signin?callbackUrl=${encodeURIComponent(comparisonPath)}`;

  return (
    <div lang={lang} className="mt-10 space-y-16 lg:mt-14 lg:space-y-20">
      <nav aria-label={copy.jumpLabel} className="flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
        <span className="px-2 text-xs font-bold uppercase tracking-[0.15em] text-zinc-500">{copy.jumpLabel}</span>
        {copy.jumpLinks.map((item) => (
          <a key={item.href} href={item.href} className="rounded-full bg-white px-3 py-1.5 text-xs font-bold text-zinc-700 ring-1 ring-zinc-200 transition hover:text-blue-600 dark:bg-zinc-950 dark:text-zinc-200 dark:ring-zinc-800 dark:hover:text-blue-400">
            {item.label}
          </a>
        ))}
      </nav>

      <section className="overflow-hidden rounded-3xl border border-blue-200 bg-gradient-to-br from-blue-50 via-white to-orange-50 p-5 dark:border-blue-900/60 dark:from-blue-950/35 dark:via-zinc-950 dark:to-orange-950/20 sm:p-7">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{copy.scopeEyebrow}</p>
        <h2 className="mt-3 max-w-3xl text-2xl font-black sm:text-3xl">{copy.scopeTitle}</h2>
        <div className="mt-6 grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-zinc-200 bg-white/90 p-4 dark:border-zinc-800 dark:bg-zinc-950/80">
            <p className="text-xs font-bold uppercase tracking-wider text-zinc-500">{copy.modelsLabel}</p>
            <div className="mt-3 flex flex-wrap gap-3">
              <ModelBadge image="/model-icons/chatgpt.png" name="GPT-5.4 mini" provider="OpenAI" />
              <ModelBadge image="/model-icons/claude.png" name="Claude Haiku 4.5" provider="Anthropic" />
            </div>
          </div>
          <div className="rounded-2xl border border-zinc-200 bg-white/90 p-4 dark:border-zinc-800 dark:bg-zinc-950/80">
            <p className="text-xs font-bold uppercase tracking-wider text-zinc-500">{copy.reviewedLabel}</p>
            <p className="mt-3 text-lg font-black">{copy.reviewedDate}</p>
            <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{copy.scopeNote}</p>
          </div>
        </div>
      </section>

      <section id="task-comparison" className="scroll-mt-24">
        <SectionHeading icon={Scale} title={copy.resultsTitle} body={copy.resultsBody} />
        <div className="mt-7 overflow-x-auto rounded-2xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[900px] border-collapse text-left text-sm">
            <thead className="bg-zinc-950 text-white">
              <tr>
                {[copy.taskHeader, copy.gptHeader, copy.claudeHeader, copy.decisionHeader].map((header) => (
                  <th key={header} scope="col" className="px-4 py-3 text-xs font-bold uppercase tracking-wider">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {copy.tasks.map((row) => (
                <tr key={row.task} className="border-t border-zinc-200 align-top dark:border-zinc-800">
                  <th scope="row" className="w-32 bg-zinc-50 px-4 py-4 font-bold dark:bg-zinc-900/60">{row.task}</th>
                  <td className="px-4 py-4 leading-6 text-zinc-600 dark:text-zinc-300">{row.gpt}</td>
                  <td className="px-4 py-4 leading-6 text-zinc-600 dark:text-zinc-300">{row.claude}</td>
                  <td className="px-4 py-4 font-semibold leading-6 text-zinc-800 dark:text-zinc-100">{row.decision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-3xl bg-zinc-950 p-5 text-white sm:p-8">
        <h2 className="text-2xl font-black sm:text-3xl">{copy.resultTitle}</h2>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-300">{copy.resultBody}</p>
        <div className="mt-6 rounded-2xl border border-zinc-700 bg-zinc-900 p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-blue-300">{copy.samplePromptLabel}</p>
          <p className="mt-2 whitespace-pre-line text-sm font-semibold leading-6 text-white">{copy.samplePrompt}</p>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <ResultCard image="/model-icons/chatgpt.png" title="GPT-5.4 mini" body={copy.gptResult} accent="blue" />
          <ResultCard image="/model-icons/claude.png" title="Claude Haiku 4.5" body={copy.claudeResult} accent="orange" />
        </div>
        <p className="mt-5 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm font-bold leading-6 text-emerald-100">{copy.resultTakeaway}</p>
        <p className="mt-3 text-xs leading-5 text-zinc-400">{copy.resultDisclaimer}</p>
      </section>

      <section id="methodology" className="scroll-mt-24">
        <SectionHeading icon={CheckCircle2} title={copy.methodTitle} body={copy.methodBody} />
        <ol className="mt-7 grid gap-4 sm:grid-cols-2">
          {copy.methodSteps.map((step, index) => (
            <li key={step} className="flex gap-4 rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">{index + 1}</span>
              <span className="text-sm font-semibold leading-6 text-zinc-700 dark:text-zinc-200">{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <SectionHeading icon={Sparkles} title={copy.screenTitle} body={copy.screenBody} />
        <figure className="mt-7 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl shadow-blue-950/20 sm:p-5">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-3 text-sm font-semibold text-zinc-100 sm:p-4">{copy.screenPrompt}</div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <PreviewPanel image="/model-icons/chatgpt.png" model="GPT-5.4 mini" body={copy.gptResult} />
            <PreviewPanel image="/model-icons/claude.png" model="Claude Haiku 4.5" body={copy.claudeResult} />
          </div>
          <figcaption className="px-2 pb-1 pt-4 text-xs leading-5 text-zinc-400">{copy.screenCaption}</figcaption>
        </figure>
      </section>

      <section id="prompt-examples" className="scroll-mt-24">
        <SectionHeading icon={Code2} title={copy.promptsTitle} body={copy.promptsBody} />
        <div className="mt-7 grid gap-4 md:grid-cols-2">
          {copy.promptExamples.map((example) => (
            <article key={example.label} className="rounded-2xl border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
              <p className="text-xs font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">{example.label}</p>
              <p className="mt-3 text-sm leading-6 text-zinc-700 dark:text-zinc-200">{example.prompt}</p>
            </article>
          ))}
        </div>
      </section>

      <section>
        <SectionHeading icon={PenLine} title={copy.fitTitle} />
        <div className="mt-7 grid gap-4 md:grid-cols-3">
          {copy.fitCards.map((card) => (
            <article key={card.title} className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
              <h3 className="font-bold">{card.title}</h3>
              <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{card.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="comparison-faq" className="scroll-mt-24">
        <SectionHeading icon={FileText} title={copy.faqTitle} />
        <div className="mt-7 divide-y divide-zinc-200 overflow-hidden rounded-2xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {copy.faqs.map((faq) => (
            <details key={faq.question} lang={faq === copy.faqs.at(-1) && lang !== "ko" ? "en" : lang} className="group bg-white px-5 py-4 open:bg-zinc-50 dark:bg-zinc-950 dark:open:bg-zinc-900/50">
              <summary className="cursor-pointer list-none pr-8 font-bold marker:hidden">{faq.question}</summary>
              <p className="mt-3 max-w-4xl text-sm leading-7 text-zinc-600 dark:text-zinc-300">{faq.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-black">{copy.relatedTitle}</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {copy.relatedLinks.map((item) => (
            <Link key={item.href} href={item.href} className="group rounded-2xl border border-zinc-200 p-5 transition hover:border-blue-400 hover:bg-blue-50/50 dark:border-zinc-800 dark:hover:border-blue-700 dark:hover:bg-blue-950/20">
              <span className="flex items-center justify-between gap-3 font-bold group-hover:text-blue-600 dark:group-hover:text-blue-400">
                {item.label}
                <ArrowRight className="h-4 w-4" />
              </span>
              <span className="mt-2 block text-sm leading-6 text-zinc-500 dark:text-zinc-400">{item.body}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="rounded-3xl bg-blue-600 p-6 text-white sm:p-9">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-100">{copy.ctaEyebrow}</p>
        <h2 className="mt-3 max-w-3xl text-3xl font-black sm:text-4xl">{copy.ctaTitle}</h2>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-blue-50">{copy.ctaBody}</p>
        <Link
          href={comparisonHref}
          onClick={() => trackProductEvent("cta_start_click", 2, { cta_location: "chatgpt_vs_claude_guide" })}
          className="mt-6 inline-flex min-h-12 items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-bold text-blue-700 transition hover:bg-blue-50"
        >
          {copy.ctaLabel}
          <ArrowRight className="h-4 w-4" />
        </Link>
        {status !== "authenticated" && <p className="mt-3 text-xs font-semibold text-blue-100">{copy.signInNote}</p>}
      </section>

      <p lang={lang === "ko" ? "ko" : "en"} className="border-t border-zinc-200 pt-6 text-xs leading-5 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">{copy.independentNotice}</p>
    </div>
  );
}

function SectionHeading({ icon: Icon, title, body }: { icon: typeof Scale; title: string; body?: string }) {
  return (
    <div className="max-w-3xl">
      <Icon className="h-6 w-6 text-blue-600 dark:text-blue-400" />
      <h2 className="mt-4 text-3xl font-black sm:text-4xl">{title}</h2>
      {body && <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{body}</p>}
    </div>
  );
}

function ModelBadge({ image, name, provider }: { image: string; name: string; provider: string }) {
  return (
    <span className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
      <Image unoptimized src={image} width={32} height={32} alt="" className="h-8 w-8 rounded-lg object-contain" />
      <span><span className="block text-sm font-bold">{name}</span><span className="block text-[11px] text-zinc-500">{provider}</span></span>
    </span>
  );
}

function ResultCard({ image, title, body, accent }: { image: string; title: string; body: string; accent: "blue" | "orange" }) {
  return (
    <article className={`rounded-2xl border p-4 ${accent === "blue" ? "border-blue-400/30 bg-blue-500/10" : "border-orange-400/30 bg-orange-500/10"}`}>
      <div className="flex items-center gap-3"><Image unoptimized src={image} width={36} height={36} alt="" className="h-9 w-9 rounded-lg bg-white object-contain" /><h3 className="font-bold">{title}</h3></div>
      <p className="mt-4 whitespace-pre-line text-sm leading-7 text-zinc-300">{body}</p>
    </article>
  );
}

function PreviewPanel({ image, model, body }: { image: string; model: string; body: string }) {
  return (
    <article className="min-h-56 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-center gap-3 border-b border-zinc-800 pb-3"><Image unoptimized src={image} width={34} height={34} alt="" className="h-[34px] w-[34px] rounded-lg bg-white object-contain" /><h3 className="text-sm font-bold text-white">{model}</h3></div>
      <p className="mt-4 whitespace-pre-line text-sm leading-7 text-zinc-300">{body}</p>
    </article>
  );
}
