"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
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
import { TurnstileFormSlot } from "@/components/chat/TurnstileFormSlot";
import { guestVerificationFailureKey } from "@/components/chat/guestVerificationCopy";
import {
  isGuestVerificationError,
  type GuestVerificationFailure,
} from "@/components/chat/guestVerificationFailure";
import { dispatchAppToast } from "@/lib/appToast";
import { submitFeedback } from "@/lib/feedbackClient";
import { REVIEW_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";
import {
  feedbackFailureCopyKey,
  feedbackMessageState,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_MESSAGE_MIN_LENGTH,
} from "@/lib/feedbackPolicy";
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
  emailUpdatesLabel: string;
  emailUpdatesNote: string;
  traceInput: string;
  messageInput: string;
  messageExample: string;
  submit: string;
  sending: string;
  success: string;
  failed: string;
  helpCta: string;
  appCta: string;
};

const copy: Record<Language, SupportCopy> = {
  "en": {
    "eyebrow": "Support",
    "title": "How can we help?",
    "description": "Tell us if you need help with sign-in, billing, model answers or files. Use the form below or email us with the details needed to investigate. Support is provided by form and email; typical response times are listed below.",
    "emailLabel": "Support email",
    "emailValue": "support@tomverse.app",
    "responseLabel": "Typical response",
    "responseValue": "1-2 business days",
    "noPhoneLabel": "Support channel",
    "noPhoneValue": "Email and form only",
    "cards": [
      {
        "title": "Account and billing",
        "body": "Get help with login, plan changes, cancellation, refund requests, and Stripe checkout questions.",
        "bullets": [
          "Include your account email",
          "Mention the plan involved",
          "Add the checkout or refund time if known"
        ]
      },
      {
        "title": "Model and file issues",
        "body": "Report model availability, empty responses, unsupported files, PDF issues, and attachment errors.",
        "bullets": [
          "Attach trace ID when shown",
          "Include model name",
          "Tell us the file type and approximate size"
        ]
      },
      {
        "title": "Product feedback",
        "body": "Tell us what was difficult to use, what feature you need or where a translation is wrong. Include the page and what you were trying to do.",
        "bullets": [
          "Tell us the page or device",
          "Describe expected behavior",
          "Share screenshots when helpful"
        ]
      }
    ],
    "formTitle": "Contact support",
    "formDescription": "Your request goes to the support team. If you choose email updates, the receipt reference and progress updates go to that address.",
    "typeLabel": "Request type",
    "types": {
      "support": "General support",
      "bug": "Problem or bug",
      "billing": "Billing",
      "feature": "Feature request",
      "other": "Other"
    },
    "emailInput": "Email address",
    "emailUpdatesLabel": "Email me status updates for this request",
    "emailUpdatesNote": "A receipt and status updates will go to this address. Uncheck to receive no status emails.",
    "traceInput": "Trace ID or reference number, optional",
    "messageInput": "Tell us what happened and what you expected.",
    "submit": "Send request",
    "sending": "Sending...",
    "success": "Support request sent.",
    "failed": "Could not send support request.",
    "helpCta": "View Help Centre",
    "appCta": "Open Review",
    "messageExample": "Example: No answer appeared after I attached a PDF in Review. Include the approximate time, model, file type and size, and the on-screen trace ID. Do not send passwords or card numbers."
  },
  "ko": {
    "eyebrow": "지원",
    "title": "무엇을 도와드릴까요?",
    "description": "로그인, 결제, 모델 답변이나 파일 사용 중 문제가 생겼다면 알려주세요. 아래 폼이나 이메일로 문의하면 확인에 필요한 내용을 함께 살펴봅니다. 지원은 이메일과 폼으로 제공하며, 일반적인 응답 시간은 아래에서 확인할 수 있습니다.",
    "emailLabel": "지원 이메일",
    "emailValue": "support@tomverse.app",
    "responseLabel": "일반 응답 시간",
    "responseValue": "영업일 기준 1-2일",
    "noPhoneLabel": "지원 채널",
    "noPhoneValue": "이메일 및 폼 접수",
    "cards": [
      {
        "title": "계정 및 결제",
        "body": "로그인, 플랜 변경, 구독 취소, 환불 요청, Stripe 결제 관련 문의를 도와드립니다.",
        "bullets": [
          "계정 이메일을 포함해주세요",
          "관련 플랜을 알려주세요",
          "결제 또는 환불 요청 시간을 함께 적어주세요"
        ]
      },
      {
        "title": "모델 및 파일 문제",
        "body": "모델 사용 가능 여부, 빈 응답, 지원되지 않는 파일, PDF 문제, 첨부 오류를 접수할 수 있습니다.",
        "bullets": [
          "표시된 추적 ID를 포함해주세요",
          "모델명을 알려주세요",
          "파일 형식과 대략적인 크기를 적어주세요"
        ]
      },
      {
        "title": "제품 피드백",
        "body": "사용 중 불편했던 점, 필요한 기능이나 번역 오류를 알려주세요. 어떤 화면에서 무엇을 하려 했는지 함께 적으면 개선할 부분을 확인하는 데 도움이 됩니다.",
        "bullets": [
          "페이지 또는 기기를 알려주세요",
          "기대한 동작을 설명해주세요",
          "필요하면 스크린샷을 함께 보내주세요"
        ]
      }
    ],
    "formTitle": "지원팀에 문의",
    "formDescription": "문의 내용을 보내면 지원팀이 확인합니다. 이메일 상태 안내를 선택하면 접수 번호와 진행 안내를 해당 주소로 받을 수 있습니다.",
    "typeLabel": "문의 유형",
    "types": {
      "support": "일반 지원",
      "bug": "문제 또는 버그",
      "billing": "결제",
      "feature": "기능 제안",
      "other": "기타"
    },
    "emailInput": "이메일 주소",
    "emailUpdatesLabel": "이 문의의 처리 상태를 이메일로 받기",
    "emailUpdatesNote": "접수 및 처리 상태 안내가 이 주소로 발송됩니다. 원치 않으면 선택을 해제하세요.",
    "traceInput": "추적 ID 또는 참고 번호, 선택 사항",
    "messageInput": "무슨 일이 있었고 어떤 결과를 기대했는지 알려주세요.",
    "submit": "문의 보내기",
    "sending": "전송 중...",
    "success": "지원 요청이 접수되었습니다.",
    "failed": "지원 요청을 전송하지 못했습니다.",
    "helpCta": "도움말 센터 보기",
    "appCta": "Review 열기",
    "messageExample": "예: Review에서 PDF를 첨부한 뒤 답변이 나오지 않았습니다. 발생 시간, 모델명, 파일 형식·크기와 화면의 추적 ID를 함께 적어주세요. 비밀번호나 카드번호는 보내지 마세요."
  },
  "zh": {
    "eyebrow": "支持",
    "title": "我们可以怎样帮您？",
    "description": "登录、付款、模型回答或文件使用遇到问题时，请告诉我们。通过下方表单或电子邮件提交问题，并提供排查所需信息。支持通过表单和邮件提供，通常回复时间见下方。",
    "emailLabel": "支持邮箱",
    "emailValue": "support@tomverse.app",
    "responseLabel": "通常回复时间",
    "responseValue": "1-2 个工作日",
    "noPhoneLabel": "支持渠道",
    "noPhoneValue": "仅限邮箱和表单",
    "cards": [
      {
        "title": "账户和账单",
        "body": "获取登录、套餐变更、取消订阅、退款请求和 Stripe 结账相关帮助。",
        "bullets": [
          "请包含账户邮箱",
          "说明相关套餐",
          "如知道，请提供结账或退款时间"
        ]
      },
      {
        "title": "模型和文件问题",
        "body": "报告模型可用性、空回复、不支持的文件、PDF 问题和附件错误。",
        "bullets": [
          "如有追踪 ID 请提供",
          "包含模型名称",
          "说明文件类型和大致大小"
        ]
      },
      {
        "title": "产品反馈",
        "body": "请告诉我们使用中的困难、需要的功能或翻译错误，并说明所在页面与想完成的操作。",
        "bullets": [
          "说明页面或设备",
          "描述预期行为",
          "必要时提供截图"
        ]
      }
    ],
    "formTitle": "联系支持",
    "formDescription": "提交后由支持团队处理。选择邮件状态更新后，该邮箱会收到受理编号和进度说明。",
    "typeLabel": "请求类型",
    "types": {
      "support": "一般支持",
      "bug": "问题或错误",
      "billing": "账单",
      "feature": "功能建议",
      "other": "其他"
    },
    "emailInput": "邮箱地址",
    "emailUpdatesLabel": "通过电子邮件接收此请求的处理状态",
    "emailUpdatesNote": "受理回执和处理状态会发送到此邮箱。不需要时请取消勾选。",
    "traceInput": "追踪 ID 或参考编号，可选",
    "messageInput": "请说明发生了什么，以及您期望的结果。",
    "submit": "发送请求",
    "sending": "正在发送...",
    "success": "支持请求已发送。",
    "failed": "无法发送支持请求。",
    "helpCta": "查看帮助中心",
    "appCta": "打开 Review",
    "messageExample": "例如：在 Review 附加 PDF 后没有收到回答。请提供大致时间、模型、文件格式与大小以及屏幕追踪ID。不要发送密码或银行卡号。"
  },
  "fr": {
    "eyebrow": "Support",
    "title": "Comment pouvons-nous vous aider ?",
    "description": "Besoin d’aide pour la connexion, la facturation, les réponses ou les fichiers ? Utilisez le formulaire ou écrivez-nous avec les informations utiles. L’assistance est assurée par formulaire et e-mail ; le délai habituel figure ci-dessous.",
    "emailLabel": "Email de support",
    "emailValue": "support@tomverse.app",
    "responseLabel": "Délai habituel",
    "responseValue": "1 à 2 jours ouvrés",
    "noPhoneLabel": "Canal de support",
    "noPhoneValue": "Email et formulaire",
    "cards": [
      {
        "title": "Compte et facturation",
        "body": "Aide pour la connexion, les changements d'offre, l'annulation, les remboursements et le paiement Stripe.",
        "bullets": [
          "Indiquez l'email du compte",
          "Mentionnez l'offre concernée",
          "Ajoutez l'heure du paiement ou de la demande si possible"
        ]
      },
      {
        "title": "Modèles et fichiers",
        "body": "Signalez disponibilité des modèles, réponses vides, fichiers non pris en charge, PDF et erreurs de pièces jointes.",
        "bullets": [
          "Ajoutez le trace ID affiché",
          "Indiquez le modèle",
          "Précisez le type et la taille du fichier"
        ]
      },
      {
        "title": "Retour produit",
        "body": "Signalez une difficulté, une fonction souhaitée ou une erreur de traduction. Précisez la page et ce que vous vouliez faire.",
        "bullets": [
          "Indiquez la page ou l'appareil",
          "Décrivez le comportement attendu",
          "Ajoutez une capture si utile"
        ]
      }
    ],
    "formTitle": "Contacter le support",
    "formDescription": "Votre demande est transmise à l’assistance. Si vous choisissez le suivi par e-mail, la référence et les mises à jour sont envoyées à cette adresse.",
    "typeLabel": "Type de demande",
    "types": {
      "support": "Support général",
      "bug": "Problème ou bug",
      "billing": "Facturation",
      "feature": "Demande de fonctionnalité",
      "other": "Autre"
    },
    "emailInput": "Adresse email",
    "emailUpdatesLabel": "Recevoir le statut de cette demande par e-mail",
    "emailUpdatesNote": "L'accusé de réception et le suivi seront envoyés à cette adresse. Décochez pour ne pas recevoir d'e-mails de statut.",
    "traceInput": "Trace ID ou référence, optionnel",
    "messageInput": "Expliquez ce qui s'est passé et le résultat attendu.",
    "submit": "Envoyer",
    "sending": "Envoi...",
    "success": "Demande envoyée.",
    "failed": "Impossible d'envoyer la demande.",
    "helpCta": "Consulter le Centre d’aide",
    "appCta": "Ouvrir Review",
    "messageExample": "Exemple : aucune réponse après l’ajout d’un PDF dans Review. Indiquez l’heure, le modèle, le type et la taille du fichier et l’identifiant de suivi. N’envoyez ni mot de passe ni numéro de carte."
  },
  "de": {
    "eyebrow": "Support",
    "title": "Wie können wir helfen?",
    "description": "Bei Fragen zu Anmeldung, Zahlung, Antworten oder Dateien helfen wir Ihnen. Nutzen Sie das Formular oder schreiben Sie uns mit den nötigen Angaben. Support erfolgt per Formular und E-Mail; die übliche Antwortzeit finden Sie unten.",
    "emailLabel": "Support-E-Mail",
    "emailValue": "support@tomverse.app",
    "responseLabel": "Übliche Antwortzeit",
    "responseValue": "1-2 Werktage",
    "noPhoneLabel": "Support-Kanal",
    "noPhoneValue": "E-Mail und Formular",
    "cards": [
      {
        "title": "Konto und Zahlung",
        "body": "Hilfe bei Login, Planwechsel, Kündigung, Rückerstattung und Stripe-Checkout.",
        "bullets": [
          "Kontoe-Mail angeben",
          "Betroffenen Plan nennen",
          "Zahlungs- oder Erstattungszeit hinzufügen"
        ]
      },
      {
        "title": "Modelle und Dateien",
        "body": "Melden Sie Modellverfügbarkeit, leere Antworten, nicht unterstützte Dateien, PDF-Probleme und Anhangfehler.",
        "bullets": [
          "Trace ID angeben, falls sichtbar",
          "Modellnamen nennen",
          "Dateityp und ungefähre Größe angeben"
        ]
      },
      {
        "title": "Produktfeedback",
        "body": "Melden Sie Schwierigkeiten, gewünschte Funktionen oder Übersetzungsfehler. Nennen Sie die Seite und die beabsichtigte Aufgabe.",
        "bullets": [
          "Seite oder Gerät nennen",
          "Erwartetes Verhalten beschreiben",
          "Screenshots bei Bedarf beifügen"
        ]
      }
    ],
    "formTitle": "Support kontaktieren",
    "formDescription": "Ihre Anfrage geht an den Support. Mit E-Mail-Updates erhalten Sie Eingangsreferenz und Fortschrittsmeldungen an diese Adresse.",
    "typeLabel": "Anfragetyp",
    "types": {
      "support": "Allgemeiner Support",
      "bug": "Problem oder Fehler",
      "billing": "Abrechnung",
      "feature": "Feature-Wunsch",
      "other": "Sonstiges"
    },
    "emailInput": "E-Mail-Adresse",
    "emailUpdatesLabel": "Statusupdates zu dieser Anfrage per E-Mail erhalten",
    "emailUpdatesNote": "Eingangsbestätigung und Statusupdates gehen an diese Adresse. Abwählen, um keine Status-E-Mails zu erhalten.",
    "traceInput": "Trace ID oder Referenz, optional",
    "messageInput": "Beschreiben Sie, was passiert ist und was Sie erwartet haben.",
    "submit": "Anfrage senden",
    "sending": "Senden...",
    "success": "Support-Anfrage gesendet.",
    "failed": "Support-Anfrage konnte nicht gesendet werden.",
    "helpCta": "Hilfecenter ansehen",
    "appCta": "Review öffnen",
    "messageExample": "Beispiel: Nach dem Anhängen einer PDF in Review kam keine Antwort. Nennen Sie Zeit, Modell, Dateityp und Größe sowie die Trace-ID. Senden Sie keine Passwörter oder Kartennummern."
  },
  "es": {
    "eyebrow": "Soporte",
    "title": "¿Cómo podemos ayudarte?",
    "description": "Si necesitas ayuda con el acceso, la facturación, las respuestas o los archivos, cuéntanos qué pasó. Usa el formulario o escríbenos con los detalles necesarios. El soporte se ofrece por formulario y correo; el tiempo habitual de respuesta aparece abajo.",
    "emailLabel": "Email de soporte",
    "emailValue": "support@tomverse.app",
    "responseLabel": "Respuesta habitual",
    "responseValue": "1-2 días laborables",
    "noPhoneLabel": "Canal de soporte",
    "noPhoneValue": "Email y formulario",
    "cards": [
      {
        "title": "Cuenta y facturación",
        "body": "Ayuda con inicio de sesión, cambios de plan, cancelación, reembolsos y Stripe Checkout.",
        "bullets": [
          "Incluye el email de la cuenta",
          "Menciona el plan",
          "Añade la hora de pago o reembolso si la conoces"
        ]
      },
      {
        "title": "Modelos y archivos",
        "body": "Reporta disponibilidad de modelos, respuestas vacías, archivos no compatibles, PDFs y errores de adjuntos.",
        "bullets": [
          "Incluye el trace ID si aparece",
          "Indica el modelo",
          "Dinos el tipo y tamaño aproximado del archivo"
        ]
      },
      {
        "title": "Feedback de producto",
        "body": "Cuéntanos qué fue difícil, qué función necesitas o dónde hay un error de traducción. Incluye la página y lo que intentabas hacer.",
        "bullets": [
          "Indica página o dispositivo",
          "Describe el comportamiento esperado",
          "Comparte capturas si ayudan"
        ]
      }
    ],
    "formTitle": "Contactar soporte",
    "formDescription": "Tu solicitud llega al soporte. Si eliges avisos por correo, recibirás la referencia de recepción y novedades en esa dirección.",
    "typeLabel": "Tipo de solicitud",
    "types": {
      "support": "Soporte general",
      "bug": "Problema o bug",
      "billing": "Facturación",
      "feature": "Solicitud de función",
      "other": "Otro"
    },
    "emailInput": "Correo electrónico",
    "emailUpdatesLabel": "Recibir por correo el estado de esta solicitud",
    "emailUpdatesNote": "El acuse de recibo y las actualizaciones irán a esta dirección. Desmarca para no recibir correos de estado.",
    "traceInput": "Trace ID o referencia, opcional",
    "messageInput": "Cuéntanos qué pasó y qué esperabas.",
    "submit": "Enviar solicitud",
    "sending": "Enviando...",
    "success": "Solicitud enviada.",
    "failed": "No se pudo enviar la solicitud.",
    "helpCta": "Ver centro de ayuda",
    "appCta": "Abrir Review",
    "messageExample": "Ejemplo: no llegó una respuesta después de adjuntar un PDF en Review. Incluye hora, modelo, formato, tamaño e identificador de seguimiento. No envíes contraseñas ni números de tarjeta."
  },
  "pt": {
    "eyebrow": "Suporte",
    "title": "Como podemos ajudar?",
    "description": "Se precisar de ajuda com login, cobrança, respostas ou arquivos, conte o que aconteceu. Use o formulário ou envie um e-mail com os detalhes necessários. O suporte é oferecido por formulário e e-mail; o prazo habitual está abaixo.",
    "emailLabel": "Email de suporte",
    "emailValue": "support@tomverse.app",
    "responseLabel": "Resposta típica",
    "responseValue": "1-2 dias úteis",
    "noPhoneLabel": "Canal de suporte",
    "noPhoneValue": "Email e formulário",
    "cards": [
      {
        "title": "Conta e cobrança",
        "body": "Ajuda com login, mudanças de plano, cancelamento, reembolso e Stripe Checkout.",
        "bullets": [
          "Inclua o email da conta",
          "Informe o plano envolvido",
          "Adicione o horário do pagamento ou reembolso se souber"
        ]
      },
      {
        "title": "Modelos e arquivos",
        "body": "Reporte disponibilidade de modelos, respostas vazias, arquivos não suportados, PDFs e erros de anexos.",
        "bullets": [
          "Inclua o trace ID quando aparecer",
          "Informe o modelo",
          "Diga o tipo e tamanho aproximado do arquivo"
        ]
      },
      {
        "title": "Feedback do produto",
        "body": "Conte o que foi difícil, qual recurso você precisa ou onde há um erro de tradução. Informe a página e o que tentava fazer.",
        "bullets": [
          "Informe a página ou dispositivo",
          "Descreva o comportamento esperado",
          "Compartilhe capturas se ajudar"
        ]
      }
    ],
    "formTitle": "Contactar suporte",
    "formDescription": "Sua solicitação vai para o suporte. Se escolher atualizações por e-mail, a referência e o andamento serão enviados para esse endereço.",
    "typeLabel": "Tipo de solicitação",
    "types": {
      "support": "Suporte geral",
      "bug": "Problema ou bug",
      "billing": "Cobrança",
      "feature": "Pedido de recurso",
      "other": "Outro"
    },
    "emailInput": "Endereço de email",
    "emailUpdatesLabel": "Receber por e-mail o estado deste pedido",
    "emailUpdatesNote": "O recibo e as atualizações de estado serão enviados para este endereço. Desmarque para não receber e-mails de estado.",
    "traceInput": "Trace ID ou referência, opcional",
    "messageInput": "Conte o que aconteceu e o que esperava.",
    "submit": "Enviar solicitação",
    "sending": "Enviando...",
    "success": "Solicitação enviada.",
    "failed": "Não foi possível enviar a solicitação.",
    "helpCta": "Ver central de ajuda",
    "appCta": "Abrir o Review",
    "messageExample": "Exemplo: não recebi resposta após anexar um PDF no Review. Inclua horário, modelo, tipo, tamanho e ID de rastreamento. Não envie senhas ou números de cartão."
  }
};

