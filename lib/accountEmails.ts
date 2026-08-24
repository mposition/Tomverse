import "server-only";

import { EMAIL_FONT_STACK } from "@/lib/emailTypography";

type EmailLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";


/**
 * Built rather than sent, so the standard lane can render the same bytes at
 * drain time that it would have rendered at enqueue time.
 *
 * Pure and deterministic for a given input: the provider only suppresses a
 * duplicate when the retried payload is byte-identical, and an audit that
 * re-renders differently from what was sent proves nothing
 * (docs/policy/email-notifications.md §9.3, §10.3).
 *
 * Seven languages, because the alternative was that the least reversible notice
 * this system sends -- your account and everything in it will be destroyed on
 * this date -- arrived in English for the accounts that had chosen otherwise
 * (EM-12). The welcome mail in this same file has had all seven since it was
 * written; the notice that matters had one.
 *
 * `Record<EmailLanguage, Copy>` rather than a lookup with a fallback: adding a
 * language then fails to compile until every message has been written, which is
 * the only mechanism that has ever kept a translation set complete.
 */

type DeletionCopy = {
  subject: string;
  stopped: (date: string) => string;
  renewal: string;
  cancel: string;
  notYou: string;
};

const SUPPORT = "support@tomverse.app";

const DELETION_COPY: Record<EmailLanguage, DeletionCopy> = {
  en: {
    subject: "Tomverse account deletion scheduled",
    stopped: (date) =>
      `Your Tomverse account access has been stopped immediately, and permanent deletion (including all data) is scheduled for ${date}.`,
    renewal:
      "If you have a paid plan, automatic renewal has been stopped, but access stays blocked either way while deletion is pending.",
    cancel: `Cancelling this request is not self-service. Contact ${SUPPORT} before that date and our team will restore your account. If restored, plan access resumes only until your plan's original expiration date; automatic renewal is not restored.`,
    notYou: `If you did not request this, contact ${SUPPORT} immediately.`,
  },
  ko: {
    subject: "Tomverse 계정 삭제가 예정되었습니다",
    stopped: (date) =>
      `Tomverse 계정 접근이 즉시 중지되었으며, 모든 데이터를 포함한 영구 삭제가 ${date}에 예정되어 있습니다.`,
    renewal:
      "유료 플랜을 사용 중이셨다면 자동 갱신이 중지되었습니다. 삭제가 진행되는 동안에는 어느 경우에도 접근이 차단됩니다.",
    cancel: `이 요청은 직접 취소하실 수 없습니다. 해당 날짜 이전에 ${SUPPORT}로 연락하시면 계정을 복구해 드립니다. 복구되면 플랜은 원래 만료일까지만 유지되며 자동 갱신은 복구되지 않습니다.`,
    notYou: `요청하신 적이 없다면 즉시 ${SUPPORT}로 연락해 주십시오.`,
  },
  zh: {
    subject: "您的 Tomverse 账户已安排删除",
    stopped: (date) =>
      `您的 Tomverse 账户访问已立即停止，包含全部数据的永久删除安排在 ${date}。`,
    renewal:
      "如果您使用付费方案，自动续订已停止；在删除处理期间，访问都会保持关闭。",
    cancel: `此请求无法自助取消。请在该日期之前联系 ${SUPPORT}，我们的团队会为您恢复账户。恢复后，方案仅保留至原到期日，自动续订不会恢复。`,
    notYou: `如果这不是您本人的请求，请立即联系 ${SUPPORT}。`,
  },
  fr: {
    subject: "Suppression de votre compte Tomverse programmée",
    stopped: (date) =>
      `L'accès à votre compte Tomverse a été interrompu immédiatement, et la suppression définitive (données comprises) est programmée pour le ${date}.`,
    renewal:
      "Si vous aviez une formule payante, le renouvellement automatique a été arrêté ; dans tous les cas, l'accès reste bloqué pendant la procédure.",
    cancel: `Cette demande ne peut pas être annulée en libre-service. Contactez ${SUPPORT} avant cette date et notre équipe rétablira votre compte. En cas de rétablissement, la formule reprend jusqu'à sa date d'expiration initiale uniquement ; le renouvellement automatique n'est pas rétabli.`,
    notYou: `Si vous n'êtes pas à l'origine de cette demande, contactez ${SUPPORT} immédiatement.`,
  },
  de: {
    subject: "Löschung Ihres Tomverse-Kontos geplant",
    stopped: (date) =>
      `Der Zugang zu Ihrem Tomverse-Konto wurde sofort gesperrt, und die endgültige Löschung einschließlich aller Daten ist für den ${date} vorgesehen.`,
    renewal:
      "Bei einem kostenpflichtigen Tarif wurde die automatische Verlängerung beendet; der Zugang bleibt während des Löschvorgangs in jedem Fall gesperrt.",
    cancel: `Diese Anfrage lässt sich nicht selbst zurücknehmen. Wenden Sie sich vor diesem Datum an ${SUPPORT}, dann stellt unser Team Ihr Konto wieder her. Nach einer Wiederherstellung läuft der Tarif nur bis zum ursprünglichen Ablaufdatum weiter; die automatische Verlängerung wird nicht wiederhergestellt.`,
    notYou: `Wenn diese Anfrage nicht von Ihnen stammt, wenden Sie sich sofort an ${SUPPORT}.`,
  },
  es: {
    subject: "Eliminación programada de su cuenta de Tomverse",
    stopped: (date) =>
      `El acceso a su cuenta de Tomverse se ha detenido de inmediato y la eliminación permanente, incluidos todos los datos, está prevista para el ${date}.`,
    renewal:
      "Si tenía un plan de pago, la renovación automática se ha detenido; en cualquier caso, el acceso permanece bloqueado mientras la eliminación esté pendiente.",
    cancel: `Esta solicitud no se puede cancelar por su cuenta. Escriba a ${SUPPORT} antes de esa fecha y nuestro equipo restaurará su cuenta. Si se restaura, el plan continúa solo hasta su fecha de vencimiento original; la renovación automática no se restablece.`,
    notYou: `Si usted no solicitó esto, escriba a ${SUPPORT} de inmediato.`,
  },
  pt: {
    subject: "Exclusão da sua conta Tomverse agendada",
    stopped: (date) =>
      `O acesso à sua conta Tomverse foi interrompido imediatamente, e a exclusão permanente, incluindo todos os dados, está agendada para ${date}.`,
    renewal:
      "Se você tinha um plano pago, a renovação automática foi interrompida; de qualquer forma, o acesso permanece bloqueado enquanto a exclusão estiver pendente.",
    cancel: `Esta solicitação não pode ser cancelada por conta própria. Entre em contato com ${SUPPORT} antes dessa data e nossa equipe restaurará a sua conta. Se restaurada, o plano segue apenas até a data de expiração original; a renovação automática não é restabelecida.`,
    notYou: `Se você não fez esta solicitação, entre em contato com ${SUPPORT} imediatamente.`,
  },
};

