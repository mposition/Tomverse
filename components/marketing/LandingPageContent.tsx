"use client";

import Link from "next/link";
import { ArrowRight, Bot, Sparkles } from "lucide-react";
import { useSession } from "next-auth/react";
import { useEffect, useRef } from "react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { usePublicBilling } from "@/components/marketing/usePublicBilling";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { ProductProofSection } from "./ProductProofSection";

type CardCopy = { title: string; description: string };
type PlanCopy = CardCopy & { id: "free" | "pro" | "max"; fallbackPrice: string };

type LandingCopy = {
  app: string;
  badge: string;
  title: string;
  description: string;
  primaryCta: string;
  signedInCta: string;
  guestCta: string;
  pricingCta: string;
  modelFinderLead: string;
  modelFinderCta: string;
  steps: string[];
  previewTitle: string;
  previewCount: string;
  previewAnswers: string[];
  reviewTitle: string;
  reviewItems: string[];
  modelStripLabel: string;
  modelCatalogue: string;
  status: string;
  supportTitle: string;
  supportDescription: string;
  supportItems: CardCopy[];
  trustTitle: string;
  trustDescription: string;
  trustItems: CardCopy[];
  safetyCta: string;
  pricingTitle: string;
  pricingDescription: string;
  plans: PlanCopy[];
  monthly: string;
  pricingDetails: string;
  faqTitle: string;
  faqs: Array<{ question: string; answer: string }>;
  ctaTitle: string;
  ctaDescription: string;
};

const englishCopy: LandingCopy = {
  app: "Chat",
  badge: "Multi-model comparison + AI cross-review",
  title: "Ask once.\nCompare answers from multiple AIs.",
  description:
    "Compare GPT, Claude, and Gemini in one place,\nthen use AI Review to find the differences and what each answer missed.",
  primaryCta: "Compare multiple AIs free",
  signedInCta: "Continue chatting",
  guestCta: "Try it first without signing up",
  pricingCta: "See pricing",
  modelFinderLead: "Not sure which AI fits your work?",
  modelFinderCta: "Get a one-minute recommendation after sign-up.",
  steps: ["Choose up to three models", "Ask once or attach a file", "Compare, review, follow up, or share"],
  previewTitle: "One question, multiple perspectives",
  previewCount: "3 models",
  previewAnswers: ["Clear next steps", "Risks and trade-offs", "Concise operating plan"],
  reviewTitle: "Tomverse AI Review",
  reviewItems: ["Common ground", "Contradiction", "Missing point", "Verify next"],
  modelStripLabel: "Compare models across leading providers",
  modelCatalogue: "Explore all models",
  status: "Live service status",
  supportTitle: "Keep the work moving after the comparison.",
  supportDescription:
    "Tomverse keeps the useful context around each answer, so a comparison can become a document, a follow-up, or a result your team can revisit.",
  supportItems: [
    { title: "Files and real context", description: "Add images, PDFs, Office documents, text files, or supported Google Drive files when the source material matters." },
    { title: "Targeted follow-up", description: "Ask one model a follow-up without losing the other answers or the original comparison." },
    { title: "Projects and records", description: "Organize conversations into projects and keep a reusable record instead of rebuilding context across tabs." },
    { title: "Share the outcome", description: "Create a read-only share page or download a clean text record when the result is ready." },
  ],
  trustTitle: "Clear controls for private and shared work.",
  trustDescription:
    "Tomverse makes storage, locks, and sharing behavior visible. AI providers still receive the prompts needed to generate a response, including when Private Mode is used.",
  trustItems: [
    { title: "Private Mode", description: "Tomverse does not save the conversation to chat history while the selected providers still process the request." },
    { title: "Locked conversations", description: "Protect sensitive saved chats and require unlock verification before protected actions." },
    { title: "Read-only sharing", description: "Share a snapshot designed not to expose later conversation updates." },
  ],
  safetyCta: "Read the safety and security overview",
  pricingTitle: "Start free. Upgrade when the work grows.",
  pricingDescription:
    "The homepage shows only the essentials. Model weights, credit examples, annual billing, add-on credits, and Fair Use details are explained on the pricing page.",
  plans: [
    { id: "free", title: "Free", fallbackPrice: "$0", description: "300 monthly AI credits for light everyday use and trying advanced models." },
    { id: "pro", title: "Pro", fallbackPrice: "$15", description: "3,000 monthly AI credits for regular multi-model comparison." },
    { id: "max", title: "Max", fallbackPrice: "$25", description: "10,000 monthly AI credits for advanced models and long documents." },
  ],
  monthly: "/ month",
  pricingDetails: "Compare plans and credit usage",
  faqTitle: "Three quick questions",
  faqs: [
    { question: "Can I use Tomverse for free?", answer: "Yes. You can try one supported free model without signing in. A Free account adds multi-model comparison and other signed-in workflows within the plan limits." },
    { question: "Which models can I compare?", answer: "The available catalogue spans providers such as OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, Moonshot, Alibaba, and Perplexity. Availability can change, so the live status page is the source of current service state." },
    { question: "How is my data handled?", answer: "Tomverse applies attachment limits, locked-chat controls, read-only share snapshots, and Private Mode. Selected AI providers still receive the request content needed to answer; review the Safety page for the complete boundaries." },
  ],
  ctaTitle: "One clearer view starts with one question.",
  ctaDescription: "Compare several AI answers, then use AI Review to decide what deserves a closer look.",
};

