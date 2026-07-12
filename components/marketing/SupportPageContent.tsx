"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  LifeBuoy,
  Mail,
  MessageSquareText,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { useTurnstile } from "@/components/chat/useTurnstile";
import { dispatchAppToast } from "@/lib/appToast";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";

type SupportCopy = {
  eyebrow: string;
  title: string;
  description: string;
  emailLabel: string;
  emailValue: string;
  responseLabel: string;
  responseValue: string;
  noPhoneLabel: string;
  noPhoneValue: string;
  cards: { title: string; body: string; bullets: string[] }[];
  formTitle: string;
  formDescription: string;
  typeLabel: string;
  types: Record<"support" | "bug" | "billing" | "feature" | "other", string>;
  emailInput: string;
  traceInput: string;
  messageInput: string;
  submit: string;
  sending: string;
  success: string;
  failed: string;
  helpCta: string;
  appCta: string;
};

const copy: Record<Language, SupportCopy> = {
  en: {
    eyebrow: "Support",
    title: "How can we help?",
    description:
      "Use the support form for account, billing, model, file, and product issues. We do not offer phone support, so every request is handled in writing with the context needed to investigate.",
    emailLabel: "Support email",
    emailValue: "support@tomverse.app",
    responseLabel: "Typical response",
    responseValue: "1-2 business days",
    noPhoneLabel: "Support channel",
    noPhoneValue: "Email and form only",
    cards: [
      {
        title: "Account and billing",
        body: "Get help with login, plan changes, cancellation, refund requests, and Stripe checkout questions.",
        bullets: ["Include your account email", "Mention the plan involved", "Add the checkout or refund time if known"],
      },
      {
        title: "Model and file issues",
        body: "Report model availability, empty responses, unsupported files, PDF issues, and attachment errors.",
        bullets: ["Attach trace ID when shown", "Include model name", "Tell us the file type and approximate size"],
      },
      {
        title: "Product feedback",
        body: "Send workflow friction, feature requests, translation issues, and usability feedback directly to the team.",
        bullets: ["Tell us the page or device", "Describe expected behavior", "Share screenshots when helpful"],
      },
    ],
    formTitle: "Contact support",
    formDescription:
      "This goes directly into the Tomverse support inbox with browser and page context when available.",
    typeLabel: "Request type",
    types: {
      support: "General support",
      bug: "Problem or bug",
      billing: "Billing",
      feature: "Feature request",
      other: "Other",
    },
    emailInput: "Email address",
    traceInput: "Trace ID or reference number, optional",
    messageInput: "Tell us what happened and what you expected.",
    submit: "Send request",
    sending: "Sending...",
    success: "Support request sent.",
    failed: "Could not send support request.",
    helpCta: "Open Help Centre",
    appCta: "Open app",
  },
  ko: {
    eyebrow: "지원",
    title: "무엇을 도와드릴까요?",
    description:
      "계정, 결제, 모델, 파일, 제품 사용 문제는 지원 폼으로 문의해주세요. 전화 상담은 제공하지 않으며, 모든 요청은 확인에 필요한 맥락과 함께 서면으로 처리됩니다.",
    emailLabel: "지원 이메일",
    emailValue: "support@tomverse.app",
    responseLabel: "일반 응답 시간",
    responseValue: "영업일 기준 1-2일",
    noPhoneLabel: "지원 채널",
    noPhoneValue: "이메일 및 폼 접수",
    cards: [
      {
        title: "계정 및 결제",
        body: "로그인, 플랜 변경, 구독 취소, 환불 요청, Stripe 결제 관련 문의를 도와드립니다.",
        bullets: ["계정 이메일을 포함해주세요", "관련 플랜을 알려주세요", "결제 또는 환불 요청 시간을 함께 적어주세요"],
      },
      {
        title: "모델 및 파일 문제",
        body: "모델 사용 가능 여부, 빈 응답, 지원되지 않는 파일, PDF 문제, 첨부 오류를 접수할 수 있습니다.",
        bullets: ["표시된 추적 ID를 포함해주세요", "모델명을 알려주세요", "파일 형식과 대략적인 크기를 적어주세요"],
      },
      {
        title: "제품 피드백",
        body: "워크플로 불편, 기능 제안, 번역 문제, 사용성 피드백을 팀에 바로 전달할 수 있습니다.",
        bullets: ["페이지 또는 기기를 알려주세요", "기대한 동작을 설명해주세요", "필요하면 스크린샷을 함께 보내주세요"],
      },
    ],
    formTitle: "지원팀에 문의",
    formDescription:
      "제출된 내용은 가능한 경우 브라우저와 페이지 맥락과 함께 Tomverse 지원 인박스로 전달됩니다.",
    typeLabel: "문의 유형",
    types: {
      support: "일반 지원",
      bug: "문제 또는 버그",
      billing: "결제",
      feature: "기능 제안",
      other: "기타",
    },
    emailInput: "이메일 주소",
    traceInput: "추적 ID 또는 참고 번호, 선택 사항",
    messageInput: "무슨 일이 있었고 어떤 결과를 기대했는지 알려주세요.",
    submit: "문의 보내기",
    sending: "전송 중...",
    success: "지원 요청이 접수되었습니다.",
    failed: "지원 요청을 전송하지 못했습니다.",
    helpCta: "Help Centre 열기",
    appCta: "앱 열기",
  },
  zh: {
    eyebrow: "支持",
    title: "我们可以怎样帮您？",
    description:
      "账户、账单、模型、文件和产品问题都可以通过支持表单提交。我们不提供电话支持，所有请求都会以书面方式处理，并尽量包含排查所需的上下文。",
    emailLabel: "支持邮箱",
    emailValue: "support@tomverse.app",
    responseLabel: "通常回复时间",
    responseValue: "1-2 个工作日",
    noPhoneLabel: "支持渠道",
    noPhoneValue: "仅限邮箱和表单",
    cards: [
      {
        title: "账户和账单",
        body: "获取登录、套餐变更、取消订阅、退款请求和 Stripe 结账相关帮助。",
        bullets: ["请包含账户邮箱", "说明相关套餐", "如知道，请提供结账或退款时间"],
      },
      {
        title: "模型和文件问题",
        body: "报告模型可用性、空回复、不支持的文件、PDF 问题和附件错误。",
        bullets: ["如有追踪 ID 请提供", "包含模型名称", "说明文件类型和大致大小"],
      },
      {
        title: "产品反馈",
        body: "将工作流摩擦、功能建议、翻译问题和可用性反馈直接发送给团队。",
        bullets: ["说明页面或设备", "描述预期行为", "必要时提供截图"],
      },
    ],
    formTitle: "联系支持",
    formDescription: "请求会进入 Tomverse 支持收件箱，并在可用时附带浏览器和页面上下文。",
    typeLabel: "请求类型",
    types: {
      support: "一般支持",
      bug: "问题或错误",
      billing: "账单",
      feature: "功能建议",
      other: "其他",
    },
    emailInput: "邮箱地址",
    traceInput: "追踪 ID 或参考编号，可选",
    messageInput: "请说明发生了什么，以及您期望的结果。",
    submit: "发送请求",
    sending: "正在发送...",
    success: "支持请求已发送。",
    failed: "无法发送支持请求。",
    helpCta: "打开 Help Centre",
    appCta: "打开应用",
  },
  fr: {
    eyebrow: "Support",
    title: "Comment pouvons-nous vous aider ?",
    description:
      "Utilisez le formulaire pour les questions de compte, facturation, modèles, fichiers et produit. Nous ne proposons pas de support téléphonique ; chaque demande est traitée par écrit avec le contexte nécessaire.",
    emailLabel: "Email de support",
    emailValue: "support@tomverse.app",
    responseLabel: "Délai habituel",
    responseValue: "1 à 2 jours ouvrés",
    noPhoneLabel: "Canal de support",
    noPhoneValue: "Email et formulaire",
    cards: [
      {
        title: "Compte et facturation",
        body: "Aide pour la connexion, les changements d'offre, l'annulation, les remboursements et le paiement Stripe.",
        bullets: ["Indiquez l'email du compte", "Mentionnez l'offre concernée", "Ajoutez l'heure du paiement ou de la demande si possible"],
      },
      {
        title: "Modèles et fichiers",
        body: "Signalez disponibilité des modèles, réponses vides, fichiers non pris en charge, PDF et erreurs de pièces jointes.",
        bullets: ["Ajoutez le trace ID affiché", "Indiquez le modèle", "Précisez le type et la taille du fichier"],
      },
      {
        title: "Retour produit",
        body: "Envoyez frictions de workflow, demandes de fonctionnalités, problèmes de traduction et retours d'usage.",
        bullets: ["Indiquez la page ou l'appareil", "Décrivez le comportement attendu", "Ajoutez une capture si utile"],
      },
    ],
    formTitle: "Contacter le support",
    formDescription: "Votre demande arrive dans la boîte support Tomverse avec le contexte de page disponible.",
    typeLabel: "Type de demande",
    types: {
      support: "Support général",
      bug: "Problème ou bug",
      billing: "Facturation",
      feature: "Demande de fonctionnalité",
      other: "Autre",
    },
    emailInput: "Adresse email",
    traceInput: "Trace ID ou référence, optionnel",
    messageInput: "Expliquez ce qui s'est passé et le résultat attendu.",
    submit: "Envoyer",
    sending: "Envoi...",
    success: "Demande envoyée.",
    failed: "Impossible d'envoyer la demande.",
    helpCta: "Ouvrir le Help Centre",
    appCta: "Ouvrir l'app",
  },
  de: {
    eyebrow: "Support",
    title: "Wie können wir helfen?",
    description:
      "Nutzen Sie das Formular für Konto-, Zahlungs-, Modell-, Datei- und Produktfragen. Telefon-Support bieten wir nicht an; jede Anfrage wird schriftlich mit dem nötigen Kontext bearbeitet.",
    emailLabel: "Support-E-Mail",
    emailValue: "support@tomverse.app",
    responseLabel: "Übliche Antwortzeit",
    responseValue: "1-2 Werktage",
    noPhoneLabel: "Support-Kanal",
    noPhoneValue: "E-Mail und Formular",
    cards: [
      {
        title: "Konto und Zahlung",
        body: "Hilfe bei Login, Planwechsel, Kündigung, Rückerstattung und Stripe-Checkout.",
        bullets: ["Kontoe-Mail angeben", "Betroffenen Plan nennen", "Zahlungs- oder Erstattungszeit hinzufügen"],
      },
      {
        title: "Modelle und Dateien",
        body: "Melden Sie Modellverfügbarkeit, leere Antworten, nicht unterstützte Dateien, PDF-Probleme und Anhangfehler.",
        bullets: ["Trace ID angeben, falls sichtbar", "Modellnamen nennen", "Dateityp und ungefähre Größe angeben"],
      },
      {
        title: "Produktfeedback",
        body: "Senden Sie Workflow-Probleme, Feature-Wünsche, Übersetzungsfehler und Usability-Feedback direkt an das Team.",
        bullets: ["Seite oder Gerät nennen", "Erwartetes Verhalten beschreiben", "Screenshots bei Bedarf beifügen"],
      },
    ],
    formTitle: "Support kontaktieren",
    formDescription: "Die Anfrage landet im Tomverse Support-Inbox, wenn möglich mit Browser- und Seitenkontext.",
    typeLabel: "Anfragetyp",
    types: {
      support: "Allgemeiner Support",
      bug: "Problem oder Fehler",
      billing: "Abrechnung",
      feature: "Feature-Wunsch",
      other: "Sonstiges",
    },
    emailInput: "E-Mail-Adresse",
    traceInput: "Trace ID oder Referenz, optional",
    messageInput: "Beschreiben Sie, was passiert ist und was Sie erwartet haben.",
    submit: "Anfrage senden",
    sending: "Senden...",
    success: "Support-Anfrage gesendet.",
    failed: "Support-Anfrage konnte nicht gesendet werden.",
    helpCta: "Help Centre öffnen",
    appCta: "App öffnen",
  },
  es: {
    eyebrow: "Soporte",
    title: "¿Cómo podemos ayudarte?",
    description:
      "Usa el formulario para problemas de cuenta, facturación, modelos, archivos y producto. No ofrecemos soporte telefónico; todas las solicitudes se atienden por escrito con contexto para investigar.",
    emailLabel: "Email de soporte",
    emailValue: "support@tomverse.app",
    responseLabel: "Respuesta habitual",
    responseValue: "1-2 días laborables",
    noPhoneLabel: "Canal de soporte",
    noPhoneValue: "Email y formulario",
    cards: [
      {
        title: "Cuenta y facturación",
        body: "Ayuda con inicio de sesión, cambios de plan, cancelación, reembolsos y Stripe Checkout.",
        bullets: ["Incluye el email de la cuenta", "Menciona el plan", "Añade la hora de pago o reembolso si la conoces"],
      },
      {
        title: "Modelos y archivos",
        body: "Reporta disponibilidad de modelos, respuestas vacías, archivos no compatibles, PDFs y errores de adjuntos.",
        bullets: ["Incluye el trace ID si aparece", "Indica el modelo", "Dinos el tipo y tamaño aproximado del archivo"],
      },
      {
        title: "Feedback de producto",
        body: "Envía fricciones, solicitudes de funciones, problemas de traducción y comentarios de usabilidad.",
        bullets: ["Indica página o dispositivo", "Describe el comportamiento esperado", "Comparte capturas si ayudan"],
      },
    ],
    formTitle: "Contactar soporte",
    formDescription: "La solicitud entra en la bandeja de soporte de Tomverse con contexto de navegador y página si está disponible.",
    typeLabel: "Tipo de solicitud",
    types: {
      support: "Soporte general",
      bug: "Problema o bug",
      billing: "Facturación",
      feature: "Solicitud de función",
      other: "Otro",
    },
    emailInput: "Correo electrónico",
    traceInput: "Trace ID o referencia, opcional",
    messageInput: "Cuéntanos qué pasó y qué esperabas.",
    submit: "Enviar solicitud",
    sending: "Enviando...",
    success: "Solicitud enviada.",
    failed: "No se pudo enviar la solicitud.",
    helpCta: "Abrir Help Centre",
    appCta: "Abrir app",
  },
  pt: {
    eyebrow: "Suporte",
    title: "Como podemos ajudar?",
    description:
      "Use o formulário para questões de conta, cobrança, modelos, arquivos e produto. Não oferecemos suporte por telefone; todas as solicitações são tratadas por escrito com contexto para investigação.",
    emailLabel: "Email de suporte",
    emailValue: "support@tomverse.app",
    responseLabel: "Resposta típica",
    responseValue: "1-2 dias úteis",
    noPhoneLabel: "Canal de suporte",
    noPhoneValue: "Email e formulário",
    cards: [
      {
        title: "Conta e cobrança",
        body: "Ajuda com login, mudanças de plano, cancelamento, reembolso e Stripe Checkout.",
        bullets: ["Inclua o email da conta", "Informe o plano envolvido", "Adicione o horário do pagamento ou reembolso se souber"],
      },
      {
        title: "Modelos e arquivos",
        body: "Reporte disponibilidade de modelos, respostas vazias, arquivos não suportados, PDFs e erros de anexos.",
        bullets: ["Inclua o trace ID quando aparecer", "Informe o modelo", "Diga o tipo e tamanho aproximado do arquivo"],
      },
      {
        title: "Feedback do produto",
        body: "Envie dificuldades de fluxo, pedidos de recursos, problemas de tradução e feedback de usabilidade.",
        bullets: ["Informe a página ou dispositivo", "Descreva o comportamento esperado", "Compartilhe capturas se ajudar"],
      },
    ],
    formTitle: "Contactar suporte",
    formDescription: "A solicitação entra na caixa de suporte Tomverse com contexto do navegador e da página quando disponível.",
    typeLabel: "Tipo de solicitação",
    types: {
      support: "Suporte geral",
      bug: "Problema ou bug",
      billing: "Cobrança",
      feature: "Pedido de recurso",
      other: "Outro",
    },
    emailInput: "Endereço de email",
    traceInput: "Trace ID ou referência, opcional",
    messageInput: "Conte o que aconteceu e o que esperava.",
    submit: "Enviar solicitação",
    sending: "Enviando...",
    success: "Solicitação enviada.",
    failed: "Não foi possível enviar a solicitação.",
    helpCta: "Abrir Help Centre",
    appCta: "Abrir app",
  },
};

