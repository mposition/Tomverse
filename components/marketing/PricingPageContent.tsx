"use client";

import Link from "next/link";
import { CheckCircle2, Minus } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { UpgradeInterestButton } from "@/components/marketing/UpgradeInterestButton";
import { usePublicBilling } from "@/components/marketing/usePublicBilling";

const annualLabelByLanguage: Partial<Record<Language, { annual: string; save: string; checkout: string }>> = {
  en: { annual: "Annual", save: "Save 20%", checkout: "Checkout is charged in USD." },
  ko: { annual: "연간", save: "20% 할인", checkout: "실제 결제는 USD로 청구됩니다." },
  zh: { annual: "年付", save: "节省 20%", checkout: "实际结账将以 USD 收取。" },
  fr: { annual: "Annuel", save: "-20 %", checkout: "Le paiement est facturé en USD." },
  de: { annual: "Jährlich", save: "20 % sparen", checkout: "Die Zahlung erfolgt in USD." },
  es: { annual: "Anual", save: "20 % de descuento", checkout: "El pago se cobra en USD." },
  pt: { annual: "Anual", save: "20% de desconto", checkout: "O pagamento é cobrado em USD." },
};

type PlanCopy = {
  name: string;
  eyebrow: string;
  price: string;
  period: string;
  description: string;
  cta: string;
  href: string;
  highlighted?: boolean;
  badge?: string;
  usage: string;
  features: string[];
};

type PricingCopy = {
  eyebrow: string;
  title: string;
  description: string;
  billingNote: string;
  compareTitle: string;
  compareDescription: string;
  table: {
    feature: string;
    free: string;
    pro: string;
    max: string;
    rows: Array<{ label: string; free: string; pro: string; max: string }>;
  };
  faqTitle: string;
  faqs: Array<{ question: string; answer: string }>;
  note: string;
  plans: PlanCopy[];
};

