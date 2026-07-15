"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import {
  Calculator,
  CheckCircle2,
  Coins,
  FileText,
  Info,
  MessageSquare,
  Minus,
} from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import {
  INPUT_CREDIT_MULTIPLIERS,
  MODEL_USAGE_CREDIT_WEIGHTS,
  getTypicalShortRequestCapacities,
} from "@/lib/models";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { UpgradeInterestButton } from "@/components/marketing/UpgradeInterestButton";
import { usePublicBilling } from "@/components/marketing/usePublicBilling";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import {
  billingCurrencyFractionDigits,
  type BillingCurrency,
} from "@/lib/billingMarkets";

const annualLabelByLanguage: Partial<Record<Language, { annual: string; save: string; checkout: string }>> = {
  en: { annual: "Annual", save: "Save 20%", checkout: "The fixed local price shown is charged at checkout." },
  ko: { annual: "연간", save: "20% 할인", checkout: "표시된 현지통화 고정 금액으로 결제됩니다." },
  zh: { annual: "年付", save: "节省 20%", checkout: "结账时将收取所显示的本地固定价格。" },
  fr: { annual: "Annuel", save: "-20 %", checkout: "Le prix local fixe affiché est facturé au paiement." },
  de: { annual: "Jährlich", save: "20 % sparen", checkout: "Beim Checkout wird der angezeigte lokale Festpreis berechnet." },
  es: { annual: "Anual", save: "20 % de descuento", checkout: "Se cobra el precio local fijo mostrado." },
  pt: { annual: "Anual", save: "20% de desconto", checkout: "O preço local fixo exibido é cobrado no checkout." },
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

const promotionDetailByLanguage: Partial<
  Record<Language, { code: string; ends: string; eligibility: string; timezone: string }>
> = {
  en: { code: "Code", ends: "Ends", eligibility: "Monthly Pro or Max · one use per account", timezone: "Brisbane time" },
  ko: { code: "코드", ends: "종료", eligibility: "월간 Pro 또는 Max · 계정당 1회", timezone: "브리즈번 시간" },
  zh: { code: "代码", ends: "结束", eligibility: "Pro 或 Max 月付 · 每个账户一次", timezone: "布里斯班时间" },
  fr: { code: "Code", ends: "Fin", eligibility: "Pro ou Max mensuel · une fois par compte", timezone: "heure de Brisbane" },
  de: { code: "Code", ends: "Endet", eligibility: "Pro oder Max monatlich · einmal pro Konto", timezone: "Brisbane-Zeit" },
  es: { code: "Código", ends: "Finaliza", eligibility: "Pro o Max mensual · un uso por cuenta", timezone: "hora de Brisbane" },
  pt: { code: "Código", ends: "Termina", eligibility: "Pro ou Max mensal · um uso por conta", timezone: "horário de Brisbane" },
};

const promotionDateLocale: Record<Language, string> = {
  en: "en-AU",
  ko: "ko-KR",
  zh: "zh-CN",
  fr: "fr-FR",
  de: "de-DE",
  es: "es-ES",
  pt: "pt-BR",
};

type CreditValueCopy = {
  eyebrow: string;
  title: string;
  description: string;
  typicalLabel: string;
  creditUnit: string;
  monthlyUnit: string;
  approx: string;
  standardOnly: string;
  advancedOnly: string;
  mixedComparison: string;
  responseUnit: string;
  comparisonUnit: string;
  longContextTitle: string;
  longContextBody: string;
  tokenUnit: string;
  preflightTitle: string;
  preflightBody: string;
  preflightCta: string;
  disclaimer: string;
};

const creditValueCopy: Record<Language, CreditValueCopy> = {
  en: {
    eyebrow: "Credit guide",
    title: "What can each monthly credit allowance cover?",
    description: "Compare the allowance with the base cost of common model combinations before choosing a plan.",
    typicalLabel: "Typical short-request examples",
    creditUnit: "credits",
    monthlyUnit: "credits / month",
    approx: "About",
    standardOnly: "Standard only",
    advancedOnly: "Advanced only",
    mixedComparison: "Standard + Advanced + Premium",
    responseUnit: "responses",
    comparisonUnit: "comparisons",
    longContextTitle: "Long conversations and files use more context",
    longContextBody: "Input context includes the current prompt, previous conversation, and extracted file content. As that context grows, the base model charge is multiplied by the bands below.",
    tokenUnit: "input tokens",
    preflightTitle: "Check the base estimate before sending",
    preflightBody: "The model selector shows each model's usage class and base credits. Add the selected models together; file and long-context multipliers are applied after the request context is processed.",
    preflightCta: "Open the model selector",
    disclaimer: "Illustrative examples for typical short requests without files or long conversation history. They are not guaranteed response counts; actual usage varies by model, full input context, attachments, and reasoning mode.",
  },
  ko: {
    eyebrow: "크레딧 사용 가이드",
    title: "월 크레딧으로 어느 정도 사용할 수 있나요?",
    description: "플랜을 선택하기 전에 월 제공량을 자주 사용하는 모델 조합의 기본 차감량과 비교해 보세요.",
    typicalLabel: "일반적인 짧은 요청 기준 예시",
    creditUnit: "크레딧",
    monthlyUnit: "크레딧 / 월",
    approx: "약",
    standardOnly: "Standard 단독",
    advancedOnly: "Advanced 단독",
    mixedComparison: "Standard + Advanced + Premium",
    responseUnit: "응답",
    comparisonUnit: "비교",
    longContextTitle: "긴 대화와 파일은 더 많은 문맥을 사용합니다",
    longContextBody: "입력 문맥에는 현재 질문, 이전 대화와 추출된 파일 내용이 포함됩니다. 문맥이 길어지면 아래 구간에 따라 모델 기본 차감량에 배율이 적용됩니다.",
    tokenUnit: "입력 토큰",
    preflightTitle: "전송 전에 기본 예상량을 확인하세요",
    preflightBody: "모델 선택기에서 각 모델의 사용 등급과 기본 크레딧을 확인할 수 있습니다. 선택한 모델의 기본값을 합산하며, 파일·긴 문맥 배율은 요청 문맥 처리 후 적용됩니다.",
    preflightCta: "모델 선택기에서 확인",
    disclaimer: "파일이나 긴 대화 기록이 없는 일반적인 짧은 요청 기준의 예시이며 보장 응답 횟수가 아닙니다. 실제 사용량은 모델, 전체 입력 문맥, 첨부파일과 추론 방식에 따라 달라집니다.",
  },
  zh: {
    eyebrow: "积分指南",
    title: "每月积分大约可以完成多少次请求？",
    description: "选择方案前，可将每月额度与常用模型组合的基础消耗进行比较。",
    typicalLabel: "典型短请求示例",
    creditUnit: "积分",
    monthlyUnit: "积分 / 月",
    approx: "约",
    standardOnly: "仅 Standard",
    advancedOnly: "仅 Advanced",
    mixedComparison: "Standard + Advanced + Premium",
    responseUnit: "次响应",
    comparisonUnit: "次比较",
    longContextTitle: "长对话和文件会使用更多上下文",
    longContextBody: "输入上下文包括当前问题、先前对话和提取的文件内容。上下文增长时，模型基础消耗会按以下区间乘以相应倍数。",
    tokenUnit: "输入 token",
    preflightTitle: "发送前查看基础预估",
    preflightBody: "模型选择器会显示每个模型的使用等级和基础积分。所选模型的基础值相加；文件和长上下文倍数会在处理请求上下文后应用。",
    preflightCta: "打开模型选择器",
    disclaimer: "这是无文件、无长对话历史的典型短请求示例，并非保证的响应次数。实际用量会因模型、完整输入上下文、附件和推理模式而异。",
  },
  fr: {
    eyebrow: "Guide des crédits",
    title: "Que permet chaque enveloppe mensuelle de crédits ?",
    description: "Comparez l'enveloppe au coût de base des combinaisons de modèles courantes avant de choisir un plan.",
    typicalLabel: "Exemples de requêtes courtes typiques",
    creditUnit: "crédits",
    monthlyUnit: "crédits / mois",
    approx: "Environ",
    standardOnly: "Standard uniquement",
    advancedOnly: "Advanced uniquement",
    mixedComparison: "Standard + Advanced + Premium",
    responseUnit: "réponses",
    comparisonUnit: "comparaisons",
    longContextTitle: "Les longues conversations et les fichiers utilisent plus de contexte",
    longContextBody: "Le contexte comprend la demande actuelle, la conversation précédente et le contenu extrait des fichiers. Le coût de base est multiplié selon les paliers ci-dessous.",
    tokenUnit: "tokens d'entrée",
    preflightTitle: "Vérifiez l'estimation de base avant l'envoi",
    preflightBody: "Le sélecteur affiche la classe d'usage et les crédits de base de chaque modèle. Additionnez les modèles sélectionnés ; les multiplicateurs de fichiers et de contexte long sont appliqués après traitement.",
    preflightCta: "Ouvrir le sélecteur de modèles",
    disclaimer: "Exemples indicatifs pour des requêtes courtes sans fichier ni long historique. Le nombre de réponses n'est pas garanti et varie selon le modèle, le contexte, les pièces jointes et le mode de raisonnement.",
  },
  de: {
    eyebrow: "Credit-Leitfaden",
    title: "Was deckt das monatliche Credit-Kontingent ab?",
    description: "Vergleichen Sie das Kontingent vor der Tarifwahl mit den Basiskosten gängiger Modellkombinationen.",
    typicalLabel: "Beispiele für typische kurze Anfragen",
    creditUnit: "Credits",
    monthlyUnit: "Credits / Monat",
    approx: "Etwa",
    standardOnly: "Nur Standard",
    advancedOnly: "Nur Advanced",
    mixedComparison: "Standard + Advanced + Premium",
    responseUnit: "Antworten",
    comparisonUnit: "Vergleiche",
    longContextTitle: "Lange Gespräche und Dateien verwenden mehr Kontext",
    longContextBody: "Der Eingabekontext umfasst die aktuelle Anfrage, den bisherigen Verlauf und extrahierte Dateiinhalte. Mit wachsendem Kontext wird der Basisverbrauch nach den folgenden Stufen multipliziert.",
    tokenUnit: "Eingabe-Token",
    preflightTitle: "Basisprognose vor dem Senden prüfen",
    preflightBody: "Die Modellauswahl zeigt Nutzungsklasse und Basis-Credits jedes Modells. Die ausgewählten Modelle werden addiert; Datei- und Langkontextfaktoren werden nach der Verarbeitung angewendet.",
    preflightCta: "Modellauswahl öffnen",
    disclaimer: "Unverbindliche Beispiele für typische kurze Anfragen ohne Dateien oder langen Verlauf. Die Antwortzahl ist nicht garantiert und hängt von Modell, Gesamtkontext, Anhängen und Reasoning-Modus ab.",
  },
  es: {
    eyebrow: "Guía de créditos",
    title: "¿Qué cubre cada asignación mensual de créditos?",
    description: "Compara la asignación con el coste base de combinaciones habituales antes de elegir un plan.",
    typicalLabel: "Ejemplos de solicitudes cortas habituales",
    creditUnit: "créditos",
    monthlyUnit: "créditos / mes",
    approx: "Aprox.",
    standardOnly: "Solo Standard",
    advancedOnly: "Solo Advanced",
    mixedComparison: "Standard + Advanced + Premium",
    responseUnit: "respuestas",
    comparisonUnit: "comparaciones",
    longContextTitle: "Las conversaciones largas y los archivos usan más contexto",
    longContextBody: "El contexto incluye la solicitud actual, la conversación previa y el contenido extraído de archivos. Al crecer, el coste base se multiplica según los tramos siguientes.",
    tokenUnit: "tokens de entrada",
    preflightTitle: "Comprueba la estimación base antes de enviar",
    preflightBody: "El selector muestra la clase de uso y los créditos base de cada modelo. Suma los modelos seleccionados; los multiplicadores de archivos y contexto largo se aplican tras procesar la solicitud.",
    preflightCta: "Abrir el selector de modelos",
    disclaimer: "Ejemplos orientativos para solicitudes cortas sin archivos ni historial largo. No garantizan una cantidad de respuestas; el uso real depende del modelo, contexto, adjuntos y modo de razonamiento.",
  },
  pt: {
    eyebrow: "Guia de créditos",
    title: "O que cada franquia mensal de créditos pode cobrir?",
    description: "Compare a franquia com o custo-base das combinações mais comuns antes de escolher um plano.",
    typicalLabel: "Exemplos de pedidos curtos típicos",
    creditUnit: "créditos",
    monthlyUnit: "créditos / mês",
    approx: "Cerca de",
    standardOnly: "Somente Standard",
    advancedOnly: "Somente Advanced",
    mixedComparison: "Standard + Advanced + Premium",
    responseUnit: "respostas",
    comparisonUnit: "comparações",
    longContextTitle: "Conversas longas e arquivos usam mais contexto",
    longContextBody: "O contexto inclui o pedido atual, a conversa anterior e o conteúdo extraído dos arquivos. À medida que cresce, o custo-base é multiplicado pelas faixas abaixo.",
    tokenUnit: "tokens de entrada",
    preflightTitle: "Confira a estimativa-base antes de enviar",
    preflightBody: "O seletor mostra a classe de uso e os créditos-base de cada modelo. Some os modelos escolhidos; multiplicadores de arquivos e contexto longo são aplicados após o processamento.",
    preflightCta: "Abrir o seletor de modelos",
    disclaimer: "Exemplos ilustrativos para pedidos curtos sem arquivos ou histórico longo. Não garantem uma quantidade de respostas; o uso real varia conforme modelo, contexto, anexos e modo de raciocínio.",
  },
};

type CreditPackCopy = {
  eyebrow: string;
  title: string;
  description: string;
  availableFor: string;
  oneTime: string;
  validity: string;
  credits: string;
  policyTitle: string;
  policies: string[];
  guidance: string;
  purchaseCta: string;
  loading: string;
  packNames: Record<"starter_500" | "project_1500" | "power_4000", string>;
  packDescriptions: Record<"starter_500" | "project_1500" | "power_4000", string>;
};

const creditPackCopy: Record<Language, CreditPackCopy> = {
  en: {
    eyebrow: "One-time add-ons",
    title: "Need more credits without changing plans?",
    description: "Buy an additional credit pack for a temporary project or a busier month. Fixed local pricing is shown and checkout is available after sign-in.",
    availableFor: "Available on",
    oneTime: "One-time purchase",
    validity: "Valid for 12 months",
    credits: "credits",
    policyTitle: "How additional credits work",
    policies: [
      "Monthly plan credits are used first, followed by additional credits with the earliest expiry.",
      "Additional credits do not unlock models or features and do not raise daily, fair-use, or plan-specific limits.",
      "Unused additional credits remain available after a plan change or cancellation until their displayed expiry date.",
    ],
    guidance: "Free: Pro remains the recommended upgrade for recurring use; the Starter pack is for occasional overflow. Pro and Max: use packs for one-off work and upgrade when higher usage repeats each month.",
    purchaseCta: "Sign in to buy credits",
    loading: "Loading current credit-pack pricing…",
    packNames: {
      starter_500: "Starter Credit Pack",
      project_1500: "Project Credit Pack",
      power_4000: "Power Credit Pack",
    },
    packDescriptions: {
      starter_500: "A small add-on for Free users who need a little more usage this month.",
      project_1500: "Extra capacity for a document, research, or short-term project.",
      power_4000: "A larger add-on for intensive Pro or Max work without changing plans.",
    },
  },
  ko: {
    eyebrow: "일회성 추가 상품",
    title: "플랜 변경 없이 크레딧만 더 필요하신가요?",
    description: "이번 달 작업량이 많거나 일시적인 프로젝트가 있을 때 추가 크레딧 팩을 구매할 수 있습니다. 현지통화 고정 가격이 표시되며 로그인 후 결제할 수 있습니다.",
    availableFor: "구매 가능 플랜",
    oneTime: "일회성 구매",
    validity: "12개월 유효",
    credits: "크레딧",
    policyTitle: "추가 크레딧 이용 방식",
    policies: [
      "월 플랜 크레딧을 먼저 사용한 뒤 만료일이 빠른 추가 크레딧부터 차감합니다.",
      "추가 크레딧은 모델·기능을 해제하지 않으며 일일 한도, 공정사용 및 플랜별 제한도 늘리지 않습니다.",
      "플랜을 변경하거나 해지해도 미사용 추가 크레딧은 표시된 만료일까지 유지됩니다.",
    ],
    guidance: "Free는 반복 사용 시 Pro 업그레이드가 우선이며 Starter 팩은 일시적인 추가 사용용입니다. Pro·Max는 한 번의 프로젝트에는 팩을, 매월 사용량이 반복해서 많다면 상위 플랜을 권장합니다.",
    purchaseCta: "로그인하고 크레딧 구매",
    loading: "현재 크레딧 팩 가격을 불러오는 중…",
    packNames: {
      starter_500: "Starter 크레딧 팩",
      project_1500: "Project 크레딧 팩",
      power_4000: "Power 크레딧 팩",
    },
    packDescriptions: {
      starter_500: "이번 달 사용량이 조금 더 필요한 Free 사용자를 위한 소형 팩입니다.",
      project_1500: "문서, 리서치 또는 단기 프로젝트를 위한 추가 사용량입니다.",
      power_4000: "플랜 변경 없이 집중적인 Pro·Max 작업을 이어가기 위한 대용량 팩입니다.",
    },
  },
  zh: {
    eyebrow: "一次性加购",
    title: "无需更改方案，也能增加积分",
    description: "当本月工作量增加或有临时项目时，可购买额外积分包。页面显示本地固定价格，登录后可结账。",
    availableFor: "适用方案",
    oneTime: "一次性购买",
    validity: "有效期 12 个月",
    credits: "积分",
    policyTitle: "额外积分的使用方式",
    policies: [
      "先扣除月度方案积分，再按最早到期顺序扣除额外积分。",
      "额外积分不会解锁模型或功能，也不会提高每日、公平使用或方案限制。",
      "更改或取消方案后，未使用的额外积分会保留到标示的到期日。",
    ],
    guidance: "Free 的长期使用仍建议升级 Pro；Starter 包适合偶尔超额。Pro 和 Max 可为一次性项目加购，若每月持续高用量则建议升级。",
    purchaseCta: "登录后购买积分",
    loading: "正在加载当前积分包价格…",
    packNames: { starter_500: "Starter 积分包", project_1500: "Project 积分包", power_4000: "Power 积分包" },
    packDescriptions: {
      starter_500: "适合本月只需少量额外用量的 Free 用户。",
      project_1500: "适合文档、研究或短期项目的额外用量。",
      power_4000: "无需更改方案即可支持密集的 Pro 或 Max 工作。",
    },
  },
  fr: {
    eyebrow: "Crédits ponctuels",
    title: "Besoin de crédits sans changer de formule ?",
    description: "Achetez un pack pour un projet temporaire ou un mois plus chargé. Le prix local fixe est affiché et l’achat est disponible après connexion.",
    availableFor: "Disponible avec",
    oneTime: "Achat unique",
    validity: "Valable 12 mois",
    credits: "crédits",
    policyTitle: "Fonctionnement des crédits supplémentaires",
    policies: [
      "Les crédits mensuels sont utilisés avant les crédits supplémentaires arrivant le plus tôt à expiration.",
      "Ils ne débloquent aucun modèle ou fonction et n’augmentent aucune limite quotidienne ou de fair-use.",
      "Ils restent disponibles après un changement ou une résiliation jusqu’à leur date d’expiration.",
    ],
    guidance: "Avec Free, Pro reste conseillé pour un usage récurrent. Utilisez un pack pour un besoin ponctuel et passez au plan supérieur si ce besoin revient chaque mois.",
    purchaseCta: "Se connecter pour acheter",
    loading: "Chargement des prix actuels…",
    packNames: { starter_500: "Pack Starter", project_1500: "Pack Project", power_4000: "Pack Power" },
    packDescriptions: {
      starter_500: "Un petit complément pour les utilisateurs Free.",
      project_1500: "Une capacité supplémentaire pour un projet ponctuel.",
      power_4000: "Un grand complément pour un usage Pro ou Max intensif.",
    },
  },
  de: {
    eyebrow: "Einmalige Zusatzpakete",
    title: "Mehr Credits ohne Tarifwechsel?",
    description: "Kaufen Sie ein Paket für ein vorübergehendes Projekt oder einen arbeitsreichen Monat. Der lokale Festpreis wird angezeigt; Kauf nach Anmeldung.",
    availableFor: "Verfügbar für",
    oneTime: "Einmalkauf",
    validity: "12 Monate gültig",
    credits: "Credits",
    policyTitle: "So funktionieren zusätzliche Credits",
    policies: [
      "Monatliche Tarif-Credits werden zuerst verbraucht, danach Zusatz-Credits mit dem frühesten Ablaufdatum.",
      "Zusatz-Credits schalten keine Modelle oder Funktionen frei und erhöhen keine Tages- oder Fair-Use-Limits.",
      "Nach Tarifwechsel oder Kündigung bleiben sie bis zum angegebenen Ablaufdatum erhalten.",
    ],
    guidance: "Bei Free bleibt Pro für regelmäßige Nutzung die Empfehlung. Pakete eignen sich für einmalige Projekte; bei monatlich höherem Bedarf ist ein Upgrade sinnvoller.",
    purchaseCta: "Anmelden und Credits kaufen",
    loading: "Aktuelle Paketpreise werden geladen…",
    packNames: { starter_500: "Starter-Credit-Paket", project_1500: "Project-Credit-Paket", power_4000: "Power-Credit-Paket" },
    packDescriptions: {
      starter_500: "Ein kleines Zusatzpaket für Free-Nutzer.",
      project_1500: "Zusätzliche Kapazität für ein zeitlich begrenztes Projekt.",
      power_4000: "Ein großes Paket für intensive Pro- oder Max-Arbeit.",
    },
  },
  es: {
    eyebrow: "Complementos de un pago",
    title: "¿Necesitas más créditos sin cambiar de plan?",
    description: "Compra un paquete para un proyecto temporal o un mes con más trabajo. Se muestra el precio local fijo y la compra requiere iniciar sesión.",
    availableFor: "Disponible en",
    oneTime: "Compra única",
    validity: "Válido 12 meses",
    credits: "créditos",
    policyTitle: "Cómo funcionan los créditos adicionales",
    policies: [
      "Primero se usan los créditos mensuales y después los adicionales con vencimiento más próximo.",
      "No desbloquean modelos ni funciones y no aumentan límites diarios, de uso justo o del plan.",
      "Se conservan tras cambiar o cancelar el plan hasta la fecha de vencimiento indicada.",
    ],
    guidance: "En Free, Pro sigue siendo la opción recomendada para uso recurrente. Usa paquetes para proyectos puntuales y mejora el plan si el mayor uso se repite cada mes.",
    purchaseCta: "Inicia sesión para comprar",
    loading: "Cargando precios actuales…",
    packNames: { starter_500: "Paquete Starter", project_1500: "Paquete Project", power_4000: "Paquete Power" },
    packDescriptions: {
      starter_500: "Un pequeño complemento para usuarios Free.",
      project_1500: "Capacidad adicional para un proyecto temporal.",
      power_4000: "Un complemento grande para trabajo intensivo en Pro o Max.",
    },
  },
  pt: {
    eyebrow: "Créditos avulsos",
    title: "Precisa de mais créditos sem mudar de plano?",
    description: "Compre um pacote para um projeto temporário ou um mês mais intenso. O preço local fixo é exibido e a compra fica disponível após o login.",
    availableFor: "Disponível no",
    oneTime: "Compra única",
    validity: "Válido por 12 meses",
    credits: "créditos",
    policyTitle: "Como funcionam os créditos adicionais",
    policies: [
      "Os créditos mensais são usados primeiro; depois, os adicionais com vencimento mais próximo.",
      "Eles não liberam modelos ou recursos nem aumentam limites diários, de uso justo ou do plano.",
      "Continuam disponíveis após mudança ou cancelamento até a data de validade indicada.",
    ],
    guidance: "No Free, o Pro continua recomendado para uso recorrente. Use pacotes para projetos pontuais e faça upgrade se o uso maior se repetir todo mês.",
    purchaseCta: "Entrar para comprar créditos",
    loading: "Carregando preços atuais…",
    packNames: { starter_500: "Pacote Starter", project_1500: "Pacote Project", power_4000: "Pacote Power" },
    packDescriptions: {
      starter_500: "Um pequeno adicional para usuários Free.",
      project_1500: "Capacidade extra para um projeto temporário.",
      power_4000: "Um pacote maior para trabalho intenso no Pro ou Max.",
    },
  },
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
  faqs: Array<{ question: string; answer: string; promotionOnly?: boolean }>;
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
        { label: "Model access", free: "Selected model catalogue", pro: "All models with Pro usage limits", max: "All models with the largest allowance" },
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
        answer: "Yes. The Free plan is intended for light daily use with access to a selected model catalogue within usage limits.",
      },
      {
        question: "How does the launch discount work",
        answer: "The launch special gives 50% off Pro or Max for the first month. After that, the plan renews at the regular monthly price unless canceled.",
        promotionOnly: true,
      },
      {
        question: "Does Pro restrict which models I can choose",
        answer: "Pro is intended to unlock the available model catalogue. Higher-cost models are managed through usage and cost limits rather than a simple model picker block.",
      },
    ],
    note:
      "Prices are shown before tax in the selected fixed billing currency. On Max, Standard models have no daily limit; Premium usage is subject to monthly credits and the Fair Use Policy.",
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
          "Access to the selected model catalogue",
          "Up to 30 selected higher-cost model responses per month",
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
          "Access to all available models",
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
          "Access to all available models",
          "No daily limit on Standard models",
          "Premium usage follows monthly credits and Fair Use",
          "Higher attachment and context limits",
          "Priority access to advanced models",
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
        { label: "모델 접근", free: "선별된 모델 카탈로그", pro: "Pro 사용량 한도 내 모든 모델", max: "가장 큰 사용량으로 모든 모델" },
        { label: "다중 모델 비교", free: "최대 3개 모델", pro: "최대 3개 모델", max: "최대 3개 모델" },
        { label: "파일 첨부", free: "이미지, PDF, Office, Drive", pro: "이미지, PDF, Office, Drive", max: "더 높은 파일 및 맥락 한도" },
        { label: "대화 공유", free: "공유 및 다운로드", pro: "공유 및 다운로드", max: "공유, 다운로드, 우선 한도" },
        { label: "AI 크레딧", free: "월 300", pro: "월 3,000", max: "월 10,000" },
      ],
    },
    faqTitle: "요금 관련 질문",
    faqs: [
      { question: "Tomverse를 무료로 계속 사용할 수 있나요", answer: "네. Free 플랜은 사용량 한도 안에서 선별된 모델 카탈로그를 이용하는 가벼운 일상 사용용 플랜입니다." },
      { question: "출시 할인은 어떻게 적용되나요", answer: "출시 특가로 Pro 또는 Max 첫 달 동안 50% 할인을 받을 수 있습니다. 이후에는 취소하지 않는 한 정가 월 요금으로 갱신됩니다.", promotionOnly: true },
      { question: "Pro는 선택 가능한 모델을 제한하나요", answer: "Pro는 사용 가능한 모델 카탈로그를 열어두는 방향입니다. 고비용 모델은 단순히 모델 선택을 막기보다 사용량과 비용 한도로 관리합니다." },
    ],
    note: "가격은 선택된 현지통화의 세금 전 고정 금액입니다. Max는 Standard 모델 일일 제한 없음, Premium 사용량은 월 크레딧 및 공정사용 정책이 적용됩니다.",
    plans: [
      { name: "Free", eyebrow: "처음 시작하는 사용자", price: "$0", period: "월", description: "가벼운 일상 사용과 고급 모델 체험을 위한 월 300 AI 크레딧", cta: "무료로 시작", href: "/chat", usage: "월 300 AI 크레딧", features: ["선별된 모델 카탈로그 접근", "고급 모델 월 30응답까지", "최대 3개 모델 비교", "로그인 후 파일 첨부, 공유, 다운로드", "가벼운 개인 사용에 적합"] },
      { name: "Pro", eyebrow: "일상 생산성", price: "$15", period: "월", description: "일상적인 멀티모델 비교를 위한 월 3,000 AI 크레딧", cta: "Pro로 업그레이드", href: "/chat", highlighted: true, badge: "추천", usage: "월 3,000 AI 크레딧", features: ["모든 사용 가능 모델 접근", "모델별 가중치에 따라 월 크레딧 사용", "최대 3개 모델 나란히 비교", "파일 첨부 및 Google Drive 파일", "공유 및 다운로드"] },
      { name: "Max", eyebrow: "고강도 AI 워크플로", price: "$25", period: "월", description: "집중적인 고급 모델·긴 문서 작업을 위한 월 10,000 AI 크레딧", cta: "Max로 업그레이드", href: "/chat", usage: "월 10,000 AI 크레딧", features: ["모든 사용 가능 모델 접근", "Standard 모델 일일 제한 없음", "Premium 사용량은 월 크레딧 및 공정사용 정책 적용", "더 높은 첨부파일 및 맥락 한도", "고급 모델·긴 문서 작업에 적합"] },
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
        { label: "模型访问", free: "精选模型目录", pro: "在 Pro 使用限制内访问所有模型", max: "以最大额度访问所有模型" },
        { label: "多模型比较", free: "最多 3 个模型", pro: "最多 3 个模型", max: "最多 3 个模型" },
        { label: "文件附件", free: "图片、PDF、Office、Drive", pro: "图片、PDF、Office、Drive", max: "更高的文件和上下文限制" },
        { label: "对话分享", free: "分享和下载", pro: "分享和下载", max: "分享、下载和优先额度" },
        { label: "AI 积分", free: "每月 300", pro: "每月 3,000", max: "每月 10,000" },
      ],
    },
    faqTitle: "价格问题",
    faqs: [
      { question: "可以继续免费使用 Tomverse 吗？", answer: "可以。Free 适合轻量日常使用，可在使用限制内访问精选模型目录。" },
      { question: "发布折扣如何使用？", answer: "发布特价可让 Pro 或 Max 首月享受 50% 折扣。之后除非取消，否则会按标准月费续订。", promotionOnly: true },
      { question: "Pro 会限制我能选择的模型吗？", answer: "Pro 的目标是开放可用模型目录。成本更高的模型会通过使用量和成本限制来管理，而不是简单地在模型选择器中锁定。" },
    ],
    note: "价格为所选结算货币的税前固定金额。Max 的 Standard 模型无每日限制；Premium 用量受月度积分和公平使用政策约束。",
    plans: [
      { name: "Free", eyebrow: "适合开始使用", price: "$0", period: "每月", description: "每月 300 AI 积分，适合轻量日常使用和体验高级模型。", cta: "免费开始", href: "/chat", usage: "每月 300 AI 积分", features: ["访问精选模型目录", "最多比较 3 个模型", "基础聊天记录", "登录后可使用文件附件、分享和下载", "适合轻量个人使用"] },
      { name: "Pro", eyebrow: "日常生产力", price: "$15", period: "每月", description: "每月 3,000 AI 积分，适合日常多模型比较。", cta: "升级到 Pro", href: "/chat", highlighted: true, badge: "推荐", usage: "每月 3,000 AI 积分", features: ["访问所有可用模型", "最多并排比较 3 个模型", "文件附件和 Google Drive 文件", "分享和下载对话", "按模型加权使用月度积分"] },
      { name: "Max", eyebrow: "高强度 AI 工作流", price: "$25", period: "每月", description: "每月 10,000 AI 积分，适合高强度高级模型和长文档工作。", cta: "升级到 Max", href: "/chat", usage: "每月 10,000 AI 积分", features: ["访问所有可用模型", "Standard 模型无每日限制", "Premium 用量适用月度积分和公平使用政策", "更高的附件和上下文限制", "适合高级模型和长文档工作"] },
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
      { question: "Puis-je continuer à utiliser Tomverse gratuitement ?", answer: "Oui. Le plan Free est prévu pour un usage quotidien léger, avec accès à un catalogue de modèles sélectionnés dans les limites d'utilisation." },
      { question: "Comment fonctionne la réduction de lancement ?", answer: "L'offre de lancement applique -50 % sur Pro ou Max le premier mois. Ensuite, le plan se renouvelle au prix mensuel standard, sauf annulation.", promotionOnly: true },
      { question: "Pro limite-t-il les modèles que je peux choisir ?", answer: "Pro vise à ouvrir le catalogue de modèles disponible. Les modèles plus coûteux sont gérés par des limites d'usage et de coût plutôt que par un simple blocage dans le sélecteur." },
    ],
    note: "Les prix sont des montants fixes hors taxes dans la devise de facturation sélectionnée. Avec Max, les modèles Standard n'ont pas de limite quotidienne ; l'usage Premium reste soumis aux crédits mensuels et à la politique d'utilisation équitable.",
    plans: [
      { name: "Free", eyebrow: "Pour commencer", price: "$0", period: "par mois", description: "300 crédits IA mensuels pour un usage quotidien léger et l'essai de modèles avancés.", cta: "Commencer gratuitement", href: "/chat", usage: "300 crédits IA par mois", features: ["Accès au catalogue de modèles sélectionnés", "Comparer jusqu'à 3 modèles", "Historique de conversation de base", "Pièces jointes, partage et téléchargements après connexion", "Adapté à un usage personnel léger"] },
      { name: "Pro", eyebrow: "Productivité quotidienne", price: "$15", period: "par mois", description: "3 000 crédits IA mensuels pour les comparaisons multi-modèles quotidiennes.", cta: "Passer à Pro", href: "/chat", highlighted: true, badge: "Recommandé", usage: "3 000 crédits IA par mois", features: ["Accès à tous les modèles disponibles", "Comparer jusqu'à 3 modèles côte à côte", "Pièces jointes et fichiers Google Drive", "Partager et télécharger les conversations", "Crédits mensuels pondérés selon le modèle"] },
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
        { label: "Modellzugriff", free: "Ausgewählter Modellkatalog", pro: "Alle Modelle mit Pro-Limits", max: "Alle Modelle mit dem größten Kontingent" },
        { label: "Multi-Modell-Vergleich", free: "Bis zu 3 Modelle", pro: "Bis zu 3 Modelle", max: "Bis zu 3 Modelle" },
        { label: "Dateianhänge", free: "Bilder, PDFs, Office, Drive", pro: "Bilder, PDFs, Office, Drive", max: "Höhere Datei- und Kontextlimits" },
        { label: "Unterhaltungen teilen", free: "Teilen und herunterladen", pro: "Teilen und herunterladen", max: "Teilen, herunterladen und priorisierte Limits" },
        { label: "KI-Credits", free: "300/Monat", pro: "3.000/Monat", max: "10.000/Monat" },
      ],
    },
    faqTitle: "Fragen zu Preisen",
    faqs: [
      { question: "Kann ich Tomverse weiterhin kostenlos nutzen?", answer: "Ja. Free ist für leichte tägliche Nutzung gedacht und bietet innerhalb der Nutzungslimits Zugriff auf einen ausgewählten Modellkatalog." },
      { question: "Wie funktioniert der Launch-Rabatt?", answer: "Das Launch-Angebot gewährt im ersten Monat 50 % Rabatt auf Pro oder Max. Danach verlängert sich der Plan zum regulären Monatspreis, sofern er nicht gekündigt wird.", promotionOnly: true },
      { question: "Beschränkt Pro die auswählbaren Modelle?", answer: "Pro soll den verfügbaren Modellkatalog öffnen. Kostenintensivere Modelle werden über Nutzungs- und Kostenlimits gesteuert, nicht über eine einfache Sperre im Modellwähler." },
    ],
    note: "Preise sind feste Beträge vor Steuern in der ausgewählten Abrechnungswährung. Bei Max haben Standard-Modelle kein Tageslimit; Premium-Nutzung unterliegt den monatlichen Credits und der Fair-Use-Richtlinie.",
    plans: [
      { name: "Free", eyebrow: "Für den Einstieg", price: "$0", period: "pro Monat", description: "300 monatliche KI-Credits für leichte Alltagsnutzung und zum Testen fortgeschrittener Modelle.", cta: "Kostenlos starten", href: "/chat", usage: "300 KI-Credits pro Monat", features: ["Zugriff auf den ausgewählten Modellkatalog", "Bis zu 3 Modelle vergleichen", "Grundlegender Chatverlauf", "Dateianhänge, Teilen und Downloads nach Anmeldung", "Gut für leichte persönliche Nutzung"] },
      { name: "Pro", eyebrow: "Tägliche Produktivität", price: "$15", period: "pro Monat", description: "3.000 monatliche KI-Credits für alltägliche Multi-Modell-Vergleiche.", cta: "Auf Pro upgraden", href: "/chat", highlighted: true, badge: "Empfohlen", usage: "3.000 KI-Credits pro Monat", features: ["Zugriff auf alle verfügbaren Modelle", "Bis zu 3 Modelle nebeneinander vergleichen", "Dateianhänge und Google-Drive-Dateien", "Unterhaltungen teilen und herunterladen", "Nach Modell gewichtete Monats-Credits"] },
      { name: "Max", eyebrow: "Intensive KI-Workflows", price: "$25", period: "pro Monat", description: "10.000 monatliche KI-Credits für intensive Arbeit mit fortgeschrittenen Modellen und langen Dokumenten.", cta: "Auf Max upgraden", href: "/chat", usage: "10.000 KI-Credits pro Monat", features: ["Zugriff auf alle verfügbaren Modelle", "Kein Tageslimit für Standard-Modelle", "Premium-Nutzung folgt Monats-Credits und Fair-Use", "Höhere Anhang- und Kontextlimits", "Für fortgeschrittene Modelle und lange Dokumente"] },
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
      { question: "¿Puedo seguir usando Tomverse gratis?", answer: "Sí. Free está pensado para uso diario ligero con acceso a un catálogo de modelos seleccionados dentro de los límites de uso." },
      { question: "¿Cómo funciona el descuento de lanzamiento?", answer: "La oferta de lanzamiento aplica un 50 % de descuento en Pro o Max durante el primer mes. Después, el plan se renueva al precio mensual regular salvo cancelación.", promotionOnly: true },
      { question: "¿Pro limita los modelos que puedo elegir?", answer: "Pro está pensado para abrir el catálogo de modelos disponible. Los modelos de mayor coste se gestionan con límites de uso y coste, no con un bloqueo simple del selector." },
    ],
    note: "Los precios son importes fijos antes de impuestos en la moneda de facturación seleccionada. En Max, los modelos Standard no tienen límite diario; el uso Premium está sujeto a los créditos mensuales y a la política de uso justo.",
    plans: [
      { name: "Free", eyebrow: "Para empezar", price: "$0", period: "al mes", description: "300 créditos de IA al mes para uso diario ligero y probar modelos avanzados.", cta: "Empezar gratis", href: "/chat", usage: "300 créditos de IA al mes", features: ["Acceso al catálogo de modelos seleccionados", "Comparar hasta 3 modelos", "Historial básico de chat", "Archivos, compartir y descargas tras iniciar sesión", "Adecuado para uso personal ligero"] },
      { name: "Pro", eyebrow: "Productividad diaria", price: "$15", period: "al mes", description: "3.000 créditos de IA al mes para comparaciones multimodelo cotidianas.", cta: "Actualizar a Pro", href: "/chat", highlighted: true, badge: "Recomendado", usage: "3.000 créditos de IA al mes", features: ["Acceso a todos los modelos disponibles", "Comparar hasta 3 modelos lado a lado", "Archivos adjuntos y Google Drive", "Compartir y descargar conversaciones", "Créditos mensuales ponderados por modelo"] },
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
      { question: "Posso continuar usando o Tomverse de graça?", answer: "Sim. O Free é pensado para uso diário leve, com acesso a um catálogo de modelos selecionados dentro dos limites de uso." },
      { question: "Como funciona o desconto de lançamento?", answer: "A oferta de lançamento aplica 50% de desconto no Pro ou Max no primeiro mês. Depois disso, o plano renova pelo preço mensal regular, salvo cancelamento.", promotionOnly: true },
      { question: "O Pro limita quais modelos posso escolher?", answer: "O Pro foi pensado para liberar o catálogo de modelos disponível. Modelos de custo maior são gerenciados por limites de uso e custo, não por um bloqueio simples no seletor." },
    ],
    note: "Os preços são valores fixos antes de impostos na moeda de cobrança selecionada. No Max, modelos Standard não têm limite diário; o uso Premium está sujeito aos créditos mensais e à política de uso justo.",
    plans: [
      { name: "Free", eyebrow: "Para começar", price: "$0", period: "por mês", description: "300 créditos de IA por mês para uso diário leve e para testar modelos avançados.", cta: "Começar grátis", href: "/chat", usage: "300 créditos de IA por mês", features: ["Acesso ao catálogo de modelos selecionados", "Comparar até 3 modelos", "Histórico básico de chat", "Anexos, compartilhamento e downloads após login", "Bom para uso pessoal leve"] },
      { name: "Pro", eyebrow: "Produtividade diária", price: "$15", period: "por mês", description: "3.000 créditos de IA por mês para comparações multimodelo cotidianas.", cta: "Atualizar para Pro", href: "/chat", highlighted: true, badge: "Recomendado", usage: "3.000 créditos de IA por mês", features: ["Acesso a todos os modelos disponíveis", "Comparar até 3 modelos lado a lado", "Anexos e arquivos do Google Drive", "Compartilhar e baixar conversas", "Créditos mensais ponderados por modelo"] },
      { name: "Max", eyebrow: "Fluxos intensivos de IA", price: "$25", period: "por mês", description: "10.000 créditos de IA por mês para trabalho intensivo com modelos avançados e documentos longos.", cta: "Atualizar para Max", href: "/chat", usage: "10.000 créditos de IA por mês", features: ["Acesso aos níveis Free, Pro e Max", "Sem limite diário em modelos Standard", "O uso Premium segue os créditos mensais e o uso justo", "Limites maiores de anexos e contexto", "Para modelos avançados e documentos longos"] },
    ],
  },
};

