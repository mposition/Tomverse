import "server-only";

import { sendTransactionalEmail } from "@/lib/email";

type EmailLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";

type AccountWelcomeEmailInput = {
  to: string | null | undefined;
  name?: string | null;
  language?: string | null;
};

const appUrl = () =>
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

const copy: Record<
  EmailLanguage,
  {
    label: string;
    button: string;
    footer: string;
    subject: string;
    title: string;
    greeting: (name: string) => string;
    paragraphs: string[];
  }
> = {
  en: {
    label: "Tomverse AI",
    button: "Open your workspace",
    footer:
      "You are receiving this email because a Tomverse AI account was created with this address. If this was not you, please contact Tomverse support.",
    subject: "Welcome to Tomverse AI",
    title: "Your Tomverse AI workspace is ready",
    greeting: (name) => `Hi ${name},`,
    paragraphs: [
      "Welcome to Tomverse AI. Your workspace is ready, and you can start comparing answers from multiple AI models in one clean conversation flow.",
      "Tomverse helps you ask once, review different model perspectives, attach useful files, and keep important conversations organized for later.",
      "Start with one question, choose the models you want to compare, and let Tomverse help you move from exploration to a useful answer faster.",
    ],
  },
  ko: {
    label: "Tomverse AI",
    button: "모델 비교 시작하기",
    footer:
      "이 웰컴 이메일은 해당 주소로 Tomverse AI 계정이 생성되어 발송되었습니다.",
    subject: "Tomverse AI에 오신 것을 환영합니다",
    title: "Tomverse AI에 오신 것을 환영합니다",
    greeting: (name) => `${name}님, 안녕하세요.`,
    paragraphs: [
      "Tomverse AI에 가입해 주셔서 감사합니다. 워크스페이스가 준비되었습니다.",
      "여러 AI 모델의 답변을 한곳에서 비교하고, 파일을 첨부하고, Private Mode로 대화하며, 유용한 대화를 공유하거나 다운로드할 수 있습니다.",
      "질문 하나로 시작해 최대 3개 모델을 선택하고, 가장 잘 맞는 답변을 찾아보세요.",
    ],
  },
  zh: {
    label: "Tomverse AI",
    button: "开始比较模型",
    footer: "这封欢迎邮件是因为此邮箱创建了 Tomverse AI 账户而发送的。",
    subject: "欢迎使用 Tomverse AI",
    title: "欢迎使用 Tomverse AI",
    greeting: (name) => `${name}，你好。`,
    paragraphs: [
      "感谢你加入 Tomverse AI。你的工作区已准备就绪。",
      "你可以在一个地方比较多个 AI 模型、上传文件、继续私密对话，并分享或下载有用的聊天记录。",
      "从一个问题开始，选择最多三个模型，让 Tomverse 帮你找到最合适的答案。",
    ],
  },
  fr: {
    label: "Tomverse AI",
    button: "Comparer des modèles",
    footer:
      "Cet email de bienvenue a été envoyé parce qu'un compte Tomverse AI a été créé avec cette adresse.",
    subject: "Bienvenue sur Tomverse AI",
    title: "Bienvenue sur Tomverse AI",
    greeting: (name) => `Bonjour ${name},`,
    paragraphs: [
      "Merci d'avoir rejoint Tomverse AI. Votre espace de travail est prêt.",
      "Vous pouvez comparer plusieurs modèles d'IA, joindre des fichiers, poursuivre des conversations privées, puis partager ou télécharger les échanges utiles depuis un seul endroit.",
      "Commencez avec une question, choisissez jusqu'à trois modèles et laissez Tomverse vous aider à trouver la réponse la plus adaptée.",
    ],
  },
  de: {
    label: "Tomverse AI",
    button: "Modelle vergleichen",
    footer:
      "Diese Willkommens-E-Mail wurde gesendet, weil mit dieser Adresse ein Tomverse AI Konto erstellt wurde.",
    subject: "Willkommen bei Tomverse AI",
    title: "Willkommen bei Tomverse AI",
    greeting: (name) => `Hallo ${name},`,
    paragraphs: [
      "Danke, dass du Tomverse AI nutzt. Dein Workspace ist bereit.",
      "Du kannst mehrere KI-Modelle vergleichen, Dateien anhängen, private Gespräche fortsetzen und nützliche Chats an einem Ort teilen oder herunterladen.",
      "Starte mit einer Frage, wähle bis zu drei Modelle und lass Tomverse die passendste Antwort finden.",
    ],
  },
  es: {
    label: "Tomverse AI",
    button: "Comparar modelos",
    footer:
      "Este correo de bienvenida se envió porque se creó una cuenta de Tomverse AI con esta dirección.",
    subject: "Te damos la bienvenida a Tomverse AI",
    title: "Te damos la bienvenida a Tomverse AI",
    greeting: (name) => `Hola ${name},`,
    paragraphs: [
      "Gracias por unirte a Tomverse AI. Tu espacio de trabajo está listo.",
      "Puedes comparar varios modelos de IA, adjuntar archivos, continuar conversaciones privadas y compartir o descargar chats útiles desde un solo lugar.",
      "Empieza con una pregunta, elige hasta tres modelos y deja que Tomverse te ayude a encontrar la respuesta más adecuada.",
    ],
  },
  pt: {
    label: "Tomverse AI",
    button: "Comparar modelos",
    footer:
      "Este email de boas-vindas foi enviado porque uma conta Tomverse AI foi criada com este endereço.",
    subject: "Boas-vindas ao Tomverse AI",
    title: "Boas-vindas ao Tomverse AI",
    greeting: (name) => `Olá, ${name}.`,
    paragraphs: [
      "Obrigado por entrar no Tomverse AI. Seu workspace está pronto.",
      "Você pode comparar vários modelos de IA, anexar arquivos, continuar conversas privadas e compartilhar ou baixar chats úteis em um só lugar.",
      "Comece com uma pergunta, escolha até três modelos e deixe o Tomverse ajudar você a encontrar a melhor resposta.",
    ],
  },
};