const copy: { en: PricingCopy } & Partial<Record<Language, PricingCopy>> = {
  en: {
    eyebrow: "Pricing",
    title: "Choose the right level of AI power.",
    description:
      "Start free, then upgrade when you need more models, higher limits, file workflows, and premium model access.",
    billingNote: "Launch special: 50% off Pro or Max for your first 3 months. Cancel anytime.",
    compareTitle: "Compare what each plan unlocks",
    compareDescription:
      "Tomverse plans are designed around model access, usage allowance, file workflows, and sharing controls.",
    table: {
      feature: "Feature",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "Model access", free: "Free and Pro model tiers", pro: "All models with Pro usage limits", max: "All models with the largest allowance" },
        { label: "Multi-model comparison", free: "Up to 3 models", pro: "Up to 3 models", max: "Up to 3 models" },
        { label: "File attachments", free: "Images, PDFs, Office, Drive", pro: "Images, PDFs, Office, Drive", max: "Higher file and context limits" },
        { label: "Conversation sharing", free: "Share and download", pro: "Share and download", max: "Share, download, priority limits" },
        { label: "Usage allowance", free: "Free daily and monthly limits", pro: "Higher daily and monthly usage", max: "No daily message limit with monthly fair-use protection" },
      ],
    },
    faqTitle: "Pricing questions",
    faqs: [
      {
        question: "Can I keep using Tomverse for free",
        answer: "Yes. The Free plan is intended for light daily use with access to Free and Pro model tiers within usage limits.",
      },
      {
        question: "How does the launch discount work",
        answer: "The launch special gives 50% off Pro or Max for the first 3 months. After that, the plan renews at the regular monthly price unless canceled.",
      },
      {
        question: "Does Pro restrict which models I can choose",
        answer: "Pro is intended to unlock the available model catalogue. Higher-cost models are managed through usage and cost limits rather than a simple model picker block.",
      },
    ],
    note:
      "\uAC00\uACA9\uC740 \uC138\uAE08 \uC804 USD \uAE30\uC900\uC785\uB2C8\uB2E4. Max\uB294 \uC77C\uC77C \uBA54\uC2DC\uC9C0 \uD55C\uB3C4\uB97C \uC5C6\uC560\uC9C0\uB9CC, \uC6D4\uAC04 fair-use, \uB0A8\uC6A9 \uBC29\uC9C0, Provider \uBE44\uC6A9 \uBCF4\uD638 \uD55C\uB3C4\uB294 \uC801\uC6A9\uB429\uB2C8\uB2E4.",
    plans: [
      {
        name: "Free",
        eyebrow: "For starting out",
        price: "$0",
        period: "per month",
        description: "A simple way to try Tomverse and use selected AI models for light daily work.",
        cta: "Start free",
        href: "/chat",
        usage: "Basic daily usage",
        features: [
          "Access to Free and Pro model tiers",
          "Compare up to 3 models",
          "Basic chat history",
          "File attachments, sharing, and downloads after login",
          "Good for light personal use",
        ],
      },
      {
        name: "Pro",
        eyebrow: "For everyday productivity",
        price: "$15",
        period: "per month",
        description: "For people who compare models, attach files, and reuse conversations throughout the week.",
        cta: "Upgrade to Pro",
        href: "/chat",
        highlighted: true,
        badge: "Recommended",
        usage: "Launch special: $7.50/month for first 3 months",
        features: [
          "Access to all available model tiers",
          "Compare up to 3 models side by side",
          "File attachments and Google Drive files",
          "Share and download conversations",
          "Higher daily and monthly limits",
        ],
      },
      {
        name: "Max",
        eyebrow: "For heavier AI workflows",
        price: "$25",
        period: "per month",
        description: "For power users who need premium model tiers, larger allowances, and priority room to work.",
        cta: "Upgrade to Max",
        href: "/chat",
        usage: "Launch special: $12.50/month for first 3 months",
        features: [
          "Access to Free, Pro, and Max model tiers",
          "No daily message limit with monthly fair-use protection",
          "Higher attachment and context limits",
          "Priority access to advanced model tiers",
          "Built for heavier daily AI workflows",
        ],
      },
    ],
  },
  ko: {
    eyebrow: "요금",
    title: "필요한 AI 파워에 맞는 플랜을 선택하세요.",
    description: "무료로 시작하고, 더 많은 모델과 높은 한도, 파일 워크플로, 프리미엄 모델 접근이 필요할 때 업그레이드하세요.",
    billingNote: "?? ??: Pro ?? Max ? 3?? 50% ??. ??? ??? ? ????.",
    compareTitle: "플랜별 제공 기능 비교",
    compareDescription: "Tomverse 플랜은 모델 접근, 사용량, 파일 워크플로, 공유 제어를 기준으로 설계되었습니다.",
    table: {
      feature: "기능",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "모델 접근", free: "Free 및 Pro 모델 등급", pro: "Pro 사용량 한도 내 모든 모델", max: "가장 큰 사용량으로 모든 모델" },
        { label: "다중 모델 비교", free: "최대 3개 모델", pro: "최대 3개 모델", max: "최대 3개 모델" },
        { label: "파일 첨부", free: "이미지, PDF, Office, Drive", pro: "이미지, PDF, Office, Drive", max: "더 높은 파일 및 맥락 한도" },
        { label: "대화 공유", free: "공유 및 다운로드", pro: "공유 및 다운로드", max: "공유, 다운로드, 우선 한도" },
        { label: "사용량", free: "Free 일일/월간 한도", pro: "더 높은 일일/월간 사용량", max: "일일 메시지 무제한 및 월간 fair-use 보호" },
      ],
    },
    faqTitle: "요금 관련 질문",
    faqs: [
      { question: "Tomverse를 무료로 계속 사용할 수 있나요", answer: "네. Free 플랜은 사용량 한도 안에서 Free 및 Pro 모델 등급을 사용할 수 있는 가벼운 일상 사용을 위한 플랜입니다." },
      { question: "출시 할인은 어떻게 적용되나요", answer: "?? ??? Pro ?? Max ? 3?? ?? 50% ??? ?? ? ????. ???? ???? ?? ? ?? ? ???? ?????." },
      { question: "Pro는 선택 가능한 모델을 제한하나요", answer: "Pro는 사용 가능한 모델 카탈로그를 열어두는 방향입니다. 고비용 모델은 단순히 모델 선택을 막기보다 사용량과 비용 한도로 관리합니다." },
    ],
    note: "가격은 세금 전 USD 기준입니다. Max는 일일 메시지 한도를 제거하지만, 월간 fair-use, 남용 방지, 공급자 비용 보호 한도는 적용됩니다.",
    plans: [
      { name: "Free", eyebrow: "처음 시작하는 사용자", price: "$0", period: "월", description: "Tomverse를 체험하고 선택된 AI 모델로 가벼운 일상 작업을 하기 위한 플랜입니다.", cta: "무료로 시작", href: "/chat", usage: "기본 일일 사용량", features: ["Free 및 Pro 모델 등급 접근", "최대 3개 모델 비교", "기본 대화 기록", "로그인 후 파일 첨부, 공유, 다운로드", "가벼운 개인 사용에 적합"] },
      { name: "Pro", eyebrow: "일상 생산성", price: "$15", period: "월", description: "모델을 비교하고, 파일을 첨부하고, 대화를 주중 업무에 재사용하는 사용자에게 적합합니다.", cta: "Pro로 업그레이드", href: "/chat", highlighted: true, badge: "추천", usage: "?? ??: ? 3?? ? $7.50", features: ["모든 사용 가능 모델 등급 접근", "최대 3개 모델 나란히 비교", "파일 첨부 및 Google Drive 파일", "대화 공유 및 다운로드", "더 높은 일일 및 월간 한도"] },
      { name: "Max", eyebrow: "고강도 AI 워크플로", price: "$25", period: "월", description: "프리미엄 모델 등급, 더 큰 사용량, 우선 사용 여유가 필요한 파워 유저를 위한 플랜입니다.", cta: "Max로 업그레이드", href: "/chat", usage: "?? ??: ? 3?? ? $12.50", features: ["Free, Pro, Max 모델 등급 접근", "일일 메시지 무제한 및 월간 fair-use 보호", "더 높은 첨부파일 및 맥락 한도", "고급 모델 등급 우선 접근", "고강도 일상 AI 작업에 적합"] },
    ],
  },
  zh: {
    eyebrow: "价格",
    title: "选择适合你的 AI 能力等级。",
    description: "免费开始，当你需要更多模型、更高额度、文件工作流和高级模型访问时再升级。",
    billingNote: "?????Pro ? Max ? 3 ??? 50% ?????????",
    compareTitle: "比较每个方案解锁的功能",
    compareDescription: "Tomverse 方案围绕模型访问、使用额度、文件工作流和分享控制而设计。",
    table: {
      feature: "功能",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "模型访问", free: "Free 和 Pro 模型等级", pro: "在 Pro 使用限制内访问所有模型", max: "以最大额度访问所有模型" },
        { label: "多模型比较", free: "最多 3 个模型", pro: "最多 3 个模型", max: "最多 3 个模型" },
        { label: "文件附件", free: "图片、PDF、Office、Drive", pro: "图片、PDF、Office、Drive", max: "更高的文件和上下文限制" },
        { label: "对话分享", free: "分享和下载", pro: "分享和下载", max: "分享、下载和优先额度" },
        { label: "使用额度", free: "Free 每日和每月限制", pro: "更高的每日和每月用量", max: "每日消息无限制，并有月度 fair-use 保护" },
      ],
    },
    faqTitle: "价格问题",
    faqs: [
      { question: "可以继续免费使用 Tomverse 吗？", answer: "可以。Free 适合轻量日常使用，可在使用限制内访问 Free 和 Pro 模型等级。" },
      { question: "发布折扣如何使用？", answer: "?????? Pro ? Max ? 3 ???? 50% ?????????????????????" },
      { question: "Pro 会限制我能选择的模型吗？", answer: "Pro 的目标是开放可用模型目录。成本更高的模型会通过使用量和成本限制来管理，而不是简单地在模型选择器中锁定。" },
    ],
    note: "价格为税前 USD。Max 取消每日消息限制，但仍适用月度 fair-use、防滥用和提供商成本保护限制。",
    plans: [
      { name: "Free", eyebrow: "适合开始使用", price: "$0", period: "每月", description: "用于体验 Tomverse，并使用部分 AI 模型完成轻量日常工作。", cta: "免费开始", href: "/chat", usage: "基础每日用量", features: ["访问 Free 和 Pro 模型等级", "最多比较 3 个模型", "基础聊天记录", "登录后可使用文件附件、分享和下载", "适合轻量个人使用"] },
      { name: "Pro", eyebrow: "日常生产力", price: "$15", period: "每月", description: "适合经常比较模型、添加文件并在一周内重复使用对话的用户。", cta: "升级到 Pro", href: "/chat", highlighted: true, badge: "推荐", usage: "?????? 3 ???? $7.50", features: ["访问所有可用模型等级", "最多并排比较 3 个模型", "文件附件和 Google Drive 文件", "分享和下载对话", "更高的每日和每月限制"] },
      { name: "Max", eyebrow: "高强度 AI 工作流", price: "$25", period: "每月", description: "适合需要高级模型、更大额度和优先使用空间的高频用户。", cta: "升级到 Max", href: "/chat", usage: "?????? 3 ???? $12.50", features: ["访问 Free、Pro 和 Max 模型等级", "每日消息无限制，并有月度 fair-use 保护", "更高的附件和上下文限制", "优先访问高级模型等级", "为高强度日常 AI 工作流设计"] },
    ],
  },
  fr: {
    eyebrow: "Tarifs",
    title: "Choisissez le niveau de puissance IA qui vous convient.",
    description: "Commencez gratuitement, puis passez à un plan supérieur lorsque vous avez besoin de plus de volume, de workflows avec fichiers et d'accès aux modèles avancés.",
    billingNote: "Offre de lancement : -50 % sur Pro ou Max pendant vos 3 premiers mois. Annulation possible ? tout moment.",
    compareTitle: "Comparez ce que chaque plan débloque",
    compareDescription: "Les plans Tomverse sont conçus autour de l'accès aux modèles, des quotas d'utilisation, des workflows avec fichiers et des options de partage.",
    table: {
      feature: "Fonctionnalité",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "Accès aux modèles", free: "Niveaux de modèles Free et Pro", pro: "Tous les modèles avec les limites Pro", max: "Tous les modèles avec l'enveloppe la plus élevée" },
        { label: "Comparaison multi-modèles", free: "Jusqu'à 3 modèles", pro: "Jusqu'à 3 modèles", max: "Jusqu'à 3 modèles" },
        { label: "Pièces jointes", free: "Images, PDF, Office, Drive", pro: "Images, PDF, Office, Drive", max: "Limites de fichiers et de contexte plus élevées" },
        { label: "Partage de conversations", free: "Partage et téléchargement", pro: "Partage et téléchargement", max: "Partage, téléchargement et limites prioritaires" },
        { label: "Quota d'utilisation", free: "Limites Free quotidiennes et mensuelles", pro: "Usage quotidien et mensuel plus élevé", max: "Aucune limite quotidienne de messages avec protection mensuelle fair-use" },
      ],
    },
    faqTitle: "Questions sur les tarifs",
    faqs: [
      { question: "Puis-je continuer à utiliser Tomverse gratuitement ?", answer: "Oui. Le plan Free est prévu pour un usage quotidien léger, avec accès aux niveaux de modèles Free et Pro dans les limites d'utilisation." },
      { question: "Comment fonctionne la réduction de lancement ?", answer: "L'offre de lancement applique -50 % sur Pro ou Max pendant les 3 premiers mois. Ensuite, le plan se renouvelle au prix mensuel standard, sauf annulation." },
      { question: "Pro limite-t-il les modèles que je peux choisir ?", answer: "Pro vise à ouvrir le catalogue de modèles disponible. Les modèles plus coûteux sont gérés par des limites d'usage et de coût plutôt que par un simple blocage dans le sélecteur." },
    ],
    note: "Les prix sont indiqués en USD hors taxes. Max supprime la limite quotidienne de messages, mais les protections mensuelles fair-use, anti-abus et de maîtrise des coûts fournisseur restent applicables.",
    plans: [
      { name: "Free", eyebrow: "Pour commencer", price: "$0", period: "par mois", description: "Une façon simple d'essayer Tomverse et d'utiliser certains modèles IA pour un travail quotidien léger.", cta: "Commencer gratuitement", href: "/chat", usage: "Usage quotidien de base", features: ["Accès aux niveaux de modèles Free et Pro", "Comparer jusqu'à 3 modèles", "Historique de conversation de base", "Pièces jointes, partage et téléchargements après connexion", "Adapté à un usage personnel léger"] },
      { name: "Pro", eyebrow: "Productivité quotidienne", price: "$15", period: "par mois", description: "Pour les personnes qui comparent des modèles, joignent des fichiers et réutilisent leurs conversations chaque semaine.", cta: "Passer à Pro", href: "/chat", highlighted: true, badge: "Recommandé", usage: "Offre de lancement : 7,50 $/mois pendant 3 mois", features: ["Accès à tous les niveaux de modèles disponibles", "Comparer jusqu'à 3 modèles côte à côte", "Pièces jointes et fichiers Google Drive", "Partager et télécharger les conversations", "Limites quotidiennes et mensuelles plus élevées"] },
      { name: "Max", eyebrow: "Workflows IA intensifs", price: "$25", period: "par mois", description: "Pour les utilisateurs intensifs qui ont besoin de modèles avancés, de volumes plus importants et d'une marge prioritaire.", cta: "Passer à Max", href: "/chat", usage: "Offre de lancement : 12,50 $/mois pendant 3 mois", features: ["Accès aux niveaux Free, Pro et Max", "Aucune limite quotidienne de messages avec protection mensuelle fair-use", "Limites de pièces jointes et de contexte plus élevées", "Accès prioritaire aux modèles avancés", "Conçu pour les workflows IA quotidiens intensifs"] },
    ],
  },
  de: {
    eyebrow: "Preise",
    title: "Wählen Sie die passende KI-Leistung.",
    description: "Starten Sie kostenlos und upgraden Sie, wenn Sie mehr Nutzung, Datei-Workflows und Zugriff auf Premium-Modelle benötigen.",
    billingNote: "Launch-Angebot: 50 % Rabatt auf Pro oder Max in den ersten 3 Monaten. Jederzeit k?ndbar.",
    compareTitle: "Vergleichen Sie, was jeder Plan freischaltet",
    compareDescription: "Tomverse-Pläne sind rund um Modellzugriff, Nutzungskontingente, Datei-Workflows und Freigabefunktionen aufgebaut.",
    table: {
      feature: "Funktion",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "Modellzugriff", free: "Free- und Pro-Modellstufen", pro: "Alle Modelle mit Pro-Limits", max: "Alle Modelle mit dem größten Kontingent" },
        { label: "Multi-Modell-Vergleich", free: "Bis zu 3 Modelle", pro: "Bis zu 3 Modelle", max: "Bis zu 3 Modelle" },
        { label: "Dateianhänge", free: "Bilder, PDFs, Office, Drive", pro: "Bilder, PDFs, Office, Drive", max: "Höhere Datei- und Kontextlimits" },
        { label: "Unterhaltungen teilen", free: "Teilen und herunterladen", pro: "Teilen und herunterladen", max: "Teilen, herunterladen und priorisierte Limits" },
        { label: "Nutzungskontingent", free: "Tägliche und monatliche Free-Limits", pro: "Höhere tägliche und monatliche Nutzung", max: "Kein tägliches Nachrichtenlimit mit monatlichem Fair-Use-Schutz" },
      ],
    },
    faqTitle: "Fragen zu Preisen",
    faqs: [
      { question: "Kann ich Tomverse weiterhin kostenlos nutzen?", answer: "Ja. Free ist für leichte tägliche Nutzung gedacht und bietet innerhalb der Nutzungslimits Zugriff auf Free- und Pro-Modellstufen." },
      { question: "Wie funktioniert der Launch-Rabatt?", answer: "Das Launch-Angebot gew?hrt in den ersten 3 Monaten 50 % Rabatt auf Pro oder Max. Danach verl?ngert sich der Plan zum regul?ren Monatspreis, sofern er nicht gek?ndigt wird." },
      { question: "Beschränkt Pro die auswählbaren Modelle?", answer: "Pro soll den verfügbaren Modellkatalog öffnen. Kostenintensivere Modelle werden über Nutzungs- und Kostenlimits gesteuert, nicht über eine einfache Sperre im Modellwähler." },
    ],
    note: "Preise verstehen sich in USD vor Steuern. Max entfernt das tägliche Nachrichtenlimit, aber monatlicher Fair-Use-, Missbrauchs- und Provider-Kostenschutz gelten weiterhin.",
    plans: [
      { name: "Free", eyebrow: "Für den Einstieg", price: "$0", period: "pro Monat", description: "Ein einfacher Weg, Tomverse auszuprobieren und ausgewählte KI-Modelle für leichte tägliche Arbeit zu nutzen.", cta: "Kostenlos starten", href: "/chat", usage: "Grundlegende tägliche Nutzung", features: ["Zugriff auf Free- und Pro-Modellstufen", "Bis zu 3 Modelle vergleichen", "Grundlegender Chatverlauf", "Dateianhänge, Teilen und Downloads nach Anmeldung", "Gut für leichte persönliche Nutzung"] },
      { name: "Pro", eyebrow: "Tägliche Produktivität", price: "$15", period: "pro Monat", description: "Für Nutzer, die Modelle vergleichen, Dateien anhängen und Unterhaltungen regelmäßig wiederverwenden.", cta: "Auf Pro upgraden", href: "/chat", highlighted: true, badge: "Empfohlen", usage: "Launch-Angebot: 7,50 $/Monat f?r 3 Monate", features: ["Zugriff auf alle verfügbaren Modellstufen", "Bis zu 3 Modelle nebeneinander vergleichen", "Dateianhänge und Google-Drive-Dateien", "Unterhaltungen teilen und herunterladen", "Höhere tägliche und monatliche Limits"] },
      { name: "Max", eyebrow: "Intensive KI-Workflows", price: "$25", period: "pro Monat", description: "Für Power-User, die Premium-Modelle, größere Kontingente und priorisierten Spielraum benötigen.", cta: "Auf Max upgraden", href: "/chat", usage: "Launch-Angebot: 12,50 $/Monat f?r 3 Monate", features: ["Zugriff auf Free-, Pro- und Max-Modellstufen", "Kein tägliches Nachrichtenlimit mit monatlichem Fair-Use-Schutz", "Höhere Anhang- und Kontextlimits", "Priorisierter Zugriff auf fortgeschrittene Modelle", "Für intensive tägliche KI-Workflows entwickelt"] },
    ],
  },
  es: {
    eyebrow: "Precios",
    title: "Elige el nivel adecuado de potencia de IA.",
    description: "Empieza gratis y actualiza cuando necesites más uso, flujos con archivos y acceso a modelos premium.",
    billingNote: "Oferta de lanzamiento: 50 % de descuento en Pro o Max durante tus primeros 3 meses. Cancela cuando quieras.",
    compareTitle: "Compara lo que desbloquea cada plan",
    compareDescription: "Los planes de Tomverse se diseñan alrededor del acceso a modelos, límites de uso, archivos y controles para compartir.",
    table: {
      feature: "Función",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "Acceso a modelos", free: "Niveles Free y Pro", pro: "Todos los modelos con límites Pro", max: "Todos los modelos con la mayor asignación" },
        { label: "Comparación multi-modelo", free: "Hasta 3 modelos", pro: "Hasta 3 modelos", max: "Hasta 3 modelos" },
        { label: "Archivos adjuntos", free: "Imágenes, PDF, Office, Drive", pro: "Imágenes, PDF, Office, Drive", max: "Límites superiores de archivos y contexto" },
        { label: "Compartir conversaciones", free: "Compartir y descargar", pro: "Compartir y descargar", max: "Compartir, descargar y límites prioritarios" },
        { label: "Uso permitido", free: "Límites diarios y mensuales Free", pro: "Mayor uso diario y mensual", max: "Sin límite diario de mensajes con protección mensual fair-use" },
      ],
    },
    faqTitle: "Preguntas sobre precios",
    faqs: [
      { question: "¿Puedo seguir usando Tomverse gratis?", answer: "Sí. Free está pensado para uso diario ligero con acceso a niveles de modelos Free y Pro dentro de los límites de uso." },
      { question: "¿Cómo funciona el descuento de lanzamiento?", answer: "La oferta de lanzamiento aplica un 50 % de descuento en Pro o Max durante los primeros 3 meses. Despu?s, el plan se renueva al precio mensual regular salvo cancelaci?n." },
      { question: "¿Pro limita los modelos que puedo elegir?", answer: "Pro está pensado para abrir el catálogo de modelos disponible. Los modelos de mayor coste se gestionan con límites de uso y coste, no con un bloqueo simple del selector." },
    ],
    note: "Los precios están en USD antes de impuestos. Max elimina el límite diario de mensajes, pero siguen aplicando protecciones mensuales fair-use, antiabuso y de coste del proveedor.",
    plans: [
      { name: "Free", eyebrow: "Para empezar", price: "$0", period: "al mes", description: "Una forma sencilla de probar Tomverse y usar modelos de IA seleccionados para trabajo diario ligero.", cta: "Empezar gratis", href: "/chat", usage: "Uso diario básico", features: ["Acceso a niveles de modelos Free y Pro", "Comparar hasta 3 modelos", "Historial básico de chat", "Archivos, compartir y descargas tras iniciar sesión", "Adecuado para uso personal ligero"] },
      { name: "Pro", eyebrow: "Productividad diaria", price: "$15", period: "al mes", description: "Para quienes comparan modelos, adjuntan archivos y reutilizan conversaciones durante la semana.", cta: "Actualizar a Pro", href: "/chat", highlighted: true, badge: "Recomendado", usage: "Oferta de lanzamiento: $7.50/mes durante 3 meses", features: ["Acceso a todos los niveles de modelos disponibles", "Comparar hasta 3 modelos lado a lado", "Archivos adjuntos y Google Drive", "Compartir y descargar conversaciones", "Límites diarios y mensuales superiores"] },
      { name: "Max", eyebrow: "Flujos intensivos de IA", price: "$25", period: "al mes", description: "Para usuarios avanzados que necesitan modelos premium, mayores asignaciones y margen prioritario.", cta: "Actualizar a Max", href: "/chat", usage: "Oferta de lanzamiento: $12.50/mes durante 3 meses", features: ["Acceso a niveles Free, Pro y Max", "Sin límite diario de mensajes con protección mensual fair-use", "Límites superiores de adjuntos y contexto", "Acceso prioritario a modelos avanzados", "Diseñado para flujos diarios intensivos de IA"] },
    ],
  },
  pt: {
    eyebrow: "Preços",
    title: "Escolha o nível certo de potência de IA.",
    description: "Comece grátis e faça upgrade quando precisar de mais uso, workflows com arquivos e acesso a modelos premium.",
    billingNote: "Oferta de lan?amento: 50% de desconto no Pro ou Max nos 3 primeiros meses. Cancele quando quiser.",
    compareTitle: "Compare o que cada plano libera",
    compareDescription: "Os planos Tomverse são pensados em torno de acesso a modelos, limites de uso, arquivos e compartilhamento.",
    table: {
      feature: "Recurso",
      free: "Free",
      pro: "Pro",
      max: "Max",
      rows: [
        { label: "Acesso a modelos", free: "Níveis Free e Pro", pro: "Todos os modelos com limites Pro", max: "Todos os modelos com a maior franquia" },
        { label: "Comparação multi-modelo", free: "Até 3 modelos", pro: "Até 3 modelos", max: "Até 3 modelos" },
        { label: "Anexos", free: "Imagens, PDFs, Office, Drive", pro: "Imagens, PDFs, Office, Drive", max: "Limites maiores de arquivos e contexto" },
        { label: "Compartilhar conversas", free: "Compartilhar e baixar", pro: "Compartilhar e baixar", max: "Compartilhar, baixar e limites prioritários" },
        { label: "Limite de uso", free: "Limites diários e mensais Free", pro: "Uso diário e mensal maior", max: "Sem limite diário de mensagens com proteção mensal fair-use" },
      ],
    },
    faqTitle: "Perguntas sobre preços",
    faqs: [
      { question: "Posso continuar usando o Tomverse de graça?", answer: "Sim. O Free é pensado para uso diário leve, com acesso aos níveis de modelos Free e Pro dentro dos limites de uso." },
      { question: "Como funciona o desconto de lançamento?", answer: "A oferta de lan?amento aplica 50% de desconto no Pro ou Max nos 3 primeiros meses. Depois disso, o plano renova pelo pre?o mensal regular, salvo cancelamento." },
      { question: "O Pro limita quais modelos posso escolher?", answer: "O Pro foi pensado para liberar o catálogo de modelos disponível. Modelos de custo maior são gerenciados por limites de uso e custo, não por um bloqueio simples no seletor." },
    ],
    note: "Os preços são em USD antes de impostos. O Max remove o limite diário de mensagens, mas proteções mensais fair-use, antiabuso e de custo do provedor continuam aplicáveis.",
    plans: [
      { name: "Free", eyebrow: "Para começar", price: "$0", period: "por mês", description: "Uma forma simples de testar o Tomverse e usar modelos de IA selecionados para trabalho diário leve.", cta: "Começar grátis", href: "/chat", usage: "Uso diário básico", features: ["Acesso aos níveis de modelos Free e Pro", "Comparar até 3 modelos", "Histórico básico de chat", "Anexos, compartilhamento e downloads após login", "Bom para uso pessoal leve"] },
      { name: "Pro", eyebrow: "Produtividade diária", price: "$15", period: "por mês", description: "Para pessoas que comparam modelos, anexam arquivos e reutilizam conversas durante a semana.", cta: "Atualizar para Pro", href: "/chat", highlighted: true, badge: "Recomendado", usage: "Oferta de lan?amento: US$7.50/m?s por 3 meses", features: ["Acesso a todos os níveis de modelos disponíveis", "Comparar até 3 modelos lado a lado", "Anexos e arquivos do Google Drive", "Compartilhar e baixar conversas", "Limites diários e mensais maiores"] },
      { name: "Max", eyebrow: "Fluxos intensivos de IA", price: "$25", period: "por mês", description: "Para usuários avançados que precisam de modelos premium, franquias maiores e prioridade de uso.", cta: "Atualizar para Max", href: "/chat", usage: "Oferta de lan?amento: US$12.50/m?s por 3 meses", features: ["Acesso aos níveis Free, Pro e Max", "Sem limite diário de mensagens com proteção mensal fair-use", "Limites maiores de anexos e contexto", "Acesso prioritário a modelos avançados", "Feito para fluxos diários intensivos de IA"] },
    ],
  },
};