export function PricingPageContent() {
  const { lang } = useLanguage();
  const content = copy[lang] ?? copy.en;
  const billing = usePublicBilling();
  const pricingViewTrackedRef = useRef(false);
  const annualCopy = annualLabelByLanguage[lang] ?? annualLabelByLanguage.en!;
  const saleCopy = saleLabelByLanguage[lang] ?? saleLabelByLanguage.en!;
  const promotionDetail =
    promotionDetailByLanguage[lang] ?? promotionDetailByLanguage.en!;
  const creditGuide = creditValueCopy[lang];
  const creditPackGuide = creditPackCopy[lang];
  const publicCreditPacks = billing.config?.creditPacks ?? [];
  const numberFormatter = new Intl.NumberFormat(promotionDateLocale[lang]);
  const creditPlans = ([
    { id: "free", name: "Free", fallbackCredits: 300 },
    { id: "pro", name: "Pro", fallbackCredits: 3_000 },
    { id: "max", name: "Max", fallbackCredits: 10_000 },
  ] as const).map((plan) => {
    const configuredCredits = billing.config?.plans.find(
      (configuredPlan) => configuredPlan.id === plan.id
    )?.monthlyMessageLimit;
    const monthlyCredits =
      typeof configuredCredits === "number" && configuredCredits > 0
        ? Math.floor(configuredCredits)
        : plan.fallbackCredits;
    return {
      ...plan,
      monthlyCredits,
      capacities: getTypicalShortRequestCapacities(monthlyCredits),
    };
  });
  const inputMultiplierBands = [
    { label: `≤ ${numberFormatter.format(16_000)}`, multiplier: 1 },
    ...INPUT_CREDIT_MULTIPLIERS.map((item) => ({
      label: `> ${numberFormatter.format(item.aboveTokens)}`,
      multiplier: item.multiplier,
    })),
  ];
  const featuredPromotion = billing.config?.featuredPromotion ?? null;

  useEffect(() => {
    if (pricingViewTrackedRef.current) return;
    pricingViewTrackedRef.current = true;
    trackProductEvent("pricing_view");
  }, []);
  const promotionEndDate = featuredPromotion
    ? new Intl.DateTimeFormat(promotionDateLocale[lang], {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "Australia/Brisbane",
      }).format(new Date(new Date(featuredPromotion.endsAt).getTime() - 1))
    : null;

  const formatSalePrice = (
    planId: "free" | "pro" | "max",
    fallbackUsd: number,
    discountPercent: number
  ) => {
    const plan = billing.config?.plans.find((item) => item.id === planId);
    const discountMultiplier = 1 - discountPercent / 100;
    if (plan?.displayCurrency && typeof plan.displayMonthlyPriceAmount === "number") {
      const digits = billingCurrencyFractionDigits(
        plan.displayCurrency as BillingCurrency
      );
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: plan.displayCurrency,
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      }).format(plan.displayMonthlyPriceAmount * discountMultiplier);
    }
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 1,
      minimumFractionDigits: 0,
    }).format(fallbackUsd * discountMultiplier);
  };

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader />

      <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <div className="mx-auto max-w-4xl text-center">
          <p className="text-sm font-black uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{content.eyebrow}</p>
          <h1 className="mt-4 text-4xl font-black leading-tight sm:text-6xl">{content.title}</h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-300">{content.description}</p>
          {featuredPromotion ? (
          <div className="mx-auto mt-6 max-w-3xl overflow-hidden rounded-3xl border border-emerald-400/40 bg-gradient-to-br from-emerald-400/15 via-blue-500/10 to-transparent p-1 text-left shadow-2xl shadow-emerald-950/10">
            <div className="rounded-[1.35rem] bg-white/80 px-5 py-4 backdrop-blur dark:bg-zinc-950/75">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <span className="inline-flex w-fit rounded-full bg-emerald-500 px-3 py-1 text-xs font-black uppercase tracking-[0.16em] text-white">
                    {saleCopy.badge}
                  </span>
                  <p className="mt-3 text-4xl font-black tracking-tight text-emerald-700 dark:text-emerald-200">
                    {featuredPromotion.discountPercent}% OFF
                  </p>
                </div>
                <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm font-black text-emerald-700 dark:text-emerald-200">
                  {saleCopy.duration}
                </div>
              </div>
              <p className="mt-3 text-sm font-bold text-zinc-700 dark:text-zinc-200">{content.billingNote}</p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs font-black text-zinc-700 dark:text-zinc-200">
                <span className="rounded-full bg-zinc-950 px-3 py-1.5 text-white dark:bg-white dark:text-zinc-950">
                  {promotionDetail.code}: {featuredPromotion.code}
                </span>
                <span className="rounded-full border border-zinc-300 px-3 py-1.5 dark:border-zinc-700">
                  {promotionDetail.eligibility}
                </span>
                <span className="rounded-full border border-zinc-300 px-3 py-1.5 dark:border-zinc-700">
                  {promotionDetail.ends}: {promotionEndDate} · {promotionDetail.timezone}
                </span>
              </div>
            </div>
          </div>
          ) : null}
        </div>

        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {content.plans.map((plan) => {
            const planId = plan.name === "Max" ? "max" : plan.name === "Pro" ? "pro" : "free";
            const displayPrice = billing.formatPlanPrice(planId) || plan.price;
            const annualFallback = planId === "max" ? "$240" : planId === "pro" ? "$144" : "$0";
            const annualPrice = billing.formatPlanPrice(planId, "annual") || annualFallback;
            const promotionEligible = Boolean(
              featuredPromotion &&
              featuredPromotion.appliesToPlanIds.includes(planId) &&
              featuredPromotion.billingIntervals.includes("monthly")
            );
            const salePrice = promotionEligible && featuredPromotion
              ? formatSalePrice(
                  planId,
                  planId === "max" ? 25 : 15,
                  featuredPromotion.discountPercent
                )
              : null;
            return (
            <article
              key={plan.name}
              className={`relative flex min-h-full flex-col rounded-[1.75rem] border p-6 shadow-sm ${
                plan.highlighted ? "border-blue-500 bg-blue-600 text-white shadow-2xl shadow-blue-950/20"
                  : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40"
              }`}
            >
              {promotionEligible && featuredPromotion ? (
                <div className={`absolute -top-4 right-6 rounded-full px-4 py-2 text-xs font-black shadow-xl ${
                  plan.highlighted
                    ? "bg-white text-blue-700 shadow-blue-950/20"
                    : "bg-emerald-500 text-white shadow-emerald-950/20"
                }`}>
                  {featuredPromotion.discountPercent}% OFF
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
              {planId === "free" || !promotionEligible ? (
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
                      {featuredPromotion?.discountPercent}% OFF
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
                    {annualCopy.checkout}
                  </p>
                </div>
              ) : null}
              <p className={`mt-3 text-sm font-black ${plan.highlighted ? "text-blue-50" : "text-zinc-700 dark:text-zinc-200"}`}>
                {plan.usage}
              </p>
              {planId === "free" ? (
                <Link
                  href={plan.href}
                  onClick={() =>
                    trackProductEvent("plan_selected", 0, {
                      plan_id: "free",
                      cta_location: "pricing_plan_card",
                    })
                  }
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

        <section
          data-testid="pricing-credit-packs"
          className="mt-16 overflow-hidden rounded-[2rem] border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 via-white to-blue-500/5 dark:via-zinc-950 dark:to-blue-950/20"
        >
          <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-[1fr_auto] lg:items-end">
            <div className="max-w-3xl">
              <p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">
                <Coins className="h-4 w-4" />
                {creditPackGuide.eyebrow}
              </p>
              <h2 className="mt-3 text-3xl font-black sm:text-4xl">{creditPackGuide.title}</h2>
              <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-300">
                {creditPackGuide.description}
              </p>
            </div>
            <Link
              href="/chat"
              onClick={() =>
                trackProductEvent("cta_start_click", 0, {
                  cta_location: "pricing_credit_pack_section",
                })
              }
              className="inline-flex h-11 items-center justify-center rounded-xl bg-emerald-600 px-5 text-sm font-black text-white transition hover:bg-emerald-500"
            >
              {creditPackGuide.purchaseCta}
            </Link>
          </div>

          <div className="grid gap-4 border-t border-emerald-500/20 p-5 sm:p-7 lg:grid-cols-3">
            {publicCreditPacks.length === 0 ? (
              <p className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 lg:col-span-3">
                {creditPackGuide.loading}
              </p>
            ) : (
              publicCreditPacks.map((pack) => (
                <article
                  key={pack.id}
                  data-pack-id={pack.id}
                  className="flex min-h-full flex-col rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/80"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-black">{creditPackGuide.packNames[pack.id]}</h3>
                      <p className="mt-2 text-xs font-black uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-300">
                        {creditPackGuide.availableFor}: {pack.allowedPlans.join(" / ")}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] font-black text-emerald-700 dark:text-emerald-300">
                      {creditPackGuide.oneTime}
                    </span>
                  </div>
                  <p className="mt-5 text-3xl font-black">
                    {numberFormatter.format(pack.credits)}{" "}
                    <span className="text-sm text-zinc-500 dark:text-zinc-400">{creditPackGuide.credits}</span>
                  </p>
                  <p className="mt-1 text-xl font-black text-emerald-700 dark:text-emerald-300">
                    {new Intl.NumberFormat(promotionDateLocale[lang], {
                      style: "currency",
                      currency: pack.currency,
                    }).format(
                      pack.priceMinor /
                        (pack.currency === "KRW" ? 1 : 100)
                    )}
                  </p>
                  <p className="mt-4 flex-1 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                    {creditPackGuide.packDescriptions[pack.id]}
                  </p>
                  <p className="mt-4 border-t border-zinc-200 pt-3 text-xs font-bold text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                    {creditPackGuide.validity}
                  </p>
                </article>
              ))
            )}
          </div>

          <div className="grid gap-5 border-t border-emerald-500/20 bg-white/60 p-5 dark:bg-zinc-950/40 sm:p-7 lg:grid-cols-[0.75fr_1.25fr]">
            <div>
              <h3 className="font-black">{creditPackGuide.policyTitle}</h3>
              <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-300">
                {creditPackGuide.guidance}
              </p>
            </div>
            <ul className="grid gap-3">
              {creditPackGuide.policies.map((policy) => (
                <li key={policy} className="flex gap-3 text-sm font-semibold leading-6 text-zinc-700 dark:text-zinc-200">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
                  {policy}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          data-testid="pricing-credit-guide"
          className="mt-10 overflow-hidden rounded-[2rem] border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40"
        >
          <div className="border-b border-zinc-200 p-5 dark:border-zinc-800 sm:p-7">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-blue-600 dark:text-blue-400">
                  <Calculator className="h-4 w-4" />
                  {creditGuide.eyebrow}
                </p>
                <h2 className="mt-3 text-3xl font-black sm:text-4xl">
                  {creditGuide.title}
                </h2>
                <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-300">
                  {creditGuide.description}
                </p>
              </div>
              <span className="w-fit rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs font-black text-emerald-700 dark:text-emerald-300">
                {creditGuide.typicalLabel}
              </span>
            </div>

            <div className="mt-5 flex flex-wrap gap-2 text-xs font-bold text-zinc-600 dark:text-zinc-300">
              <span className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-950">
                Standard · {MODEL_USAGE_CREDIT_WEIGHTS.standard} {creditGuide.creditUnit}
              </span>
              <span className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-950">
                Advanced · {MODEL_USAGE_CREDIT_WEIGHTS.advanced} {creditGuide.creditUnit}
              </span>
              <span className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-950">
                Premium · {MODEL_USAGE_CREDIT_WEIGHTS.premium} {creditGuide.creditUnit}
              </span>
            </div>
          </div>

          <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-3">
            {creditPlans.map((plan) => {
              const examples = [
                {
                  label: creditGuide.standardOnly,
                  cost: MODEL_USAGE_CREDIT_WEIGHTS.standard,
                  value: plan.capacities.standardResponses,
                  unit: creditGuide.responseUnit,
                },
                {
                  label: creditGuide.advancedOnly,
                  cost: MODEL_USAGE_CREDIT_WEIGHTS.advanced,
                  value: plan.capacities.advancedResponses,
                  unit: creditGuide.responseUnit,
                },
                {
                  label: creditGuide.mixedComparison,
                  cost: plan.capacities.mixedComparisonCredits,
                  value: plan.capacities.mixedComparisons,
                  unit: creditGuide.comparisonUnit,
                },
              ];

              return (
                <article
                  key={plan.id}
                  className={`rounded-2xl border p-5 ${
                    plan.id === "pro"
                      ? "border-blue-500 bg-blue-600 text-white shadow-xl shadow-blue-950/15"
                      : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-2xl font-black">{plan.name}</h3>
                      <p
                        className={`mt-1 text-xs font-bold ${
                          plan.id === "pro"
                            ? "text-blue-100"
                            : "text-zinc-500 dark:text-zinc-400"
                        }`}
                      >
                        {numberFormatter.format(plan.monthlyCredits)} {creditGuide.monthlyUnit}
                      </p>
                    </div>
                    <MessageSquare className={`h-6 w-6 ${plan.id === "pro" ? "text-white" : "text-blue-600 dark:text-blue-400"}`} />
                  </div>

                  <div className="mt-5 divide-y divide-zinc-200/80 dark:divide-zinc-800">
                    {examples.map((example) => (
                      <div key={example.label} className="py-3 first:pt-0 last:pb-0">
                        <div className="flex items-start justify-between gap-3">
                          <p className="text-xs font-bold leading-5">{example.label}</p>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black ${
                              plan.id === "pro"
                                ? "bg-white/15 text-white"
                                : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-300"
                            }`}
                          >
                            {example.cost} {creditGuide.creditUnit}
                          </span>
                        </div>
                        <p className="mt-2 text-xl font-black">
                          {creditGuide.approx} {numberFormatter.format(example.value)} {example.unit}
                        </p>
                      </div>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>

          <div className="grid gap-4 border-t border-zinc-200 p-4 dark:border-zinc-800 sm:p-6 lg:grid-cols-2">
            <article className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-5">
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                <FileText className="h-5 w-5" />
                <h3 className="font-black">{creditGuide.longContextTitle}</h3>
              </div>
              <p className="mt-3 text-xs leading-6 text-zinc-600 dark:text-zinc-300">
                {creditGuide.longContextBody}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {inputMultiplierBands.map((band) => (
                  <span
                    key={band.label}
                    className="rounded-full border border-amber-500/20 bg-white/70 px-3 py-1.5 text-[11px] font-black text-amber-900 dark:bg-zinc-950/60 dark:text-amber-200"
                  >
                    {band.label} {creditGuide.tokenUnit} · {band.multiplier}×
                  </span>
                ))}
              </div>
            </article>

            <article className="rounded-2xl border border-blue-500/25 bg-blue-500/10 p-5">
              <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
                <Info className="h-5 w-5" />
                <h3 className="font-black">{creditGuide.preflightTitle}</h3>
              </div>
              <p className="mt-3 text-xs leading-6 text-zinc-600 dark:text-zinc-300">
                {creditGuide.preflightBody}
              </p>
              <Link
                href="/chat"
                className="mt-4 inline-flex h-10 items-center justify-center rounded-xl bg-blue-600 px-4 text-xs font-black text-white transition hover:bg-blue-500"
              >
                {creditGuide.preflightCta}
              </Link>
            </article>
          </div>

          <div className="border-t border-zinc-200 px-5 py-4 text-xs font-semibold leading-6 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {creditGuide.disclaimer}
          </div>
        </section>

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
            {content.faqs
              .filter((faq) => !faq.promotionOnly || featuredPromotion)
              .map((faq) => (
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