export function buildAccountDeletionScheduledEmail(input: {
  scheduledFor: string;
  language?: string | null;
}) {
  const copy = DELETION_COPY[normalizeLanguage(input.language)];
  const date = input.scheduledFor;
  return {
    subject: copy.subject,
    text: [copy.stopped(date), copy.renewal, copy.cancel, copy.notYou].join("\n\n"),
    html: [
      `<p>${copy.stopped(`<strong>${escapeHtml(date)}</strong>`)}</p>`,
      `<p>${escapeHtml(copy.renewal)}</p>`,
      `<p>${escapeHtml(copy.cancel).replace(SUPPORT, `<a href="mailto:${SUPPORT}">${SUPPORT}</a>`)}</p>`,
      `<p>${escapeHtml(copy.notYou).replace(SUPPORT, `<a href="mailto:${SUPPORT}">${SUPPORT}</a>`)}</p>`,
    ].join(""),
  };
}

type RestoredCopy = { subject: string; active: string; plan: string };

const RESTORED_COPY: Record<EmailLanguage, RestoredCopy> = {
  en: {
    subject: "Your Tomverse account has been restored",
    active: "Your Tomverse account is active again and you can sign in.",
    plan: "If you had a paid plan, it continues until its original expiration date, but automatic renewal was not restored -- you'll need to resubscribe if you want to keep the plan after that date.",
  },
  ko: {
    subject: "Tomverse 계정이 복구되었습니다",
    active: "Tomverse 계정이 다시 활성화되어 로그인하실 수 있습니다.",
    plan: "유료 플랜을 사용 중이셨다면 원래 만료일까지 유지되지만 자동 갱신은 복구되지 않았습니다. 그 이후에도 플랜을 유지하시려면 다시 구독하셔야 합니다.",
  },
  zh: {
    subject: "您的 Tomverse 账户已恢复",
    active: "您的 Tomverse 账户已重新启用，可以登录了。",
    plan: "如果您有付费方案，它会保留到原到期日，但自动续订未恢复。若希望在该日期之后继续使用，需要重新订阅。",
  },
  fr: {
    subject: "Votre compte Tomverse a été rétabli",
    active: "Votre compte Tomverse est de nouveau actif et vous pouvez vous connecter.",
    plan: "Si vous aviez une formule payante, elle se poursuit jusqu'à sa date d'expiration initiale, mais le renouvellement automatique n'a pas été rétabli : il faudra vous réabonner pour la conserver au-delà de cette date.",
  },
  de: {
    subject: "Ihr Tomverse-Konto wurde wiederhergestellt",
    active: "Ihr Tomverse-Konto ist wieder aktiv und Sie können sich anmelden.",
    plan: "Ein kostenpflichtiger Tarif läuft bis zum ursprünglichen Ablaufdatum weiter, die automatische Verlängerung wurde jedoch nicht wiederhergestellt. Um den Tarif darüber hinaus zu behalten, ist ein neues Abonnement nötig.",
  },
  es: {
    subject: "Su cuenta de Tomverse ha sido restaurada",
    active: "Su cuenta de Tomverse vuelve a estar activa y puede iniciar sesión.",
    plan: "Si tenía un plan de pago, continúa hasta su fecha de vencimiento original, pero la renovación automática no se restableció: tendrá que volver a suscribirse para conservarlo después de esa fecha.",
  },
  pt: {
    subject: "Sua conta Tomverse foi restaurada",
    active: "Sua conta Tomverse está ativa novamente e você pode entrar.",
    plan: "Se você tinha um plano pago, ele continua até a data de expiração original, mas a renovação automática não foi restabelecida: será preciso assinar de novo para mantê-lo depois dessa data.",
  },
};