export function PricingPageContent() {
  const { lang, t } = useLanguage();
  const content = copy[lang] ?? copy.en;
  const billing = usePublicBilling();
  const annualCopy = annualLabelByLanguage[lang] ?? annualLabelByLanguage.en!;

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader />

      <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-4xl text-center">
          <p className="text-sm font-black uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{content.eyebrow}</p>
          <h1 className="mt-4 text-4xl font-black leading-tight sm:text-6xl">{content.title}</h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">{content.description}</p>
          <p className="mt-5 rounded-full bg-zinc-100 px-4 py-2 text-sm font-bold text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
            {content.billingNote}
          </p>
        </div>

        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {content.plans.map((plan) => {
            const planId = plan.name === "Max" ? "max" : plan.name === "Pro" ? "pro" : "free";
            const displayPrice = billing.formatPlanPrice(planId) || plan.price;
            const usdPrice = billing.formatUsdPlanPrice(planId) || plan.price;
            const annualFallback = planId === "max" ? "$240" : planId === "pro" ? "$144" : "$0";
            const annualPrice = billing.formatPlanPrice(planId, "annual") || annualFallback;
            const annualUsdPrice = billing.formatUsdPlanPrice(planId, "annual") || annualFallback;
            return (
            <article
              key={plan.name}
              className={`relative flex min-h-full flex-col rounded-[1.75rem] border p-6 shadow-sm ${
                plan.highlighted ? "border-blue-500 bg-blue-600 text-white shadow-2xl shadow-blue-950/20"
                  : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40"
              }`}
            >
              <div className="flex min-h-8 items-start justify-between gap-3">
                <p className={`text-xs font-black uppercase tracking-[0.18em] ${plan.highlighted ? "text-blue-100" : "text-blue-600 dark:text-blue-400"}`}>
                  {plan.eyebrow}
                </p>
                {plan.badge && (
                  <span className="shrink-0 rounded-full bg-white/15 px-3 py-1 text-xs font-black text-white ring-1 ring-white/20">
                    {plan.badge}
                  </span>
                )}
              </div>
              <h2 className="mt-4 text-3xl font-black">{plan.name}</h2>
              <p className={`mt-3 min-h-14 text-sm leading-6 ${plan.highlighted ? "text-blue-50" : "text-zinc-600 dark:text-zinc-300"}`}>
                {plan.description}
              </p>
              <div className="mt-8">
                <span className="text-4xl font-black">{displayPrice}</span>
                <span className={`ml-2 text-sm font-bold ${plan.highlighted ? "text-blue-100" : "text-zinc-500 dark:text-zinc-400"}`}>
                  {plan.period}
                </span>
              </div>
              {planId !== "free" ? (
                <div className={`mt-3 rounded-2xl border p-3 text-xs font-bold leading-5 ${
                  plan.highlighted
                    ? "border-white/20 bg-white/10 text-blue-50"
                    : "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-300"
                }`}>
                  <div className="flex items-center justify-between gap-3">
                    <span>{annualCopy.annual}</span>
                    <span className={`rounded-full px-2.5 py-1 ${plan.highlighted ? "bg-white text-blue-700" : "bg-emerald-500/10 text-emerald-500"}`}>
                      {annualCopy.save}
                    </span>
                  </div>
                  <div className="mt-1 text-lg font-black">{annualPrice}</div>
                  <p className={plan.highlighted ? "text-blue-100" : "text-zinc-500 dark:text-zinc-400"}>
                    {annualUsdPrice} / {annualCopy.annual}. {annualCopy.checkout}
                  </p>
                </div>
              ) : null}
              <p className={`mt-3 text-sm font-black ${plan.highlighted ? "text-blue-50" : "text-zinc-700 dark:text-zinc-200"}`}>
                {plan.usage}
              </p>
              {planId === "free" ? (
                <Link
                  href={plan.href}
                  className={`mt-8 inline-flex h-12 w-full items-center justify-center rounded-xl text-sm font-black transition ${
                    plan.highlighted ? "bg-white text-blue-700 hover:bg-blue-50"
                      : "border border-zinc-300 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  {plan.cta}
                </Link>
              ) : (
                <UpgradeInterestButton
                  plan={plan.name === "Max" ? "Max" : "Pro"}
                  className={`mt-8 inline-flex h-12 w-full items-center justify-center rounded-xl text-sm font-black transition ${
                    plan.highlighted ? "bg-white text-blue-700 hover:bg-blue-50"
                      : "border border-zinc-300 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800"
                  }`}
                >
                  {plan.cta}
                </UpgradeInterestButton>
              )}
              <ul className="mt-8 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className={`flex gap-3 text-sm font-semibold leading-6 ${plan.highlighted ? "text-white" : "text-zinc-700 dark:text-zinc-300"}`}>
                    <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${plan.highlighted ? "text-white" : "text-blue-600 dark:text-blue-400"}`} />
                    {feature}
                  </li>
                ))}
              </ul>
            </article>
            );
          })}
        </div>

        <section className="mt-16 rounded-[2rem] border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/40 sm:p-6">
          <div className="max-w-3xl">
            <h2 className="text-3xl font-black">{content.compareTitle}</h2>
            <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-300">{content.compareDescription}</p>
          </div>
          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left text-sm">
              <thead>
                <tr>
                  {[content.table.feature, content.table.free, content.table.pro, content.table.max].map((heading) => (
                    <th key={heading} className="border-b border-zinc-200 px-4 py-3 font-black text-zinc-900 dark:border-zinc-800 dark:text-white">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {content.table.rows.map((row) => (
                  <tr key={row.label}>
                    <td className="border-b border-zinc-200 px-4 py-4 font-black dark:border-zinc-800">{row.label}</td>
                    {[row.free, row.pro, row.max].map((value, index) => (
                      <td key={`${row.label}-${index}`} className="border-b border-zinc-200 px-4 py-4 font-semibold text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
                        {value === "-" ? <Minus className="h-4 w-4 text-zinc-400" /> : value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-16 grid gap-5 lg:grid-cols-[0.7fr_1.3fr]">
          <h2 className="text-3xl font-black">{content.faqTitle}</h2>
          <div className="grid gap-4">
            {content.faqs.map((faq) => (
              <article key={faq.question} className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/40">
                <h3 className="font-black">{faq.question}</h3>
                <p className="mt-2 text-sm leading-7 text-zinc-600 dark:text-zinc-300">{faq.answer}</p>
              </article>
            ))}
          </div>
        </section>

        <div className="mt-10 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 text-sm leading-7 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300">
          {content.note}
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
