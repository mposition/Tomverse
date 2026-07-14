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

const saleLabelByLanguage: Partial<Record<Language, { badge: string; intro: string; regular: string; duration: string }>> = {
  en: { badge: "Launch special", intro: "50% off now", regular: "Regular", duration: "for the first month" },
  ko: { badge: "출시 특가", intro: "지금 50% 할인", regular: "정가", duration: "첫 달 적용" },
  zh: { badge: "发布特价", intro: "现在 50% 折扣", regular: "原价", duration: "首月适用" },
  fr: { badge: "Offre de lancement", intro: "-50 % maintenant", regular: "Prix normal", duration: "le premier mois" },
  de: { badge: "Launch-Angebot", intro: "Jetzt 50 % Rabatt", regular: "Regulär", duration: "im ersten Monat" },
  es: { badge: "Oferta de lanzamiento", intro: "50 % de descuento", regular: "Precio regular", duration: "durante el primer mes" },
  pt: { badge: "Oferta de lançamento", intro: "50% de desconto agora", regular: "Preço regular", duration: "no primeiro mês" },
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
  creditNotice: string;
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
    billingNote: "Launch special: 50% off Pro or Max for your first month. Cancel anytime.",
    creditNotice:
      "Credit usage varies by each model's processing cost and reasoning method. You can review the estimated usage before sending a request.",
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
        { label: "AI credits", free: "300/month", pro: "3,000/month", max: "10,000/month" },
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
        answer: "The launch special gives 50% off Pro or Max for the first month. After that, the plan renews at the regular monthly price unless canceled.",
      },
      {
        question: "Does Pro restrict which models I can choose",
        answer: "Pro is intended to unlock the available model catalogue. Higher-cost models are managed through usage and cost limits rather than a simple model picker block.",
      },
    ],
    note:
      "Prices are shown in USD before tax. On Max, Standard models have no daily limit; Premium usage is subject to monthly credits and the Fair Use Policy.",
    plans: [
      {
        name: "Free",
        eyebrow: "For starting out",
        price: "$0",
        period: "per month",
        description: "300 monthly AI credits for light everyday use and trying advanced models.",
        cta: "Start free",
        href: "/chat",
        usage: "300 monthly AI credits",
        features: [
          "Access to Free and Pro model tiers",
          "Up to 30 Pro-model responses per month",
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
        description: "3,000 monthly AI credits for everyday multi-model comparisons.",
        cta: "Upgrade to Pro",
        href: "/chat",
        highlighted: true,
        badge: "Recommended",
        usage: "3,000 monthly AI credits",
        features: [
          "Access to all available model tiers",
          "Compare up to 3 models side by side",
          "File attachments and Google Drive files",
          "Share and download conversations",
          "Monthly credits apply to weighted model usage",
        ],
      },
      {
        name: "Max",
        eyebrow: "For heavier AI workflows",
        price: "$25",
        period: "per month",
        description: "10,000 monthly AI credits for intensive advanced-model and long-document work.",
        cta: "Upgrade to Max",
        href: "/chat",
        usage: "10,000 monthly AI credits",
        features: [
          "Access to Free, Pro, and Max model tiers",
          "No daily limit on Standard models",
          "Premium usage follows monthly credits and Fair Use",
          "Higher attachment and context limits",
          "Priority access to advanced model tiers",
        ],
      },
    ],
  },
  ko: {
    eyebrow: "요금",
    title: "필요한 AI 파워에 맞는 플랜을 선택하세요.",
    description: "무료로 시작하고, 더 많은 모델과 높은 한도, 파일 워크플로, 프리미엄 모델 접근이 필요할 때 업그레이드하세요.",
    billingNote: "출시 특가: Pro 또는 Max 첫 달 50% 할인. 언제든 취소할 수 있습니다.",
    creditNotice: "모델별 처리 비용과 추론 방식에 따라 크레딧 사용량이 다릅니다. 요청을 보내기 전에 예상 사용량을 확인할 수 있습니다.",
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
        { label: "AI 크레딧", free: "월 300", pro: "월 3,000", max: "월 10,000" },
      ],
    },
    faqTitle: "요금 관련 질문",
    faqs: [
      { question: "Tomverse를 무료로 계속 사용할 수 있나요", answer: "네. Free 플랜은 사용량 한도 안에서 Free 및 Pro 모델 등급을 사용할 수 있는 가벼운 일상 사용을 위한 플랜입니다." },
      { question: "출시 할인은 어떻게 적용되나요", answer: "출시 특가로 Pro 또는 Max 첫 달 동안 50% 할인을 받을 수 있습니다. 이후에는 취소하지 않는 한 정가 월 요금으로 갱신됩니다." },
      { question: "Pro는 선택 가능한 모델을 제한하나요", answer: "Pro는 사용 가능한 모델 카탈로그를 열어두는 방향입니다. 고비용 모델은 단순히 모델 선택을 막기보다 사용량과 비용 한도로 관리합니다." },
    ],
    note: "가격은 세금 전 USD 기준입니다. Max는 Standard 모델 일일 제한 없음, Premium 사용량은 월 크레딧 및 공정사용 정책이 적용됩니다.",
    plans: [
      { name: "Free", eyebrow: "처음 시작하는 사용자", price: "$0", period: "월", description: "가벼운 일상 사용과 고급 모델 체험을 위한 월 300 AI 크레딧", cta: "무료로 시작", href: "/chat", usage: "월 300 AI 크레딧", features: ["Free 및 Pro 모델 등급 접근", "Pro 모델 월 30응답까지", "최대 3개 모델 비교", "로그인 후 파일 첨부, 공유, 다운로드", "가벼운 개인 사용에 적합"] },
      { name: "Pro", eyebrow: "일상 생산성", price: "$15", period: "월", description: "일상적인 멀티모델 비교를 위한 월 3,000 AI 크레딧", cta: "Pro로 업그레이드", href: "/chat", highlighted: true, badge: "추천", usage: "월 3,000 AI 크레딧", features: ["모든 사용 가능 모델 등급 접근", "모델별 가중치에 따라 월 크레딧 사용", "최대 3개 모델 나란히 비교", "파일 첨부 및 Google Drive 파일", "공유 및 다운로드"] },
      { name: "Max", eyebrow: "고강도 AI 워크플로", price: "$25", period: "월", description: "집중적인 고급 모델·긴 문서 작업을 위한 월 10,000 AI 크레딧", cta: "Max로 업그레이드", href: "/chat", usage: "월 10,000 AI 크레딧", features: ["Free, Pro, Max 모델 등급 접근", "Standard 모델 일일 제한 없음", "Premium 사용량은 월 크레딧 및 공정사용 정책 적용", "더 높은 첨부파일 및 맥락 한도", "고급 모델·긴 문서 작업에 적합"] },
    ],
  },
  zh: {
    eyebrow: "价格",
    title: "选择适合你的 AI 能力等级。",
    description: "免费开始，当你需要更多模型、更高额度、文件工作流和高级模型访问时再升级。",
    billingNote: "发布特价：Pro 或 Max 首月享 50% 折扣。可随时取消。",
    creditNotice: "积分用量会因模型处理成本和推理方式而异。发送请求前可查看预计用量。",
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
        { label: "AI 积分", free: "每月 300", pro: "每月 3,000", max: "每月 10,000" },
      ],
    },
    faqTitle: "价格问题",
    faqs: [
      { question: "可以继续免费使用 Tomverse 吗？", answer: "可以。Free 适合轻量日常使用，可在使用限制内访问 Free 和 Pro 模型等级。" },
      { question: "发布折扣如何使用？", answer: "发布特价可让 Pro 或 Max 首月享受 50% 折扣。之后除非取消，否则会按标准月费续订。" },
      { question: "Pro 会限制我能选择的模型吗？", answer: "Pro 的目标是开放可用模型目录。成本更高的模型会通过使用量和成本限制来管理，而不是简单地在模型选择器中锁定。" },
    ],
    note: "价格为税前 USD。Max 的 Standard 模型无每日限制；Premium 用量受月度积分和公平使用政策约束。",
    plans: [
      { name: "Free", eyebrow: "适合开始使用", price: "$0", period: "每月", description: "每月 300 AI 积分，适合轻量日常使用和体验高级模型。", cta: "免费开始", href: "/chat", usage: "每月 300 AI 积分", features: ["访问 Free 和 Pro 模型等级", "最多比较 3 个模型", "基础聊天记录", "登录后可使用文件附件、分享和下载", "适合轻量个人使用"] },
      { name: "Pro", eyebrow: "日常生产力", price: "$15", period: "每月", description: "每月 3,000 AI 积分，适合日常多模型比较。", cta: "升级到 Pro", href: "/chat", highlighted: true, badge: "推荐", usage: "每月 3,000 AI 积分", features: ["访问所有可用模型等级", "最多并排比较 3 个模型", "文件附件和 Google Drive 文件", "分享和下载对话", "按模型加权使用月度积分"] },
      { name: "Max", eyebrow: "高强度 AI 工作流", price: "$25", period: "每月", description: "每月 10,000 AI 积分，适合高强度高级模型和长文档工作。", cta: "升级到 Max", href: "/chat", usage: "每月 10,000 AI 积分", features: ["访问 Free、Pro 和 Max 模型等级", "Standard 模型无每日限制", "Premium 用量适用月度积分和公平使用政策", "更高的附件和上下文限制", "适合高级模型和长文档工作"] },
    ],
  },
  fr: {
    eyebrow: "Tarifs",
    title: "Choisissez le niveau de puissance IA qui vous convient.",
    description: "Commencez gratuitement, puis passez à un plan supérieur lorsque vous avez besoin de plus de volume, de workflows avec fichiers et d'accès aux modèles avancés.",
    billingNote: "Offre de lancement : -50 % sur Pro ou Max le premier mois. Annulation possible a tout moment.",
    creditNotice: "La consommation de crédits varie selon le coût de traitement et le mode de raisonnement du modèle. Vous pouvez consulter l'estimation avant d'envoyer une demande.",
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
        { label: "Crédits IA", free: "300/mois", pro: "3 000/mois", max: "10 000/mois" },
      ],
    },
    faqTitle: "Questions sur les tarifs",
    faqs: [
      { question: "Puis-je continuer à utiliser Tomverse gratuitement ?", answer: "Oui. Le plan Free est prévu pour un usage quotidien léger, avec accès aux niveaux de modèles Free et Pro dans les limites d'utilisation." },
      { question: "Comment fonctionne la réduction de lancement ?", answer: "L'offre de lancement applique -50 % sur Pro ou Max le premier mois. Ensuite, le plan se renouvelle au prix mensuel standard, sauf annulation." },
      { question: "Pro limite-t-il les modèles que je peux choisir ?", answer: "Pro vise à ouvrir le catalogue de modèles disponible. Les modèles plus coûteux sont gérés par des limites d'usage et de coût plutôt que par un simple blocage dans le sélecteur." },
    ],
    note: "Les prix sont indiqués en USD hors taxes. Avec Max, les modèles Standard n'ont pas de limite quotidienne ; l'usage Premium reste soumis aux crédits mensuels et à la politique d'utilisation équitable.",
    plans: [
      { name: "Free", eyebrow: "Pour commencer", price: "$0", period: "par mois", description: "300 crédits IA mensuels pour un usage quotidien léger et l'essai de modèles avancés.", cta: "Commencer gratuitement", href: "/chat", usage: "300 crédits IA par mois", features: ["Accès aux niveaux de modèles Free et Pro", "Comparer jusqu'à 3 modèles", "Historique de conversation de base", "Pièces jointes, partage et téléchargements après connexion", "Adapté à un usage personnel léger"] },
      { name: "Pro", eyebrow: "Productivité quotidienne", price: "$15", period: "par mois", description: "3 000 crédits IA mensuels pour les comparaisons multi-modèles quotidiennes.", cta: "Passer à Pro", href: "/chat", highlighted: true, badge: "Recommandé", usage: "3 000 crédits IA par mois", features: ["Accès à tous les niveaux de modèles disponibles", "Comparer jusqu'à 3 modèles côte à côte", "Pièces jointes et fichiers Google Drive", "Partager et télécharger les conversations", "Crédits mensuels pondérés selon le modèle"] },
      { name: "Max", eyebrow: "Workflows IA intensifs", price: "$25", period: "par mois", description: "10 000 crédits IA mensuels pour les modèles avancés et les longs documents.", cta: "Passer à Max", href: "/chat", usage: "10 000 crédits IA par mois", features: ["Accès aux niveaux Free, Pro et Max", "Aucune limite quotidienne sur les modèles Standard", "L'usage Premium suit les crédits mensuels et le fair-use", "Limites de pièces jointes et de contexte plus élevées", "Adapté aux modèles avancés et aux longs documents"] },
    ],
  },
  de: {
    eyebrow: "Preise",
    title: "Wählen Sie die passende KI-Leistung.",
    description: "Starten Sie kostenlos und upgraden Sie, wenn Sie mehr Nutzung, Datei-Workflows und Zugriff auf Premium-Modelle benötigen.",
    billingNote: "Launch-Angebot: 50 % Rabatt auf Pro oder Max im ersten Monat. Jederzeit kündbar.",
    creditNotice: "Der Credit-Verbrauch variiert je nach Verarbeitungskosten und Schlussfolgerungsmethode des Modells. Die geschätzte Nutzung ist vor dem Absenden sichtbar.",
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
        { label: "KI-Credits", free: "300/Monat", pro: "3.000/Monat", max: "10.000/Monat" },
      ],
    },
    faqTitle: "Fragen zu Preisen",
    faqs: [
      { question: "Kann ich Tomverse weiterhin kostenlos nutzen?", answer: "Ja. Free ist für leichte tägliche Nutzung gedacht und bietet innerhalb der Nutzungslimits Zugriff auf Free- und Pro-Modellstufen." },
      { question: "Wie funktioniert der Launch-Rabatt?", answer: "Das Launch-Angebot gewährt im ersten Monat 50 % Rabatt auf Pro oder Max. Danach verlängert sich der Plan zum regulären Monatspreis, sofern er nicht gekündigt wird." },
      { question: "Beschränkt Pro die auswählbaren Modelle?", answer: "Pro soll den verfügbaren Modellkatalog öffnen. Kostenintensivere Modelle werden über Nutzungs- und Kostenlimits gesteuert, nicht über eine einfache Sperre im Modellwähler." },
    ],
    note: "Preise verstehen sich in USD vor Steuern. Bei Max haben Standard-Modelle kein Tageslimit; Premium-Nutzung unterliegt den monatlichen Credits und der Fair-Use-Richtlinie.",
    plans: [
      { name: "Free", eyebrow: "Für den Einstieg", price: "$0", period: "pro Monat", description: "300 monatliche KI-Credits für leichte Alltagsnutzung und zum Testen fortgeschrittener Modelle.", cta: "Kostenlos starten", href: "/chat", usage: "300 KI-Credits pro Monat", features: ["Zugriff auf Free- und Pro-Modellstufen", "Bis zu 3 Modelle vergleichen", "Grundlegender Chatverlauf", "Dateianhänge, Teilen und Downloads nach Anmeldung", "Gut für leichte persönliche Nutzung"] },
      { name: "Pro", eyebrow: "Tägliche Produktivität", price: "$15", period: "pro Monat", description: "3.000 monatliche KI-Credits für alltägliche Multi-Modell-Vergleiche.", cta: "Auf Pro upgraden", href: "/chat", highlighted: true, badge: "Empfohlen", usage: "3.000 KI-Credits pro Monat", features: ["Zugriff auf alle verfügbaren Modellstufen", "Bis zu 3 Modelle nebeneinander vergleichen", "Dateianhänge und Google-Drive-Dateien", "Unterhaltungen teilen und herunterladen", "Nach Modell gewichtete Monats-Credits"] },
      { name: "Max", eyebrow: "Intensive KI-Workflows", price: "$25", period: "pro Monat", description: "10.000 monatliche KI-Credits für intensive Arbeit mit fortgeschrittenen Modellen und langen Dokumenten.", cta: "Auf Max upgraden", href: "/chat", usage: "10.000 KI-Credits pro Monat", features: ["Zugriff auf Free-, Pro- und Max-Modellstufen", "Kein Tageslimit für Standard-Modelle", "Premium-Nutzung folgt Monats-Credits und Fair-Use", "Höhere Anhang- und Kontextlimits", "Für fortgeschrittene Modelle und lange Dokumente"] },
    ],
  },
  es: {
    eyebrow: "Precios",
    title: "Elige el nivel adecuado de potencia de IA.",
    description: "Empieza gratis y actualiza cuando necesites más uso, flujos con archivos y acceso a modelos premium.",
    billingNote: "Oferta de lanzamiento: 50 % de descuento en Pro o Max durante el primer mes. Cancela cuando quieras.",
    creditNotice: "El consumo de créditos varía según el coste de procesamiento y el método de razonamiento del modelo. Puedes revisar el uso estimado antes de enviar una solicitud.",
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
        { label: "Créditos de IA", free: "300/mes", pro: "3.000/mes", max: "10.000/mes" },
      ],
    },
    faqTitle: "Preguntas sobre precios",
    faqs: [
      { question: "¿Puedo seguir usando Tomverse gratis?", answer: "Sí. Free está pensado para uso diario ligero con acceso a niveles de modelos Free y Pro dentro de los límites de uso." },
      { question: "¿Cómo funciona el descuento de lanzamiento?", answer: "La oferta de lanzamiento aplica un 50 % de descuento en Pro o Max durante el primer mes. Después, el plan se renueva al precio mensual regular salvo cancelación." },
      { question: "¿Pro limita los modelos que puedo elegir?", answer: "Pro está pensado para abrir el catálogo de modelos disponible. Los modelos de mayor coste se gestionan con límites de uso y coste, no con un bloqueo simple del selector." },
    ],
    note: "Los precios están en USD antes de impuestos. En Max, los modelos Standard no tienen límite diario; el uso Premium está sujeto a los créditos mensuales y a la política de uso justo.",
    plans: [
      { name: "Free", eyebrow: "Para empezar", price: "$0", period: "al mes", description: "300 créditos de IA al mes para uso diario ligero y probar modelos avanzados.", cta: "Empezar gratis", href: "/chat", usage: "300 créditos de IA al mes", features: ["Acceso a niveles de modelos Free y Pro", "Comparar hasta 3 modelos", "Historial básico de chat", "Archivos, compartir y descargas tras iniciar sesión", "Adecuado para uso personal ligero"] },
      { name: "Pro", eyebrow: "Productividad diaria", price: "$15", period: "al mes", description: "3.000 créditos de IA al mes para comparaciones multimodelo cotidianas.", cta: "Actualizar a Pro", href: "/chat", highlighted: true, badge: "Recomendado", usage: "3.000 créditos de IA al mes", features: ["Acceso a todos los niveles de modelos disponibles", "Comparar hasta 3 modelos lado a lado", "Archivos adjuntos y Google Drive", "Compartir y descargar conversaciones", "Créditos mensuales ponderados por modelo"] },
      { name: "Max", eyebrow: "Flujos intensivos de IA", price: "$25", period: "al mes", description: "10.000 créditos de IA al mes para trabajo intensivo con modelos avanzados y documentos largos.", cta: "Actualizar a Max", href: "/chat", usage: "10.000 créditos de IA al mes", features: ["Acceso a niveles Free, Pro y Max", "Sin límite diario en modelos Standard", "El uso Premium sigue los créditos mensuales y el uso justo", "Límites superiores de adjuntos y contexto", "Para modelos avanzados y documentos largos"] },
    ],
  },
  pt: {
    eyebrow: "Preços",
    title: "Escolha o nível certo de potência de IA.",
    description: "Comece grátis e faça upgrade quando precisar de mais uso, workflows com arquivos e acesso a modelos premium.",
    billingNote: "Oferta de lançamento: 50% de desconto no Pro ou Max no primeiro mês. Cancele quando quiser.",
    creditNotice: "O uso de créditos varia conforme o custo de processamento e o método de raciocínio do modelo. Você pode conferir o uso estimado antes de enviar uma solicitação.",
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
        { label: "Créditos de IA", free: "300/mês", pro: "3.000/mês", max: "10.000/mês" },
      ],
    },
    faqTitle: "Perguntas sobre preços",
    faqs: [
      { question: "Posso continuar usando o Tomverse de graça?", answer: "Sim. O Free é pensado para uso diário leve, com acesso aos níveis de modelos Free e Pro dentro dos limites de uso." },
      { question: "Como funciona o desconto de lançamento?", answer: "A oferta de lançamento aplica 50% de desconto no Pro ou Max no primeiro mês. Depois disso, o plano renova pelo preço mensal regular, salvo cancelamento." },
      { question: "O Pro limita quais modelos posso escolher?", answer: "O Pro foi pensado para liberar o catálogo de modelos disponível. Modelos de custo maior são gerenciados por limites de uso e custo, não por um bloqueio simples no seletor." },
    ],
    note: "Os preços são em USD antes de impostos. No Max, modelos Standard não têm limite diário; o uso Premium está sujeito aos créditos mensais e à política de uso justo.",
    plans: [
      { name: "Free", eyebrow: "Para começar", price: "$0", period: "por mês", description: "300 créditos de IA por mês para uso diário leve e para testar modelos avançados.", cta: "Começar grátis", href: "/chat", usage: "300 créditos de IA por mês", features: ["Acesso aos níveis de modelos Free e Pro", "Comparar até 3 modelos", "Histórico básico de chat", "Anexos, compartilhamento e downloads após login", "Bom para uso pessoal leve"] },
      { name: "Pro", eyebrow: "Produtividade diária", price: "$15", period: "por mês", description: "3.000 créditos de IA por mês para comparações multimodelo cotidianas.", cta: "Atualizar para Pro", href: "/chat", highlighted: true, badge: "Recomendado", usage: "3.000 créditos de IA por mês", features: ["Acesso a todos os níveis de modelos disponíveis", "Comparar até 3 modelos lado a lado", "Anexos e arquivos do Google Drive", "Compartilhar e baixar conversas", "Créditos mensais ponderados por modelo"] },
      { name: "Max", eyebrow: "Fluxos intensivos de IA", price: "$25", period: "por mês", description: "10.000 créditos de IA por mês para trabalho intensivo com modelos avançados e documentos longos.", cta: "Atualizar para Max", href: "/chat", usage: "10.000 créditos de IA por mês", features: ["Acesso aos níveis Free, Pro e Max", "Sem limite diário em modelos Standard", "O uso Premium segue os créditos mensais e o uso justo", "Limites maiores de anexos e contexto", "Para modelos avançados e documentos longos"] },
    ],
  },
};

