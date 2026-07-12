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
    button: "Start comparing models",
    footer:
      "This welcome email was sent because a Tomverse AI account was created with this address.",
    subject: "Welcome to Tomverse AI",
    title: "Welcome to Tomverse AI",
    greeting: (name) => `Hi ${name},`,
    paragraphs: [
      "Thanks for joining Tomverse AI. Your workspace is ready.",
      "You can compare multiple AI models, attach files, continue private conversations, and share or download useful chats from one place.",
      "Start with one question, choose up to three models, and let Tomverse help you find the answer that fits best.",
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
  return `
  <div style="margin:0;padding:0;background:#f4f6fb;font-family:Inter,Arial,sans-serif;color:#111827;">
    <div style="max-width:640px;margin:0 auto;padding:32px 18px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:20px;overflow:hidden;">
        <div style="padding:28px 30px;background:#0b1020;color:#ffffff;">
          <div style="font-size:12px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#93c5fd;">${selected.label}</div>
          <h1 style="margin:12px 0 0;font-size:28px;line-height:1.2;">${title}</h1>
        </div>
        <div style="padding:30px;color:#374151;font-size:15px;line-height:1.7;">
          ${body}
          <p style="margin-top:28px;">
            <a href="${appUrl()}/chat" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:800;border-radius:12px;padding:12px 18px;">${selected.button}</a>
          </p>
        </div>
      </div>
      <p style="margin:18px 4px 0;color:#6b7280;font-size:12px;line-height:1.6;">
        ${selected.footer}
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