export function SupportPageContent() {
  const { lang, t } = useLanguage();
  const { status } = useSession();
  const page = copy[lang] ?? copy.en;
  const [type, setType] = useState<keyof SupportCopy["types"]>("support");
  const [email, setEmail] = useState("");
  // A caller can preselect the request category with `?topic=`. The pricing
  // page's plan-change CTA uses it: online plan changes are not supported yet
  // (docs/policy/plan-change.md), so the CTA sends people here, and landing on
  // a form already set to "Billing" is the difference between a handoff and
  // being dropped at a generic contact page.
  //
  // Read from `window.location` in an effect rather than through
  // `useSearchParams`, because this route is `force-static` and that hook
  // would opt the prerendered tree into client-side rendering.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const requested = new URLSearchParams(window.location.search).get("topic");
    if (!requested || !(requested in copy.en.types)) return;
    queueMicrotask(() =>
      setType(requested as keyof SupportCopy["types"])
    );
  }, []);
  const [traceId, setTraceId] = useState("");
  const [message, setMessage] = useState("");
  // Per-request transactional consent to lifecycle status emails. On by
  // default here because this form already requires the address for a written
  // reply -- but the checkbox makes the consent visible and revocable before
  // anything is submitted.
  const [emailUpdates, setEmailUpdates] = useState(true);
  const [busy, setBusy] = useState(false);
  const isGuestRequest = status === "unauthenticated";
  const {
    containerRef: turnstileContainerRef,
    getToken: getTurnstileToken,
    cancel: cancelVerification,
    failure: verificationFailure,
    isChallengeVisible,
  } = useTurnstile(isGuestRequest, "support_request");
  /**
   * Synchronous duplicate guard: `busy` is state and only lands on the next
   * render, so two submits in the same frame would both get past it.
   */
  const submittingRef = useRef(false);

  const messageState = feedbackMessageState(message);
  const canSubmit = messageState.isValid && Boolean(email.trim()) && !busy;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;
    if (!messageState.isValid || !email.trim()) return;
    submittingRef.current = true;
    setBusy(true);
    try {
      let turnstileToken: string | undefined;
      if (isGuestRequest) {
        try {
          turnstileToken = await getTurnstileToken();
        } catch (error) {
          const failure = isGuestVerificationError(error)
            ? error.kind
            : ("failed" as GuestVerificationFailure);
          dispatchAppToast(
            t(guestVerificationFailureKey(failure, "feedback")),
            "error"
          );
          return;
        }
      }

      const outcome = await submitFeedback({
        type,
        email,
        message,
        traceId: traceId.trim() || undefined,
        path: typeof window !== "undefined" ? window.location.pathname : "/support",
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        ...(turnstileToken ? { turnstileToken } : {}),
        emailUpdates,
        language: lang,
      });

      if (!outcome.ok) {
        // Only the shared, allow-listed failure copy -- never a string that
        // came back in the response body.
        const copyKey = feedbackFailureCopyKey(outcome.failure);
        dispatchAppToast(
          outcome.reference
            ? t(copyKey).replaceAll("{reference}", outcome.reference)
            : t(copyKey),
          "error"
        );
        return;
      }

      // Cleared only once the submission is actually stored.
      setTraceId("");
      setMessage("");
      // The email notice only says receipts are scheduled -- whether a send
      // later succeeds is the retry queue's business, never a submit failure.
      const sentCopy = outcome.reference
        ? t("feedback.sentWithReference").replaceAll(
            "{reference}",
            outcome.reference
          )
        : page.success;
      dispatchAppToast(
        outcome.emailUpdatesEnabled
          ? `${sentCopy} ${t("feedback.emailUpdatesScheduled")}`
          : sentCopy,
        "success"
      );
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader maxWidth="max-w-6xl" />

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:py-20">
        <div className="max-w-3xl">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">
            {page.eyebrow}
          </p>
          <h1 className="mt-4 text-4xl font-black leading-tight sm:text-6xl">{page.title}</h1>
          <p className="mt-5 text-lg leading-8 text-zinc-600 dark:text-zinc-300">{page.description}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href={`/support/help-centre?lang=${encodeURIComponent(lang)}`} className="inline-flex h-12 items-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-bold text-white transition hover:bg-blue-500">
              {page.helpCta}
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href={`${REVIEW_WORKSPACE_PATH}?lang=${encodeURIComponent(lang)}`} className="inline-flex h-12 items-center gap-2 rounded-xl border border-zinc-300 px-5 text-sm font-bold transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
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
                <p className="mt-3 text-xs font-bold uppercase tracking-[0.16em] text-zinc-500 dark:text-zinc-400">{label as string}</p>
                <p className="mt-1 text-sm font-bold">{value as string}</p>
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
            <p id="support-message-example" className="mt-4 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{page.messageExample}</p>
          </div>

          <form onSubmit={submit} className="rounded-3xl border border-zinc-200 bg-zinc-50 p-5 shadow-2xl shadow-zinc-950/5 dark:border-zinc-800 dark:bg-zinc-900/50">
            <label className="mt-6 block text-sm font-bold">
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
            <label className="mt-4 block text-sm font-bold">
              {page.emailInput}
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-2 h-12 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-950"
              />
            </label>
            <label className="mt-3 flex items-start gap-2 text-sm font-bold leading-6">
              <input
                type="checkbox"
                data-testid="support-email-updates"
                checked={emailUpdates}
                onChange={(event) => setEmailUpdates(event.target.checked)}
                aria-describedby="support-email-updates-note"
                className="mt-1 h-4 w-4 shrink-0 accent-blue-600"
              />
              {page.emailUpdatesLabel}
            </label>
            <p
              id="support-email-updates-note"
              data-testid="support-email-updates-note"
              className="mt-1.5 text-xs font-semibold leading-5 text-zinc-500 break-keep dark:text-zinc-400"
            >
              {page.emailUpdatesNote}
            </p>
            <label className="mt-4 block text-sm font-bold">
              {page.traceInput}
              <input
                value={traceId}
                onChange={(event) => setTraceId(event.target.value)}
                className="mt-2 h-12 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-950"
              />
            </label>
            <label className="mt-4 block text-sm font-bold">
              {page.messageInput}
              <textarea
                required
                minLength={FEEDBACK_MESSAGE_MIN_LENGTH}
                maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={6}
                aria-describedby="support-message-example support-message-hint"
                className="mt-2 w-full resize-none rounded-xl border border-zinc-200 bg-white p-3 text-sm leading-6 outline-none transition focus:border-blue-500 dark:border-zinc-800 dark:bg-zinc-950"
              />
              </label>
            <p
              id="support-message-hint"
              role="status"
              data-testid="support-message-hint"
              className="mt-1.5 text-xs font-semibold leading-5 text-zinc-500 break-keep dark:text-zinc-400"
            >
              {messageState.kind === "tooShort"
                ? t("feedback.messageRemaining").replaceAll(
                    "{count}",
                    String(messageState.remaining)
                  )
                : t("feedback.messageHelp").replaceAll(
                    "{min}",
                    String(FEEDBACK_MESSAGE_MIN_LENGTH)
                  )}
              {" "}
              {t("feedback.messageCounter")
                .replaceAll("{count}", String(messageState.trimmedLength))
                .replaceAll(
                  "{max}",
                  FEEDBACK_MESSAGE_MAX_LENGTH.toLocaleString("en-US")
                )}
            </p>
            {/*
              Kept mounted and renderable for the whole verification: Cloudflare
              cannot run a challenge inside a `display: none` container, so an
              interactive one had nowhere to appear before this.
            */}
            <TurnstileFormSlot
              containerRef={turnstileContainerRef}
              isChallengeVisible={isChallengeVisible}
              failure={verificationFailure}
              surface="feedback"
              onCancel={cancelVerification}
              testId="support-verification"
            />
            <button
              type="submit"
              data-testid="support-submit"
              disabled={!canSubmit}
              className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 text-sm font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
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