export function buildAccountRestoredEmail(input?: { language?: string | null }) {
  const copy = RESTORED_COPY[normalizeLanguage(input?.language)];
  return {
    subject: copy.subject,
    text: [copy.active, copy.plan].join("\n\n"),
    html: `<p>${escapeHtml(copy.active)}</p><p>${escapeHtml(copy.plan)}</p>`,
  };
}

type WelcomeCopy = {
  brandLabel: string;
  subject: string;
  title: string;
  subtitle: string;
  greeting: (name: string) => string;
  paragraphs: string[];
  nextTitle: string;
  nextSteps: string[];
  button: string;
  footer: string;
  preview: string;
};

export const appUrl = () =>
  process.env.PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://tomverse.app";

const logoUrl = () => `${appUrl()}/tomverse-logo.png`;

const normalizeLanguage = (value: string | null | undefined): EmailLanguage => {
  if (
    value === "ko" ||
    value === "zh" ||
    value === "fr" ||
    value === "de" ||
    value === "es" ||
    value === "pt"
  ) {
    return value;
  }
  return "en";
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const copy: Record<EmailLanguage, WelcomeCopy> = {
  en: {
    brandLabel: "Tomverse",
    subject: "Welcome to Tomverse",
    title: "Your AI workspace is ready",
    subtitle:
      "Compare leading AI models, work with files, and keep useful answers organized in one clean workspace.",
    greeting: (name) => `Hi ${name},`,
    paragraphs: [
      "Welcome to Tomverse. Your workspace is ready, and in Tomverse Review you can start comparing answers from multiple AI models in one conversation flow.",
      "Ask once, review different model perspectives, attach useful files, and keep important conversations organized for later.",
      "Start with one question, choose the models you want to compare, and let Tomverse help you move from exploration to a practical answer faster.",
    ],
    nextTitle: "What you can do next",
    nextSteps: [
      "Ask one question and compare model perspectives.",
      "Attach files when you need more context.",
      "Save, share, or download conversations when they become useful.",
    ],
    button: "Open your workspace",
    footer:
      "You are receiving this email because a Tomverse account was created with this address. If this was not you, please contact Tomverse support.",
    preview: "Your Tomverse workspace is ready.",
  },
  ko: {
    brandLabel: "Tomverse",
    subject: "Tomverse에 오신 것을 환영합니다",
    title: "AI 워크스페이스가 준비되었습니다",
    subtitle:
      "여러 AI 모델의 답변을 비교하고, 파일을 함께 분석하며, 유용한 대화를 한곳에 정리하세요.",
    greeting: (name) => `${name}님, 안녕하세요.`,
    paragraphs: [
      "Tomverse에 가입해 주셔서 감사합니다. 이제 Tomverse Review에서 하나의 대화 흐름 안에 여러 AI 모델의 답변을 비교해볼 수 있습니다.",
      "한 번 질문하고, 모델별 관점을 검토하고, 필요한 파일을 첨부하며, 중요한 대화는 나중에 다시 찾기 쉽게 정리할 수 있습니다.",
      "첫 질문을 입력하고 비교할 모델을 선택해 보세요. Tomverse가 더 빠르게 실용적인 답변에 도달할 수 있도록 도와드립니다.",
    ],
    nextTitle: "바로 시작해볼 수 있는 일",
    nextSteps: [
      "질문 하나로 여러 모델의 관점을 비교해보세요.",
      "문서나 이미지를 첨부해 더 풍부한 맥락을 전달하세요.",
      "유용한 대화는 저장, 공유 또는 다운로드하세요.",
    ],
    button: "워크스페이스 열기",
    footer:
      "이 이메일은 해당 주소로 Tomverse 계정이 생성되어 발송되었습니다. 본인이 가입한 것이 아니라면 Tomverse 지원팀에 문의해 주세요.",
    preview: "Tomverse 워크스페이스가 준비되었습니다.",
  },
  zh: {
    brandLabel: "Tomverse",
    subject: "欢迎使用 Tomverse",
    title: "你的 AI 工作区已准备就绪",
    subtitle:
      "在一个清晰的工作区中比较主流 AI 模型、处理文件，并整理有价值的回答。",
    greeting: (name) => `${name}，你好。`,
    paragraphs: [
      "欢迎加入 Tomverse。现在你可以在 Tomverse Review 中于同一个对话流程里比较多个 AI 模型的回答。",
      "你可以一次提问，查看不同模型的观点，上传有用的文件，并把重要对话整理起来以便之后使用。",
      "从一个问题开始，选择想要比较的模型，让 Tomverse 帮你更快找到实用答案。",
    ],
    nextTitle: "接下来可以做什么",
    nextSteps: [
      "提出一个问题并比较不同模型的观点。",
      "在需要更多上下文时上传文件。",
      "将有用的对话保存、分享或下载。",
    ],
    button: "打开工作区",
    footer:
      "你收到这封邮件，是因为有人使用此邮箱创建了 Tomverse 账户。如果这不是你本人操作，请联系 Tomverse 支持团队。",
    preview: "你的 Tomverse 工作区已准备就绪。",
  },
  fr: {
    brandLabel: "Tomverse",
    subject: "Bienvenue sur Tomverse",
    title: "Votre espace IA est prêt",
    subtitle:
      "Comparez les principaux modèles d'IA, travaillez avec des fichiers et organisez les réponses utiles dans un seul espace.",
    greeting: (name) => `Bonjour ${name},`,
    paragraphs: [
      "Bienvenue sur Tomverse. Votre espace est prêt et, dans Tomverse Review, vous pouvez comparer les réponses de plusieurs modèles d'IA dans un même fil de conversation.",
      "Posez une question une seule fois, analysez plusieurs perspectives, ajoutez des fichiers utiles et gardez vos conversations importantes bien organisées.",
      "Commencez avec une question, choisissez les modèles à comparer et laissez Tomverse vous aider à obtenir plus rapidement une réponse exploitable.",
    ],
    nextTitle: "Ce que vous pouvez faire ensuite",
    nextSteps: [
      "Posez une question et comparez les perspectives des modèles.",
      "Ajoutez des fichiers lorsque vous avez besoin de plus de contexte.",
      "Enregistrez, partagez ou téléchargez les conversations utiles.",
    ],
    button: "Ouvrir votre espace",
    footer:
      "Vous recevez cet email parce qu'un compte Tomverse a été créé avec cette adresse. Si ce n'était pas vous, contactez le support Tomverse.",
    preview: "Votre espace Tomverse est prêt.",
  },
  de: {
    brandLabel: "Tomverse",
    subject: "Willkommen bei Tomverse",
    title: "Dein KI-Workspace ist bereit",
    subtitle:
      "Vergleiche führende KI-Modelle, arbeite mit Dateien und organisiere nützliche Antworten an einem Ort.",
    greeting: (name) => `Hallo ${name},`,
    paragraphs: [
      "Willkommen bei Tomverse. Dein Workspace ist bereit und in Tomverse Review kannst du Antworten mehrerer KI-Modelle in einem sauberen Gesprächsfluss vergleichen.",
      "Stelle eine Frage, prüfe unterschiedliche Modellperspektiven, füge hilfreiche Dateien hinzu und halte wichtige Gespräche übersichtlich fest.",
      "Starte mit einer Frage, wähle die Modelle aus, die du vergleichen möchtest, und lass Tomverse schneller eine brauchbare Antwort finden.",
    ],
    nextTitle: "Was du als Nächstes tun kannst",
    nextSteps: [
      "Stelle eine Frage und vergleiche Modellperspektiven.",
      "Füge Dateien hinzu, wenn du mehr Kontext brauchst.",
      "Speichere, teile oder lade nützliche Gespräche herunter.",
    ],
    button: "Workspace öffnen",
    footer:
      "Du erhältst diese E-Mail, weil mit dieser Adresse ein Tomverse Konto erstellt wurde. Falls du das nicht warst, kontaktiere bitte den Tomverse Support.",
    preview: "Dein Tomverse Workspace ist bereit.",
  },
  es: {
    brandLabel: "Tomverse",
    subject: "Te damos la bienvenida a Tomverse",
    title: "Tu espacio de IA está listo",
    subtitle:
      "Compara los principales modelos de IA, trabaja con archivos y organiza respuestas útiles en un solo espacio.",
    greeting: (name) => `Hola ${name},`,
    paragraphs: [
      "Bienvenido a Tomverse. Tu espacio está listo y en Tomverse Review ya puedes comparar respuestas de varios modelos de IA en un único flujo de conversación.",
      "Pregunta una vez, revisa distintas perspectivas, adjunta archivos útiles y mantén tus conversaciones importantes organizadas para más adelante.",
      "Empieza con una pregunta, elige los modelos que quieres comparar y deja que Tomverse te ayude a llegar antes a una respuesta práctica.",
    ],
    nextTitle: "Qué puedes hacer ahora",
    nextSteps: [
      "Haz una pregunta y compara perspectivas de modelos.",
      "Adjunta archivos cuando necesites más contexto.",
      "Guarda, comparte o descarga conversaciones útiles.",
    ],
    button: "Abrir tu espacio",
    footer:
      "Recibes este correo porque se creó una cuenta de Tomverse con esta dirección. Si no fuiste tú, contacta con el soporte de Tomverse.",
    preview: "Tu espacio de Tomverse está listo.",
  },
  pt: {
    brandLabel: "Tomverse",
    subject: "Boas-vindas ao Tomverse",
    title: "Seu workspace de IA está pronto",
    subtitle:
      "Compare os principais modelos de IA, trabalhe com arquivos e organize respostas úteis em um só lugar.",
    greeting: (name) => `Olá, ${name}.`,
    paragraphs: [
      "Boas-vindas ao Tomverse. Seu workspace está pronto e no Tomverse Review você já pode comparar respostas de vários modelos de IA em um único fluxo de conversa.",
      "Faça uma pergunta, revise diferentes perspectivas, anexe arquivos úteis e mantenha conversas importantes organizadas para depois.",
      "Comece com uma pergunta, escolha os modelos que deseja comparar e deixe o Tomverse ajudar você a chegar mais rápido a uma resposta prática.",
    ],
    nextTitle: "O que você pode fazer agora",
    nextSteps: [
      "Faça uma pergunta e compare perspectivas dos modelos.",
      "Anexe arquivos quando precisar de mais contexto.",
      "Salve, compartilhe ou baixe conversas úteis.",
    ],
    button: "Abrir workspace",
    footer:
      "Você está recebendo este email porque uma conta Tomverse foi criada com este endereço. Se não foi você, entre em contato com o suporte Tomverse.",
    preview: "Seu workspace Tomverse está pronto.",
  },
};

const renderParagraphs = (paragraphs: string[]) =>
  paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 18px;color:#243044;font-size:15px;line-height:1.75;">${escapeHtml(paragraph)}</p>`
    )
    .join("");