const shell = (title: string, body: string, language: EmailLanguage) => {
  const selected = copy[language];
  const workspaceUrl = `${appUrl()}/chat`;
  return `
  <div style="margin:0;padding:0;background:#f3f6fb;font-family:Inter,Arial,sans-serif;color:#111827;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      Your Tomverse AI workspace is ready.
    </div>
    <div style="max-width:680px;margin:0 auto;padding:36px 18px;">
      <div style="margin-bottom:18px;text-align:center;">
        <img src="${logoUrl()}" width="64" height="64" alt="Tomverse AI" style="display:inline-block;border-radius:18px;border:1px solid #e5e7eb;background:#ffffff;box-shadow:0 8px 24px rgba(15,23,42,0.10);" />
      </div>
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:24px;overflow:hidden;box-shadow:0 24px 70px rgba(15,23,42,0.10);">
        <div style="padding:34px 34px 30px;background:linear-gradient(135deg,#07111f 0%,#0b2454 55%,#1737a6 100%);color:#ffffff;">
          <div style="display:inline-block;border:1px solid rgba(147,197,253,0.45);border-radius:999px;background:rgba(37,99,235,0.18);padding:6px 10px;font-size:11px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;color:#bfdbfe;">${selected.label}</div>
          <h1 style="margin:18px 0 0;font-size:31px;line-height:1.15;letter-spacing:-0.02em;">${title}</h1>
          <p style="margin:14px 0 0;max-width:520px;color:#dbeafe;font-size:15px;line-height:1.7;">
            Compare leading AI models, work with files, and keep useful answers organized in one workspace.
          </p>
        </div>
        <div style="padding:32px 34px;color:#374151;font-size:15px;line-height:1.75;">
          ${body}
          <div style="margin:26px 0 4px;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden;">
            <div style="padding:16px 18px;border-bottom:1px solid #e5e7eb;background:#f8fafc;">
              <strong style="color:#0f172a;">What you can do next</strong>
            </div>
            <div style="padding:16px 18px;">
              <div style="margin-bottom:12px;"><strong style="color:#1d4ed8;">1.</strong> Ask one question and compare model perspectives.</div>
              <div style="margin-bottom:12px;"><strong style="color:#1d4ed8;">2.</strong> Attach files when you need more context.</div>
              <div><strong style="color:#1d4ed8;">3.</strong> Save, share, or download conversations when they become useful.</div>
            </div>
          </div>
          <div style="margin-top:30px;text-align:left;">
            <a href="${workspaceUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;border-radius:14px;padding:14px 20px;box-shadow:0 12px 28px rgba(37,99,235,0.25);">${selected.button}</a>
          </div>
        </div>
      </div>
      <p style="margin:18px 6px 0;color:#6b7280;font-size:12px;line-height:1.6;text-align:center;">
        ${selected.footer}
      </p>
      <p style="margin:10px 6px 0;color:#94a3b8;font-size:11px;text-align:center;">
        Tomverse AI · <a href="${appUrl()}" style="color:#64748b;text-decoration:underline;">${appUrl()}</a>
      </p>
    </div>
  </div>
`;
};

export async function sendAccountWelcomeEmail(input: AccountWelcomeEmailInput) {
  if (!input.to) return;
  const language = normalizeLanguage(input.language);
  const selected = copy[language];
  const displayName = input.name || "there";
  const safeName = escapeHtml(displayName);
  const body = [
    `<p>${selected.greeting(safeName)}</p>`,
    ...selected.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
  ].join("");
  const text = [
    selected.greeting(displayName),
    ...selected.paragraphs,
    `${selected.button}: ${appUrl()}/chat`,
  ].join("\n");

  await sendTransactionalEmail({
    to: input.to,
    subject: selected.subject,
    text,
    html: shell(selected.title, body, language),
  });
}
