import "server-only";

import { sendTransactionalEmail } from "@/lib/email";

type EmailLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";

type AccountWelcomeEmailInput = {
  to: string | null | undefined;
  name?: string | null;
  language?: string | null;
};

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

const copy: Record<EmailLanguage, WelcomeCopy> = {
  en: {
    brandLabel: "Tomverse AI",
    subject: "Welcome to Tomverse AI",
    title: "Your AI workspace is ready",
    subtitle:
      "Compare leading AI models, work with files, and keep useful answers organized in one clean workspace.",
    greeting: (name) => `Hi ${name},`,
    paragraphs: [
      "Welcome to Tomverse AI. Your workspace is ready, and you can start comparing answers from multiple AI models in one conversation flow.",
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
      "You are receiving this email because a Tomverse AI account was created with this address. If this was not you, please contact Tomverse support.",
    preview: "Your Tomverse AI workspace is ready.",
  },
  ko: {
    brandLabel: "Tomverse AI",
    subject: "Tomverse AI에 오신 것을 환영합니다",
    title: "AI 워크스페이스가 준비되었습니다",
    subtitle:
      "여러 AI 모델의 답변을 비교하고, 파일을 함께 분석하며, 유용한 대화를 한곳에 정리하세요.",
    greeting: (name) => `${name}님, 안녕하세요.`,
    paragraphs: [
      "Tomverse AI에 가입해 주셔서 감사합니다. 이제 하나의 대화 흐름 안에서 여러 AI 모델의 답변을 비교해볼 수 있습니다.",
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
      "이 이메일은 해당 주소로 Tomverse AI 계정이 생성되어 발송되었습니다. 본인이 가입한 것이 아니라면 Tomverse 지원팀에 문의해 주세요.",
    preview: "Tomverse AI 워크스페이스가 준비되었습니다.",
  },
  zh: {
    brandLabel: "Tomverse AI",
    subject: "欢迎使用 Tomverse AI",
    title: "你的 AI 工作区已准备就绪",
    subtitle:
      "在一个清晰的工作区中比较主流 AI 模型、处理文件，并整理有价值的回答。",
    greeting: (name) => `${name}，你好。`,
    paragraphs: [
      "欢迎加入 Tomverse AI。现在你可以在同一个对话流程中比较多个 AI 模型的回答。",
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
      "你收到这封邮件，是因为有人使用此邮箱创建了 Tomverse AI 账户。如果这不是你本人操作，请联系 Tomverse 支持团队。",
    preview: "你的 Tomverse AI 工作区已准备就绪。",
  },
  fr: {
    brandLabel: "Tomverse AI",
    subject: "Bienvenue sur Tomverse AI",
    title: "Votre espace IA est prêt",
    subtitle:
      "Comparez les principaux modèles d'IA, travaillez avec des fichiers et organisez les réponses utiles dans un seul espace.",
    greeting: (name) => `Bonjour ${name},`,
    paragraphs: [
      "Bienvenue sur Tomverse AI. Votre espace est prêt et vous pouvez comparer les réponses de plusieurs modèles d'IA dans un même fil de conversation.",
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
      "Vous recevez cet email parce qu'un compte Tomverse AI a été créé avec cette adresse. Si ce n'était pas vous, contactez le support Tomverse.",
    preview: "Votre espace Tomverse AI est prêt.",
  },
  de: {
    brandLabel: "Tomverse AI",
    subject: "Willkommen bei Tomverse AI",
    title: "Dein KI-Workspace ist bereit",
    subtitle:
      "Vergleiche führende KI-Modelle, arbeite mit Dateien und organisiere nützliche Antworten an einem Ort.",
    greeting: (name) => `Hallo ${name},`,
    paragraphs: [
      "Willkommen bei Tomverse AI. Dein Workspace ist bereit und du kannst Antworten mehrerer KI-Modelle in einem sauberen Gesprächsfluss vergleichen.",
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
      "Du erhältst diese E-Mail, weil mit dieser Adresse ein Tomverse AI Konto erstellt wurde. Falls du das nicht warst, kontaktiere bitte den Tomverse Support.",
    preview: "Dein Tomverse AI Workspace ist bereit.",
  },
  es: {
    brandLabel: "Tomverse AI",
    subject: "Te damos la bienvenida a Tomverse AI",
    title: "Tu espacio de IA está listo",
    subtitle:
      "Compara los principales modelos de IA, trabaja con archivos y organiza respuestas útiles en un solo espacio.",
    greeting: (name) => `Hola ${name},`,
    paragraphs: [
      "Bienvenido a Tomverse AI. Tu espacio está listo y ya puedes comparar respuestas de varios modelos de IA en un único flujo de conversación.",
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
      "Recibes este correo porque se creó una cuenta de Tomverse AI con esta dirección. Si no fuiste tú, contacta con el soporte de Tomverse.",
    preview: "Tu espacio de Tomverse AI está listo.",
  },
  pt: {
    brandLabel: "Tomverse AI",
    subject: "Boas-vindas ao Tomverse AI",
    title: "Seu workspace de IA está pronto",
    subtitle:
      "Compare os principais modelos de IA, trabalhe com arquivos e organize respostas úteis em um só lugar.",
    greeting: (name) => `Olá, ${name}.`,
    paragraphs: [
      "Boas-vindas ao Tomverse AI. Seu workspace está pronto e você já pode comparar respostas de vários modelos de IA em um único fluxo de conversa.",
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
      "Você está recebendo este email porque uma conta Tomverse AI foi criada com este endereço. Se não foi você, entre em contato com o suporte Tomverse.",
    preview: "Seu workspace Tomverse AI está pronto.",
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
  <div style="margin:0;padding:0;background:#edf2f8;font-family:Inter,Segoe UI,Arial,sans-serif;color:#111827;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${escapeHtml(copyItem.preview)}
    </div>
    <div style="max-width:700px;margin:0 auto;padding:34px 18px;">
      <div style="margin:0 auto 18px;text-align:center;">
        <img src="${logoUrl()}" width="64" height="64" alt="Tomverse AI" style="display:inline-block;border-radius:18px;border:1px solid #dbe3ef;background:#ffffff;box-shadow:0 12px 34px rgba(15,23,42,0.14);" />
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

  await sendTransactionalEmail({
    to: input.to,
    subject: selected.subject,
    text,
    html: shell(selected, body),
  });
}