const renderSteps = (steps: string[]) =>
  steps
    .map(
      (step, index) => `
        <tr>
          <td style="width:34px;padding:10px 0;vertical-align:top;">
            <span style="display:inline-block;width:24px;height:24px;border-radius:999px;background:#eff6ff;color:#1d4ed8;text-align:center;font-size:12px;font-weight:800;line-height:24px;">${index + 1}</span>
          </td>
          <td style="padding:10px 0;color:#334155;font-size:14px;line-height:1.6;">${escapeHtml(step)}</td>
        </tr>`
    )
    .join("");

const shell = (copyItem: WelcomeCopy, body: string) => {
  const workspaceUrl = `${appUrl()}/chat`;
  return `
  <div style="margin:0;padding:0;background:#edf2f8;font-family:${EMAIL_FONT_STACK};color:#111827;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${escapeHtml(copyItem.preview)}
    </div>
    <div style="max-width:700px;margin:0 auto;padding:34px 18px;">
      <div style="margin:0 auto 18px;text-align:center;">
        <img src="${logoUrl()}" width="64" height="64" alt="Tomverse" style="display:inline-block;border-radius:18px;border:1px solid #dbe3ef;background:#ffffff;box-shadow:0 12px 34px rgba(15,23,42,0.14);" />
      </div>
      <div style="background:#ffffff;border:1px solid #d9e2ee;border-radius:26px;overflow:hidden;box-shadow:0 24px 70px rgba(15,23,42,0.14);">
        <div style="padding:34px 36px 32px;background:#08111f;color:#ffffff;">
          <div style="display:inline-block;border:1px solid #60a5fa;border-radius:999px;background:#10284a;padding:7px 11px;font-size:11px;font-weight:800;letter-spacing:0.15em;text-transform:uppercase;color:#bfdbfe;">
            ${escapeHtml(copyItem.brandLabel)}
          </div>
          <h1 style="margin:20px 0 0;color:#ffffff;font-size:32px;line-height:1.15;letter-spacing:-0.03em;font-weight:900;">
            ${escapeHtml(copyItem.title)}
          </h1>
          <p style="margin:16px 0 0;max-width:550px;color:#dbeafe;font-size:16px;line-height:1.7;font-weight:500;">
            ${escapeHtml(copyItem.subtitle)}
          </p>
        </div>
        <div style="padding:34px 36px 36px;background:#ffffff;">
          ${body}
          <div style="margin:28px 0 0;border:1px solid #dfe7f1;border-radius:18px;overflow:hidden;background:#f8fafc;">
            <div style="padding:16px 18px;border-bottom:1px solid #dfe7f1;background:#f1f5f9;">
              <strong style="color:#0f172a;font-size:15px;">${escapeHtml(copyItem.nextTitle)}</strong>
            </div>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:8px 18px 14px;">
              ${renderSteps(copyItem.nextSteps)}
            </table>
          </div>
          <div style="margin-top:30px;">
            <a href="${workspaceUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:900;border-radius:14px;padding:15px 22px;box-shadow:0 12px 28px rgba(37,99,235,0.28);">
              ${escapeHtml(copyItem.button)}
            </a>
          </div>
        </div>
      </div>
      <p style="margin:18px 8px 0;color:#64748b;font-size:12px;line-height:1.65;text-align:center;">
        ${escapeHtml(copyItem.footer)}
      </p>
      <p style="margin:10px 8px 0;color:#94a3b8;font-size:11px;text-align:center;">
        Tomverse · <a href="${appUrl()}" style="color:#64748b;text-decoration:underline;">${appUrl()}</a>
      </p>
    </div>
  </div>
`;
};

export function buildAccountWelcomeEmail(input: {
  name?: string | null;
  language?: string | null;
}) {
  const language = normalizeLanguage(input.language);
  const selected = copy[language];
  const displayName = input.name || "there";
  const safeName = escapeHtml(displayName);
  const body = [
    `<p style="margin:0 0 18px;color:#0f172a;font-size:15px;line-height:1.75;font-weight:700;">${selected.greeting(safeName)}</p>`,
    renderParagraphs(selected.paragraphs),
  ].join("");
  const text = [
    selected.greeting(displayName),
    ...selected.paragraphs,
    "",
    selected.nextTitle,
    ...selected.nextSteps.map((step, index) => `${index + 1}. ${step}`),
    "",
    `${selected.button}: ${appUrl()}/chat`,
  ].join("\n");

  return { subject: selected.subject, text, html: shell(selected, body) };
}