const copy: { en: LandingCopy } & Partial<Record<Language, LandingCopy>> = {
  en: englishCopy,
  ko: {
    ...englishCopy,
    app: "채팅하기",
    badge: "멀티모델 비교 + AI 답변 교차검토",
    title: "한 번 질문하고,\n여러 AI 답변을 비교하세요.",
    description: "GPT, Claude, Gemini의 답변을 한 화면에서 비교하고,\nAI Review로 차이와 놓친 부분을 확인하세요.",
    primaryCta: "무료로 여러 AI 비교하기",
    signedInCta: "채팅 계속하기",
    guestCta: "가입 없이 먼저 체험",
    pricingCta: "요금 보기",
    modelFinderLead: "어떤 AI가 내 작업에 맞는지 모르시겠나요?",
    modelFinderCta: "가입 후 1분 추천을 받아보세요.",
    steps: ["최대 3개 모델 선택", "한 번 질문하거나 파일 첨부", "비교·교차검토·후속 질문·공유"],
    previewTitle: "하나의 질문, 여러 관점",
    previewCount: "3개 모델",
    previewAnswers: ["명확한 다음 단계", "위험과 장단점", "간결한 실행 계획"],
    reviewTitle: "Tomverse AI Review",
    reviewItems: ["공통점", "모순", "누락", "추가 검증"],
    modelStripLabel: "주요 공급자의 모델을 한곳에서 비교",
    modelCatalogue: "전체 모델 보기",
    status: "실시간 서비스 상태",
    supportTitle: "비교한 뒤의 작업도 한 흐름으로 이어가세요.",
    supportDescription: "각 답변의 유용한 맥락을 유지해 비교 결과를 문서, 후속 질문 또는 팀이 다시 확인할 수 있는 기록으로 만듭니다.",
    supportItems: [
      { title: "파일과 실제 맥락", description: "원본 자료가 중요할 때 이미지, PDF, Office 문서, 텍스트 또는 지원되는 Google Drive 파일을 추가하세요." },
      { title: "특정 모델 후속 질문", description: "원래 비교와 다른 답변을 유지하면서 필요한 모델 하나에만 후속 질문을 보낼 수 있습니다." },
      { title: "프로젝트와 기록", description: "대화를 프로젝트로 정리하고 여러 탭에서 맥락을 다시 만들지 않아도 되는 기록을 유지하세요." },
      { title: "결과 공유", description: "결과가 준비되면 읽기 전용 공유 페이지를 만들거나 깔끔한 텍스트 기록으로 다운로드하세요." },
    ],
    trustTitle: "비공개 작업과 공유를 위한 명확한 제어.",
    trustDescription: "저장, 잠금, 공유 동작을 분명히 보여드립니다. Private Mode에서도 답변 생성에 필요한 요청은 선택한 AI 공급자에게 전송됩니다.",
    trustItems: [
      { title: "Private Mode", description: "Tomverse 대화 기록에는 저장하지 않지만 선택한 공급자는 요청을 처리합니다." },
      { title: "잠긴 대화", description: "민감한 저장 대화를 보호하고 중요한 작업 전에 잠금 해제 확인을 요구합니다." },
      { title: "읽기 전용 공유", description: "이후 대화 업데이트가 노출되지 않도록 설계된 스냅샷을 공유합니다." },
    ],
    safetyCta: "안전 및 보안 개요 보기",
    pricingTitle: "무료로 시작하고 작업이 커질 때 업그레이드하세요.",
    pricingDescription: "홈페이지에는 핵심만 표시합니다. 모델별 차감량, 크레딧 예시, 연간 결제, 추가 크레딧과 공정사용 정책은 요금 페이지에서 확인하세요.",
    plans: [
      { id: "free", title: "Free", fallbackPrice: "$0", description: "가벼운 일상 사용과 고급 모델 체험을 위한 월 300 AI 크레딧." },
      { id: "pro", title: "Pro", fallbackPrice: "$15", description: "일상적인 멀티모델 비교를 위한 월 3,000 AI 크레딧." },
      { id: "max", title: "Max", fallbackPrice: "$25", description: "고급 모델·긴 문서 작업을 위한 월 10,000 AI 크레딧." },
    ],
    monthly: "/ 월",
    pricingDetails: "플랜과 크레딧 사용량 비교",
    faqTitle: "빠르게 확인하는 세 가지",
    faqs: [
      { question: "Tomverse를 무료로 사용할 수 있나요?", answer: "네. 로그인 없이 지원되는 무료 모델 1개를 체험할 수 있습니다. Free 계정을 만들면 플랜 한도 안에서 멀티모델 비교와 로그인 전용 기능을 사용할 수 있습니다." },
      { question: "어떤 모델을 비교할 수 있나요?", answer: "OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, Moonshot, Alibaba, Perplexity 등의 모델을 지원합니다. 제공 상태는 바뀔 수 있으므로 실시간 상태 페이지에서 현재 상태를 확인할 수 있습니다." },
      { question: "데이터는 어떻게 처리되나요?", answer: "첨부파일 제한, 대화 잠금, 읽기 전용 공유 스냅샷과 Private Mode를 적용합니다. 선택한 AI 공급자는 답변에 필요한 요청 내용을 처리하므로 전체 범위는 안전 페이지에서 확인하세요." },
    ],
    ctaTitle: "더 명확한 시야는 하나의 질문에서 시작됩니다.",
    ctaDescription: "여러 AI 답변을 비교한 뒤 AI Review로 더 살펴볼 부분을 빠르게 찾으세요.",
  },
  zh: {
    ...englishCopy,
    app: "开始聊天",
    badge: "多模型比较 + AI 交叉审查",
    title: "问一次，\n比较多个 AI 的回答。",
    description: "在一个页面比较 GPT、Claude 和 Gemini，再用 AI Review 找出差异与遗漏。",
    primaryCta: "免费比较多个 AI",
    signedInCta: "继续聊天",
    guestCta: "无需注册先体验",
    pricingCta: "查看价格",
    modelFinderLead: "不确定哪种 AI 适合你的工作？",
    modelFinderCta: "注册后获取一分钟推荐。",
    steps: ["最多选择三个模型", "提问一次或附加文件", "比较、审查、追问或分享"],
    previewTitle: "一个问题，多种视角",
    previewCount: "3 个模型",
    previewAnswers: ["清晰的下一步", "风险与取舍", "简洁的执行计划"],
    reviewItems: ["共识", "矛盾", "遗漏", "下一步核实"],
    modelStripLabel: "比较多个主流供应商的模型",
    modelCatalogue: "浏览全部模型",
    status: "实时服务状态",
    supportTitle: "比较之后，继续完成工作。",
    supportDescription: "Tomverse 保留每个回答的上下文，让比较结果变成文档、追问或可复用的团队记录。",
    supportItems: [
      { title: "文件与真实上下文", description: "需要原始材料时，可添加图片、PDF、Office 文档、文本或受支持的 Google Drive 文件。" },
      { title: "定向追问", description: "保留原始比较，同时只向一个模型继续提问。" },
      { title: "项目与记录", description: "按项目整理对话，避免在多个标签页重复建立上下文。" },
      { title: "分享结果", description: "创建只读分享页，或下载整洁的文本记录。" },
    ],
    trustTitle: "为私密与共享工作提供清晰控制。",
    trustDescription: "存储、锁定和共享行为清晰可见。即使使用 Private Mode，所选 AI 供应商仍会处理生成回答所需的请求。",
    trustItems: [
      { title: "Private Mode", description: "不保存到 Tomverse 对话历史，但所选供应商仍会处理请求。" },
      { title: "锁定对话", description: "保护敏感对话，并在受保护操作前要求解锁验证。" },
      { title: "只读分享", description: "分享不会暴露后续对话更新的快照。" },
    ],
    safetyCta: "查看安全与保障说明",
    pricingTitle: "免费开始，按需升级。",
    pricingDescription: "首页只展示核心信息。模型权重、积分示例、年付、附加积分和公平使用政策请查看价格页。",
    plans: [
      { id: "free", title: "Free", fallbackPrice: "$0", description: "每月 300 AI 积分，适合轻量日常使用。" },
      { id: "pro", title: "Pro", fallbackPrice: "$15", description: "每月 3,000 AI 积分，适合常规多模型比较。" },
      { id: "max", title: "Max", fallbackPrice: "$25", description: "每月 10,000 AI 积分，适合高级模型和长文档。" },
    ],
    monthly: "/ 月",
    pricingDetails: "比较套餐与积分用量",
    faqTitle: "三个常见问题",
    faqs: [
      { question: "可以免费使用 Tomverse 吗？", answer: "可以。无需登录即可试用一个受支持的免费模型；Free 账户可在套餐限制内使用多模型比较等功能。" },
      { question: "可以比较哪些模型？", answer: "模型目录覆盖 OpenAI、Anthropic、Google、Groq、DeepSeek、xAI、Mistral、Moonshot、Alibaba 和 Perplexity 等供应商；当前状态请查看实时状态页。" },
      { question: "数据如何处理？", answer: "Tomverse 提供附件限制、对话锁、只读分享快照和 Private Mode。所选 AI 供应商仍会处理生成回答所需的内容；完整边界请查看安全页。" },
    ],
    ctaTitle: "一个问题，获得更清晰的全貌。",
    ctaDescription: "比较多个 AI 回答，再用 AI Review 找出值得深入核实的部分。",
  },
  fr: {
    ...englishCopy,
    app: "Discuter",
    badge: "Comparaison multi-modèles + revue croisée IA",
    title: "Posez une question.\nComparez plusieurs réponses IA.",
    description: "Comparez GPT, Claude et Gemini au même endroit, puis repérez les différences et les oublis avec AI Review.",
    primaryCta: "Comparer plusieurs IA gratuitement",
    signedInCta: "Continuer la discussion",
    guestCta: "Essayer sans s’inscrire",
    pricingCta: "Voir les tarifs",
    modelFinderLead: "Vous ne savez pas quelle IA choisir ?",
    modelFinderCta: "Obtenez une recommandation en une minute après inscription.",
    steps: ["Choisissez jusqu’à trois modèles", "Posez une question ou joignez un fichier", "Comparez, révisez, relancez ou partagez"],
    previewTitle: "Une question, plusieurs points de vue",
    previewCount: "3 modèles",
    previewAnswers: ["Prochaines étapes", "Risques et compromis", "Plan d’action concis"],
    reviewItems: ["Points communs", "Contradiction", "Omission", "À vérifier"],
    modelStripLabel: "Comparez les modèles des principaux fournisseurs",
    modelCatalogue: "Explorer tous les modèles",
    status: "État du service",
    supportTitle: "Poursuivez le travail après la comparaison.",
    supportDescription: "Tomverse conserve le contexte utile pour transformer une comparaison en document, relance ou résultat réutilisable.",
    supportItems: [
      { title: "Fichiers et contexte réel", description: "Ajoutez images, PDF, documents Office, texte ou fichiers Google Drive pris en charge." },
      { title: "Relance ciblée", description: "Interrogez un seul modèle sans perdre les autres réponses ni la comparaison." },
      { title: "Projets et archives", description: "Organisez les conversations en projets et conservez un contexte réutilisable." },
      { title: "Partager le résultat", description: "Créez une page en lecture seule ou téléchargez une trace texte propre." },
    ],
    trustTitle: "Des contrôles clairs pour le travail privé et partagé.",
    trustDescription: "Le stockage, le verrouillage et le partage sont visibles. Même en Private Mode, les fournisseurs sélectionnés traitent la demande nécessaire à la réponse.",
    trustItems: [
      { title: "Private Mode", description: "La conversation n’est pas enregistrée dans l’historique Tomverse, mais les fournisseurs traitent la demande." },
      { title: "Conversations verrouillées", description: "Protégez les conversations sensibles avant les actions à risque." },
      { title: "Partage en lecture seule", description: "Partagez un instantané qui n’expose pas les mises à jour ultérieures." },
    ],
    safetyCta: "Lire l’aperçu sécurité",
    pricingTitle: "Commencez gratuitement, évoluez selon vos besoins.",
    pricingDescription: "Les poids des modèles, exemples de crédits, paiements annuels, crédits additionnels et Fair Use sont détaillés sur la page Tarifs.",
    plans: [
      { id: "free", title: "Free", fallbackPrice: "$0", description: "300 crédits IA mensuels pour un usage léger." },
      { id: "pro", title: "Pro", fallbackPrice: "$15", description: "3 000 crédits IA mensuels pour comparer régulièrement." },
      { id: "max", title: "Max", fallbackPrice: "$25", description: "10 000 crédits IA mensuels pour modèles avancés et longs documents." },
    ],
    monthly: "/ mois",
    pricingDetails: "Comparer les plans et crédits",
    faqTitle: "Trois questions rapides",
    faqs: [
      { question: "Puis-je utiliser Tomverse gratuitement ?", answer: "Oui. Un modèle gratuit est accessible sans connexion. Un compte Free ajoute la comparaison multi-modèles dans les limites du plan." },
      { question: "Quels modèles puis-je comparer ?", answer: "Le catalogue couvre notamment OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, Moonshot, Alibaba et Perplexity. Consultez la page d’état pour la disponibilité actuelle." },
      { question: "Comment mes données sont-elles traitées ?", answer: "Tomverse applique limites de pièces jointes, verrouillage, instantanés en lecture seule et Private Mode. Les fournisseurs sélectionnés traitent toujours le contenu nécessaire à la réponse." },
    ],
    ctaTitle: "Une vision plus claire commence par une question.",
    ctaDescription: "Comparez plusieurs réponses puis utilisez AI Review pour cibler ce qui mérite un examen approfondi.",
  },
  de: {
    ...englishCopy,
    app: "Chatten",
    badge: "Multi-Modell-Vergleich + KI-Gegenprüfung",
    title: "Einmal fragen.\nAntworten mehrerer KIs vergleichen.",
    description: "Vergleichen Sie GPT, Claude und Gemini an einem Ort und erkennen Sie mit AI Review Unterschiede und Lücken.",
    primaryCta: "Mehrere KIs kostenlos vergleichen",
    signedInCta: "Chat fortsetzen",
    guestCta: "Ohne Anmeldung testen",
    pricingCta: "Preise ansehen",
    modelFinderLead: "Unsicher, welche KI passt?",
    modelFinderCta: "Nach der Anmeldung in einer Minute empfehlen lassen.",
    steps: ["Bis zu drei Modelle wählen", "Einmal fragen oder Datei anhängen", "Vergleichen, prüfen, nachfragen oder teilen"],
    previewTitle: "Eine Frage, mehrere Perspektiven",
    previewCount: "3 Modelle",
    previewAnswers: ["Klare nächste Schritte", "Risiken und Abwägungen", "Kompakter Betriebsplan"],
    reviewItems: ["Gemeinsamkeit", "Widerspruch", "Lücke", "Zu prüfen"],
    modelStripLabel: "Modelle führender Anbieter vergleichen",
    modelCatalogue: "Alle Modelle ansehen",
    status: "Live-Servicestatus",
    supportTitle: "Nach dem Vergleich direkt weiterarbeiten.",
    supportDescription: "Tomverse hält den nützlichen Kontext zusammen, damit aus dem Vergleich ein Dokument, eine Nachfrage oder ein wiederverwendbares Ergebnis wird.",
    supportItems: [
      { title: "Dateien und echter Kontext", description: "Bilder, PDFs, Office-Dokumente, Text oder unterstützte Google-Drive-Dateien hinzufügen." },
      { title: "Gezielte Nachfrage", description: "Ein Modell weiterfragen, ohne die anderen Antworten oder den Vergleich zu verlieren." },
      { title: "Projekte und Verlauf", description: "Unterhaltungen in Projekten organisieren und Kontext wiederverwenden." },
      { title: "Ergebnis teilen", description: "Schreibgeschützte Freigabe erstellen oder einen sauberen Textverlauf laden." },
    ],
    trustTitle: "Klare Kontrollen für private und geteilte Arbeit.",
    trustDescription: "Speicherung, Sperren und Freigaben sind sichtbar. Auch im Private Mode verarbeiten ausgewählte KI-Anbieter die für die Antwort nötige Anfrage.",
    trustItems: [
      { title: "Private Mode", description: "Kein Tomverse-Chatverlauf, während ausgewählte Anbieter die Anfrage verarbeiten." },
      { title: "Gesperrte Unterhaltungen", description: "Sensible Chats schützen und vor geschützten Aktionen entsperren." },
      { title: "Schreibgeschütztes Teilen", description: "Einen Snapshot teilen, der spätere Aktualisierungen nicht offenlegt." },
    ],
    safetyCta: "Sicherheitsübersicht lesen",
    pricingTitle: "Kostenlos starten, bei Bedarf erweitern.",
    pricingDescription: "Modellgewichte, Kreditbeispiele, Jahreszahlung, Zusatzkredite und Fair Use stehen auf der Preisseite.",
    plans: [
      { id: "free", title: "Free", fallbackPrice: "$0", description: "300 monatliche KI-Kredite für leichte Nutzung." },
      { id: "pro", title: "Pro", fallbackPrice: "$15", description: "3.000 monatliche KI-Kredite für regelmäßige Vergleiche." },
      { id: "max", title: "Max", fallbackPrice: "$25", description: "10.000 monatliche KI-Kredite für fortgeschrittene Modelle und lange Dokumente." },
    ],
    monthly: "/ Monat",
    pricingDetails: "Pläne und Kreditverbrauch vergleichen",
    faqTitle: "Drei kurze Fragen",
    faqs: [
      { question: "Kann ich Tomverse kostenlos nutzen?", answer: "Ja. Ein unterstütztes Gratis-Modell ist ohne Anmeldung nutzbar. Ein Free-Konto ermöglicht Multi-Modell-Vergleiche innerhalb der Planlimits." },
      { question: "Welche Modelle kann ich vergleichen?", answer: "Der Katalog umfasst unter anderem OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, Moonshot, Alibaba und Perplexity. Aktuelle Verfügbarkeit zeigt die Statusseite." },
      { question: "Wie werden meine Daten verarbeitet?", answer: "Tomverse nutzt Anhangslimits, Chatsperren, schreibgeschützte Snapshots und Private Mode. Ausgewählte KI-Anbieter verarbeiten weiterhin die für Antworten nötigen Inhalte." },
    ],
    ctaTitle: "Ein klarerer Blick beginnt mit einer Frage.",
    ctaDescription: "Mehrere Antworten vergleichen und mit AI Review gezielt tiefer prüfen.",
  },
  es: {
    ...englishCopy,
    app: "Chatear",
    badge: "Comparación multimodelo + revisión cruzada de IA",
    title: "Pregunta una vez.\nCompara respuestas de varias IA.",
    description: "Compara GPT, Claude y Gemini en un solo lugar y usa AI Review para detectar diferencias y omisiones.",
    primaryCta: "Comparar varias IA gratis",
    signedInCta: "Continuar el chat",
    guestCta: "Probar sin registrarse",
    pricingCta: "Ver precios",
    modelFinderLead: "¿No sabes qué IA encaja contigo?",
    modelFinderCta: "Recibe una recomendación de un minuto tras registrarte.",
    steps: ["Elige hasta tres modelos", "Pregunta o adjunta un archivo", "Compara, revisa, continúa o comparte"],
    previewTitle: "Una pregunta, varias perspectivas",
    previewCount: "3 modelos",
    previewAnswers: ["Próximos pasos claros", "Riesgos y alternativas", "Plan operativo conciso"],
    reviewItems: ["Coincidencias", "Contradicción", "Omisión", "Por verificar"],
    modelStripLabel: "Compara modelos de los principales proveedores",
    modelCatalogue: "Explorar todos los modelos",
    status: "Estado del servicio",
    supportTitle: "Continúa el trabajo después de comparar.",
    supportDescription: "Tomverse conserva el contexto útil para convertir una comparación en documento, seguimiento o resultado reutilizable.",
    supportItems: [
      { title: "Archivos y contexto real", description: "Añade imágenes, PDF, documentos Office, texto o archivos compatibles de Google Drive." },
      { title: "Seguimiento dirigido", description: "Pregunta a un modelo concreto sin perder las demás respuestas." },
      { title: "Proyectos y registros", description: "Organiza conversaciones en proyectos y conserva un contexto reutilizable." },
      { title: "Comparte el resultado", description: "Crea una página de solo lectura o descarga un registro de texto limpio." },
    ],
    trustTitle: "Controles claros para trabajo privado y compartido.",
    trustDescription: "El almacenamiento, bloqueo y uso compartido son visibles. Incluso en Private Mode, los proveedores elegidos procesan la solicitud necesaria para responder.",
    trustItems: [
      { title: "Private Mode", description: "No se guarda en el historial de Tomverse, pero los proveedores seleccionados procesan la solicitud." },
      { title: "Conversaciones bloqueadas", description: "Protege chats sensibles antes de acciones protegidas." },
      { title: "Compartir en solo lectura", description: "Comparte una instantánea que no expone cambios posteriores." },
    ],
    safetyCta: "Leer seguridad y protección",
    pricingTitle: "Empieza gratis y mejora cuando crezca el trabajo.",
    pricingDescription: "Los pesos por modelo, ejemplos de créditos, pago anual, créditos extra y Fair Use están en la página de precios.",
    plans: [
      { id: "free", title: "Free", fallbackPrice: "$0", description: "300 créditos IA al mes para uso ligero." },
      { id: "pro", title: "Pro", fallbackPrice: "$15", description: "3.000 créditos IA al mes para comparaciones habituales." },
      { id: "max", title: "Max", fallbackPrice: "$25", description: "10.000 créditos IA al mes para modelos avanzados y documentos largos." },
    ],
    monthly: "/ mes",
    pricingDetails: "Comparar planes y créditos",
    faqTitle: "Tres preguntas rápidas",
    faqs: [
      { question: "¿Puedo usar Tomverse gratis?", answer: "Sí. Puedes probar un modelo gratuito compatible sin iniciar sesión. Una cuenta Free añade comparación multimodelo dentro de los límites del plan." },
      { question: "¿Qué modelos puedo comparar?", answer: "El catálogo incluye proveedores como OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, Moonshot, Alibaba y Perplexity. Consulta el estado en vivo para la disponibilidad actual." },
      { question: "¿Cómo se tratan mis datos?", answer: "Tomverse aplica límites de archivos, bloqueo de chats, instantáneas de solo lectura y Private Mode. Los proveedores elegidos siguen procesando el contenido necesario para responder." },
    ],
    ctaTitle: "Una visión más clara empieza con una pregunta.",
    ctaDescription: "Compara varias respuestas y usa AI Review para decidir qué revisar con más detalle.",
  },
  pt: {
    ...englishCopy,
    app: "Conversar",
    badge: "Comparação multimodelo + revisão cruzada por IA",
    title: "Pergunte uma vez.\nCompare respostas de várias IAs.",
    description: "Compare GPT, Claude e Gemini em um só lugar e use o AI Review para encontrar diferenças e omissões.",
    primaryCta: "Comparar várias IAs gratuitamente",
    signedInCta: "Continuar a conversa",
    guestCta: "Testar sem se cadastrar",
    pricingCta: "Ver preços",
    modelFinderLead: "Não sabe qual IA combina com seu trabalho?",
    modelFinderCta: "Receba uma recomendação de um minuto após criar a conta.",
    steps: ["Escolha até três modelos", "Pergunte ou anexe um arquivo", "Compare, revise, continue ou compartilhe"],
    previewTitle: "Uma pergunta, várias perspectivas",
    previewCount: "3 modelos",
    previewAnswers: ["Próximos passos claros", "Riscos e escolhas", "Plano operacional conciso"],
    reviewItems: ["Consenso", "Contradição", "Omissão", "A verificar"],
    modelStripLabel: "Compare modelos dos principais provedores",
    modelCatalogue: "Explorar todos os modelos",
    status: "Status do serviço",
    supportTitle: "Continue o trabalho depois da comparação.",
    supportDescription: "O Tomverse mantém o contexto útil para transformar uma comparação em documento, acompanhamento ou resultado reutilizável.",
    supportItems: [
      { title: "Arquivos e contexto real", description: "Adicione imagens, PDFs, documentos Office, texto ou arquivos compatíveis do Google Drive." },
      { title: "Acompanhamento direcionado", description: "Pergunte a um modelo específico sem perder as outras respostas." },
      { title: "Projetos e registros", description: "Organize conversas por projeto e mantenha contexto reutilizável." },
      { title: "Compartilhe o resultado", description: "Crie uma página somente leitura ou baixe um registro de texto limpo." },
    ],
    trustTitle: "Controles claros para trabalho privado e compartilhado.",
    trustDescription: "Armazenamento, bloqueio e compartilhamento ficam visíveis. Mesmo no Private Mode, os provedores escolhidos processam a solicitação necessária para responder.",
    trustItems: [
      { title: "Private Mode", description: "Não salva no histórico do Tomverse, mas os provedores selecionados processam a solicitação." },
      { title: "Conversas bloqueadas", description: "Proteja chats sensíveis antes de ações protegidas." },
      { title: "Compartilhamento somente leitura", description: "Compartilhe um snapshot que não expõe atualizações posteriores." },
    ],
    safetyCta: "Ler visão geral de segurança",
    pricingTitle: "Comece grátis e evolua quando o trabalho crescer.",
    pricingDescription: "Pesos por modelo, exemplos de créditos, cobrança anual, créditos extras e Fair Use estão na página de preços.",
    plans: [
      { id: "free", title: "Free", fallbackPrice: "$0", description: "300 créditos de IA por mês para uso leve." },
      { id: "pro", title: "Pro", fallbackPrice: "$15", description: "3.000 créditos de IA por mês para comparações regulares." },
      { id: "max", title: "Max", fallbackPrice: "$25", description: "10.000 créditos de IA por mês para modelos avançados e documentos longos." },
    ],
    monthly: "/ mês",
    pricingDetails: "Comparar planos e créditos",
    faqTitle: "Três perguntas rápidas",
    faqs: [
      { question: "Posso usar o Tomverse gratuitamente?", answer: "Sim. Você pode testar um modelo gratuito compatível sem entrar. Uma conta Free adiciona comparação multimodelo dentro dos limites do plano." },
      { question: "Quais modelos posso comparar?", answer: "O catálogo inclui provedores como OpenAI, Anthropic, Google, Groq, DeepSeek, xAI, Mistral, Moonshot, Alibaba e Perplexity. Veja a página de status para a disponibilidade atual." },
      { question: "Como meus dados são tratados?", answer: "O Tomverse aplica limites de anexos, bloqueio, snapshots somente leitura e Private Mode. Os provedores escolhidos continuam processando o conteúdo necessário para responder." },
    ],
    ctaTitle: "Uma visão mais clara começa com uma pergunta.",
    ctaDescription: "Compare várias respostas e use o AI Review para decidir o que merece análise mais profunda.",
  },
};