export function SupportPageContent() {
  const { lang } = useLanguage();
  const { status } = useSession();
  const page = copy[lang] ?? copy.en;
  const [type, setType] = useState<keyof SupportCopy["types"]>("support");
  const [email, setEmail] = useState("");
  const [traceId, setTraceId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const isGuestRequest = status === "unauthenticated";
  const {
    containerRef: turnstileContainerRef,
    getToken: getTurnstileToken,
  } = useTurnstile(isGuestRequest, "support_request");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || message.trim().length < 5 || !email.trim()) return;
    setBusy(true);
    try {
      const turnstileToken = isGuestRequest
        ? await getTurnstileToken()
        : undefined;
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          email,
          message,
          traceId: traceId || undefined,
          path: typeof window !== "undefined" ? window.location.pathname : "/support",
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
          ...(turnstileToken ? { turnstileToken } : {}),
        }),
      });
      if (!response.ok) throw new Error(`Support request failed: ${response.status}`);
      setTraceId("");
      setMessage("");
      dispatchAppToast(page.success, "success");
    } catch {
      dispatchAppToast(page.failed, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader maxWidth="max-w-6xl" />

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:py-20">
        <div className="max-w-3xl">
          <p className="text-sm font-black uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">
            {page.eyebrow}
          </p>
          <h1 className="mt-4 text-4xl font-black leading-tight sm:text-6xl">{page.title}</h1>
          <p className="mt-5 text-lg leading-8 text-zinc-600 dark:text-zinc-300">{page.description}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/support/help-centre" className="inline-flex h-12 items-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-black text-white transition hover:bg-blue-500">
              {page.helpCta}
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/chat" className="inline-flex h-12 items-center gap-2 rounded-xl border border-zinc-300 px-5 text-sm font-black transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
              {page.appCta}
            </Link>
          </div>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-3">
          {[
            [Mail, page.emailLabel, page.emailValue],
            [Clock3, page.responseLabel, page.responseValue],
            [MessageSquareText, page.noPhoneLabel, page.noPhoneValue],
          ].map(([Icon, label, value]) => {
            const IconComponent = Icon as typeof Mail;
            return (
              <div key={label as string} className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
                <IconComponent className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                <p className="mt-3 text-xs font-black uppercase tracking-[0.16em] text-zinc-500">{label as string}</p>
                <p className="mt-1 text-sm font-black">{value as string}</p>
              </div>
            );
          })}
        </div>

        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {page.cards.map((card) => (
            <article key={card.title} className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/40">
              <ShieldCheck className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              <h2 className="mt-4 text-xl font-black">{card.title}</h2>
              <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-300">{card.body}</p>
              <ul className="mt-5 grid gap-3">
                {card.bullets.map((bullet) => (
                  <li key={bullet} className="flex gap-3 text-sm font-semibold leading-6 text-zinc-700 dark:text-zinc-200">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
                    {bullet}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="mt-12 grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
          <div className="rounded-3xl border border-zinc-200 bg-zinc-50 p-6 dark:border-zinc-800 dark:bg-zinc-900/40">
            <LifeBuoy className="h-6 w-6 text-blue-600 dark:text-blue-400" />
            <h2 className="mt-4 text-2xl font-black">{page.formTitle}</h2>
            <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-300">{page.formDescription}</p>
          </div>

          <form onSubmit={submit} className="rounded-3xl border border-zinc-200 bg-zinc-50 p-5 shadow-2xl shadow-zinc-950/5 dark:border-zinc-800 dark:bg-zinc-900/50">
            <label className="mt-6 block text-sm font-black">
              {page.typeLabel}
              <select
                value={type}
                onChange={(event) => setType(event.target.value as keyof SupportCopy["types"])}
                className="mt-2 h-12 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-950"
              >
                {(Object.keys(page.types) as Array<keyof SupportCopy["types"]>).map((key) => (
                  <option key={key} value={key}>
                    {page.types[key]}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-4 block text-sm font-black">
              {page.emailInput}
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-2 h-12 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-950"
              />
            </label>
            <label className="mt-4 block text-sm font-black">
              {page.traceInput}
              <input
                value={traceId}
                onChange={(event) => setTraceId(event.target.value)}
                className="mt-2 h-12 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-950"
              />
            </label>
            <label className="mt-4 block text-sm font-black">
              {page.messageInput}
              <textarea
                required
                minLength={5}
                maxLength={2000}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={6}
                className="mt-2 w-full resize-none rounded-xl border border-zinc-200 bg-white p-3 text-sm leading-6 outline-none transition focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-950"
              />
              </label>
            <div ref={turnstileContainerRef} className="hidden" />
            <button
              type="submit"
              disabled={busy || message.trim().length < 5 || !email.trim()}
              className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 text-sm font-black text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              {busy ? page.sending : page.submit}
            </button>
          </form>
        </div>
      </section>

      <MarketingFooter maxWidth="max-w-6xl" />
    </main>
  );
}