export function PricingPageContent() {
  const { lang } = useLanguage();
  const content = copy[lang] ?? copy.en;
  const billing = usePublicBilling();
  const annualCopy = annualLabelByLanguage[lang] ?? annualLabelByLanguage.en!;
  const saleCopy = saleLabelByLanguage[lang] ?? saleLabelByLanguage.en!;

  const formatSalePrice = (planId: "free" | "pro" | "max", fallbackUsd: number) => {
    const plan = billing.config?.plans.find((item) => item.id === planId);
    if (plan?.displayCurrency && typeof plan.displayMonthlyPriceAmount === "number") {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: plan.displayCurrency,
        maximumFractionDigits: 1,
        minimumFractionDigits: 0,
      }).format(plan.displayMonthlyPriceAmount / 2);
    }
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 1,
      minimumFractionDigits: 0,
    }).format(fallbackUsd / 2);
  };

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader />

      <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-4xl text-center">
          <p className="text-sm font-black uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{content.eyebrow}</p>
          <h1 className="mt-4 text-4xl font-black leading-tight sm:text-6xl">{content.title}</h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">{content.description}</p>
          <div className="mx-auto mt-6 max-w-3xl overflow-hidden rounded-3xl border border-emerald-400/40 bg-gradient-to-br from-emerald-400/15 via-blue-500/10 to-transparent p-1 text-left shadow-2xl shadow-emerald-950/10">
            <div className="rounded-[1.35rem] bg-white/80 px-5 py-4 backdrop-blur dark:bg-zinc-950/75">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <span className="inline-flex w-fit rounded-full bg-emerald-500 px-3 py-1 text-xs font-black uppercase tracking-[0.16em] text-white">
                    {saleCopy.badge}
                  </span>
                  <p className="mt-3 text-4xl font-black tracking-tight text-emerald-700 dark:text-emerald-200">50% OFF</p>
                </div>
                <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm font-black text-emerald-700 dark:text-emerald-200">
                  {saleCopy.duration}
                </div>
              </div>
              <p className="mt-3 text-sm font-bold text-zinc-700 dark:text-zinc-200">{content.billingNote}</p>
            </div>
          </div>
        </div>

        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {content.plans.map((plan) => {
            const planId = plan.name === "Max" ? "max" : plan.name === "Pro" ? "pro" : "free";
            const displayPrice = billing.formatPlanPrice(planId) || plan.price;
            const annualFallback = planId === "max" ? "$240" : planId === "pro" ? "$144" : "$0";
            const annualPrice = billing.formatPlanPrice(planId, "annual") || annualFallback;
            const annualUsdPrice = billing.formatUsdPlanPrice(planId, "annual") || annualFallback;
            const salePrice = planId === "free" ? null : formatSalePrice(planId, planId === "max" ? 25 : 15);
            return (
            <article
              key={plan.name}
              className={`relative flex min-h-full flex-col rounded-[1.75rem] border p-6 shadow-sm ${
                plan.highlighted ? "border-blue-500 bg-blue-600 text-white shadow-2xl shadow-blue-950/20"
                  : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40"
              }`}
            >
              {planId !== "free" ? (
                <div className={`absolute -top-4 right-6 rounded-full px-4 py-2 text-xs font-black shadow-xl ${
                  plan.highlighted
                    ? "bg-white text-blue-700 shadow-blue-950/20"
                    : "bg-emerald-500 text-white shadow-emerald-950/20"
                }`}>
                  50% OFF
                </div>
              ) : null}
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
              {planId === "free" ? (
                <div className="mt-8">
                  <span className="text-4xl font-black">{displayPrice}</span>
                  <span className={`ml-2 text-sm font-bold ${plan.highlighted ? "text-blue-100" : "text-zinc-500 dark:text-zinc-400"}`}>
                    {plan.period}
                  </span>
                </div>
              ) : (
                <div className={`mt-8 rounded-2xl border p-4 ${
                  plan.highlighted
                    ? "border-white/25 bg-white/15"
                    : "border-emerald-500/30 bg-emerald-500/10"
                }`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className={`rounded-full px-3 py-1 text-xs font-black ${plan.highlighted ? "bg-white text-blue-700" : "bg-emerald-500 text-white"}`}>
                      {saleCopy.badge}
                    </span>
                    <span className={`text-xs font-black ${plan.highlighted ? "text-blue-50" : "text-emerald-600 dark:text-emerald-400"}`}>
                      {saleCopy.intro}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-1">
                    <span className="text-5xl font-black">{salePrice}</span>
                    <span className={`pb-1 text-sm font-black ${plan.highlighted ? "text-blue-50" : "text-zinc-700 dark:text-zinc-200"}`}>
                      / {plan.period}
                    </span>
                    <span className={`pb-1 text-sm font-bold line-through ${plan.highlighted ? "text-blue-100/80" : "text-zinc-500 dark:text-zinc-400"}`}>
                      {displayPrice}
                    </span>
                  </div>
                  <p className={`mt-2 text-xs font-bold ${plan.highlighted ? "text-blue-100" : "text-zinc-600 dark:text-zinc-300"}`}>
                    {saleCopy.duration}. {saleCopy.regular}: {displayPrice} / {plan.period}.
                  </p>
                </div>
              )}
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

        <div className="mt-6 rounded-2xl border border-blue-200 bg-blue-50 px-5 py-4 text-sm font-semibold leading-7 text-blue-950 dark:border-blue-900/70 dark:bg-blue-950/30 dark:text-blue-100">
          {content.creditNotice}
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