export function LandingPageContent() {
  const { lang } = useLanguage();
  const { status } = useSession();
  const content = copy[lang] ?? englishCopy;
  const billing = usePublicBilling();
  const chatHref = `/chat?lang=${encodeURIComponent(lang)}`;
  const guestChatHref = `${chatHref}&entry=guest-preview`;
  const signInHref = `/auth/signin?callbackUrl=${encodeURIComponent(chatHref)}`;
  const comparisonHref = status === "authenticated" ? chatHref : signInHref;
  const landingTrackedRef = useRef(false);

  useEffect(() => {
    if (landingTrackedRef.current) return;
    landingTrackedRef.current = true;
    trackProductEvent("landing_view");
  }, []);

  return (
    <main className="min-h-screen overflow-x-hidden bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader />

      <section className="relative border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 pb-12 pt-10 sm:px-6 sm:pb-14 sm:pt-12 lg:grid-cols-[1.03fr_0.97fr] lg:items-center lg:px-8 lg:py-16">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {content.badge}
            </div>
            <h1 className="mt-6 max-w-4xl whitespace-pre-line text-4xl font-black leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
              {content.title}
            </h1>
            <p className="mt-6 max-w-2xl whitespace-pre-line text-lg leading-8 text-zinc-600 dark:text-zinc-300">{content.description}</p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link
                id="landing-hero-primary"
                href={comparisonHref}
                data-testid="landing-primary-cta"
                onClick={() => trackProductEvent("cta_start_click", 0, { cta_location: "landing_hero_compare" })}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 text-sm font-black text-white shadow-lg shadow-blue-950/20 transition hover:bg-blue-500"
              >
                {status === "authenticated" ? content.signedInCta : content.primaryCta}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              {status === "unauthenticated" && (
                <Link
                  href={guestChatHref}
                  data-testid="landing-guest-cta"
                  onClick={() => trackProductEvent("cta_start_click", 0, { cta_location: "landing_hero_guest" })}
                  className="inline-flex min-h-10 items-center justify-center px-2 text-center text-sm font-bold text-zinc-600 underline decoration-zinc-300 underline-offset-4 transition hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                >
                  {content.guestCta}
                </Link>
              )}
            </div>
          </div>

          <div className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 p-2 shadow-2xl shadow-zinc-300/60 dark:shadow-black/50 md:p-3">
            <div className="rounded-[1.25rem] border border-zinc-800 bg-zinc-950 text-white">
              <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                <span className="flex items-center gap-2 text-xs font-bold text-zinc-300"><Bot className="h-4 w-4 text-blue-400" />{content.previewTitle}</span>
                <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-black text-emerald-300">{content.previewCount}</span>
              </div>
              <div className="grid gap-2 p-3 sm:grid-cols-3">
                {["GPT", "Claude", "Gemini"].map((model, index) => (
                  <article key={model} className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-3">
                    <div className="flex items-center justify-between"><span className="text-sm font-black">{model}</span><span className="h-2 w-2 rounded-full bg-zinc-500" /></div>
                    <div className="mt-4 space-y-2"><div className="h-2 w-4/5 rounded-full bg-zinc-700" /><div className="h-2 w-full rounded-full bg-zinc-800" /></div>
                    <p className="mt-4 rounded-xl border border-zinc-700 bg-zinc-800 p-2.5 text-xs font-bold leading-5 text-zinc-200">{content.previewAnswers[index]}</p>
                  </article>
                ))}
              </div>
              <div className="mx-3 mb-3 rounded-2xl border border-blue-500/30 bg-blue-500/10 p-3">
                <div className="flex items-center gap-2 text-xs font-black text-blue-200"><Sparkles className="h-3.5 w-3.5" />{content.reviewTitle}</div>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {content.reviewItems.map((item, index) => (
                    <span key={item} className="flex items-center gap-1.5 rounded-lg bg-black/20 px-2 py-2 text-[11px] font-bold text-zinc-200">
                      <span className={`h-1.5 w-1.5 rounded-full ${index === 1 || index === 3 ? "bg-amber-400" : "bg-emerald-400"}`} />{item}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

      </section>

      <ProductProofSection />

      <section id="pricing" className="border-y border-zinc-200 bg-zinc-50 py-16 dark:border-zinc-800 dark:bg-zinc-900/30 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl"><h2 className="text-3xl font-black sm:text-4xl">{content.pricingTitle}</h2><p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-300">{content.pricingDescription}</p></div>
          <div className="mt-9 grid gap-4 md:grid-cols-3">
            {content.plans.map((plan) => {
              const formatted = billing.formatPlanPrice(plan.id) || plan.fallbackPrice;
              return <article key={plan.id} className={`rounded-2xl border p-5 ${plan.id === "pro" ? "border-blue-500 bg-blue-50/70 dark:bg-blue-950/20" : "border-zinc-200 dark:border-zinc-800"}`}><h3 className="text-lg font-black">{plan.title}</h3><p className="mt-4 text-3xl font-black">{formatted}<span className="ml-1 text-sm font-semibold text-zinc-500">{plan.id === "free" ? "" : content.monthly}</span></p><p className="mt-4 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{plan.description}</p></article>;
            })}
          </div>
          <Link href="/pricing" className="mt-7 inline-flex items-center gap-2 rounded-xl bg-zinc-950 px-5 py-3 text-sm font-black text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200">{content.pricingDetails}<ArrowRight className="h-4 w-4" /></Link>
          <h2 className="mt-16 text-3xl font-black sm:text-4xl">{content.faqTitle}</h2>
          <div className="mt-8 grid gap-4 lg:grid-cols-3">
            {content.faqs.map((item) => <details key={item.question} className="group rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800"><summary className="cursor-pointer list-none font-black">{item.question}</summary><p className="mt-4 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{item.answer}</p></details>)}
          </div>
          <div className="mt-12 flex flex-col items-start justify-between gap-6 rounded-3xl bg-zinc-950 p-7 text-white sm:p-9 lg:flex-row lg:items-center dark:border dark:border-zinc-800">
            <div className="max-w-2xl"><h2 className="text-3xl font-black">{content.ctaTitle}</h2><p className="mt-3 leading-7 text-zinc-300">{content.ctaDescription}</p></div>
            <Link href={comparisonHref} onClick={() => trackProductEvent("cta_start_click", 0, { cta_location: "landing_final_compare" })} className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-white px-6 text-sm font-black text-zinc-950 hover:bg-zinc-200">{status === "authenticated" ? content.signedInCta : content.primaryCta}<ArrowRight className="h-4 w-4" /></Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </main>
  );
}
