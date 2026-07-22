import "server-only";

import { sendTransactionalEmail } from "@/lib/email";

type EmailLanguage = "en" | "ko" | "zh" | "fr" | "de" | "es" | "pt";

const normalizeLanguage = (value: string | null | undefined): EmailLanguage => {
  if (value === "ko" || value === "zh" || value === "fr" || value === "de" || value === "es" || value === "pt") {
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

type CodeEmailCopy = {
  subject: string;
  intro: string;
  codeLabel: string;
  linkLabel: string;
  expiry: string;
  ignore: string;
};

const codeEmailCopy: Record<EmailLanguage, CodeEmailCopy> = {
  en: {
    subject: "Your Tomverse login code",
    intro: "Use this code to sign in to Tomverse, or click the button below.",
    codeLabel: "Your login code",
    linkLabel: "Sign in to Tomverse",
    expiry: "This code and link expire in 10 minutes and can only be used once.",
    ignore: "If you didn't request this, you can safely ignore this email.",
  },
  ko: {
    subject: "Tomverse 로그인 코드",
    intro: "아래 코드를 입력하거나 버튼을 눌러 Tomverse에 로그인하세요.",
    codeLabel: "로그인 코드",
    linkLabel: "Tomverse에 로그인",
    expiry: "이 코드와 링크는 10분 후 만료되며 한 번만 사용할 수 있습니다.",
    ignore: "요청하지 않으셨다면 이 이메일을 무시하셔도 됩니다.",
  },
  zh: {
    subject: "你的 Tomverse 登录代码",
    intro: "使用以下代码或点击按钮登录 Tomverse。",
    codeLabel: "登录代码",
    linkLabel: "登录 Tomverse",
    expiry: "此代码和链接将在 10 分钟后失效，且只能使用一次。",
    ignore: "如果这不是你本人的请求，可以忽略此邮件。",
  },
  fr: {
    subject: "Votre code de connexion Tomverse",
    intro: "Utilisez ce code pour vous connecter à Tomverse, ou cliquez sur le bouton ci-dessous.",
    codeLabel: "Votre code de connexion",
    linkLabel: "Se connecter à Tomverse",
    expiry: "Ce code et ce lien expirent dans 10 minutes et ne peuvent être utilisés qu'une seule fois.",
    ignore: "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail.",
  },
  de: {
    subject: "Ihr Tomverse-Anmeldecode",
    intro: "Verwenden Sie diesen Code, um sich bei Tomverse anzumelden, oder klicken Sie auf die Schaltfläche unten.",
    codeLabel: "Ihr Anmeldecode",
    linkLabel: "Bei Tomverse anmelden",
    expiry: "Dieser Code und Link laufen in 10 Minuten ab und können nur einmal verwendet werden.",
    ignore: "Wenn Sie dies nicht angefordert haben, können Sie diese E-Mail ignorieren.",
  },
  es: {
    subject: "Tu código de acceso a Tomverse",
    intro: "Usa este código para iniciar sesión en Tomverse, o haz clic en el botón de abajo.",
    codeLabel: "Tu código de acceso",
    linkLabel: "Iniciar sesión en Tomverse",
    expiry: "Este código y enlace caducan en 10 minutos y solo se pueden usar una vez.",
    ignore: "Si no solicitaste esto, puedes ignorar este correo.",
  },
  pt: {
    subject: "Seu código de login do Tomverse",
    intro: "Use este código para entrar no Tomverse, ou clique no botão abaixo.",
    codeLabel: "Seu código de login",
    linkLabel: "Entrar no Tomverse",
    expiry: "Este código e link expiram em 10 minutos e só podem ser usados uma vez.",
    ignore: "Se você não solicitou isso, pode ignorar este e-mail.",
  },
};

export async function sendEmailLoginCodeEmail(input: {
  to: string;
  code: string;
  verifyUrl: string;
  language?: string | null;
}) {
  const copy = codeEmailCopy[normalizeLanguage(input.language)];
  return sendTransactionalEmail({
    to: input.to,
    subject: copy.subject,
    text: [
      copy.intro,
      "",
      `${copy.codeLabel}: ${input.code}`,
      `${copy.linkLabel}: ${input.verifyUrl}`,
      "",
      copy.expiry,
      copy.ignore,
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6">
        <p>${escapeHtml(copy.intro)}</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:4px;margin:24px 0">${escapeHtml(input.code)}</p>
        <p><a href="${input.verifyUrl}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(copy.linkLabel)}</a></p>
        <p style="color:#6b7280;font-size:13px">${escapeHtml(copy.expiry)}</p>
        <p style="color:#6b7280;font-size:13px">${escapeHtml(copy.ignore)}</p>
      </div>
    `,
  });
}

type MethodChangedCopy = {
  linkedSubject: string;
  unlinkedSubject: string;
  linked: (method: string) => string;
  unlinked: (method: string) => string;
  contact: string;
};

const methodChangedCopy: Record<EmailLanguage, MethodChangedCopy> = {
  en: {
    linkedSubject: "A new login method was added to your Tomverse account",
    unlinkedSubject: "A login method was removed from your Tomverse account",
    linked: (method) => `${method} was just added as a login method for your Tomverse account.`,
    unlinked: (method) => `${method} was just removed as a login method for your Tomverse account. You've been signed out on all other devices.`,
    contact: "If you didn't make this change, contact support@tomverse.app immediately.",
  },
  ko: {
    linkedSubject: "Tomverse 계정에 새 로그인 방법이 추가되었습니다",
    unlinkedSubject: "Tomverse 계정에서 로그인 방법이 제거되었습니다",
    linked: (method) => `${method}이(가) Tomverse 계정의 로그인 방법으로 추가되었습니다.`,
    unlinked: (method) => `${method}이(가) Tomverse 계정에서 제거되었습니다. 다른 모든 기기에서 로그아웃되었습니다.`,
    contact: "본인이 요청하지 않았다면 즉시 support@tomverse.app 으로 연락해 주세요.",
  },
  zh: {
    linkedSubject: "你的 Tomverse 账户新增了一种登录方式",
    unlinkedSubject: "你的 Tomverse 账户移除了一种登录方式",
    linked: (method) => `${method} 已被添加为你 Tomverse 账户的登录方式。`,
    unlinked: (method) => `${method} 已从你的 Tomverse 账户移除。你已在所有其他设备上登出。`,
    contact: "如果这不是你本人的操作，请立即联系 support@tomverse.app。",
  },
  fr: {
    linkedSubject: "Une nouvelle méthode de connexion a été ajoutée à votre compte Tomverse",
    unlinkedSubject: "Une méthode de connexion a été supprimée de votre compte Tomverse",
    linked: (method) => `${method} vient d'être ajouté comme méthode de connexion à votre compte Tomverse.`,
    unlinked: (method) => `${method} vient d'être supprimé comme méthode de connexion de votre compte Tomverse. Vous avez été déconnecté de tous les autres appareils.`,
    contact: "Si vous n'êtes pas à l'origine de ce changement, contactez immédiatement support@tomverse.app.",
  },
  de: {
    linkedSubject: "Ihrem Tomverse-Konto wurde eine neue Anmeldemethode hinzugefügt",
    unlinkedSubject: "Eine Anmeldemethode wurde von Ihrem Tomverse-Konto entfernt",
    linked: (method) => `${method} wurde soeben als Anmeldemethode zu Ihrem Tomverse-Konto hinzugefügt.`,
    unlinked: (method) => `${method} wurde soeben als Anmeldemethode von Ihrem Tomverse-Konto entfernt. Sie wurden auf allen anderen Geräten abgemeldet.`,
    contact: "Falls Sie diese Änderung nicht vorgenommen haben, kontaktieren Sie sofort support@tomverse.app.",
  },
  es: {
    linkedSubject: "Se añadió un nuevo método de acceso a tu cuenta de Tomverse",
    unlinkedSubject: "Se eliminó un método de acceso de tu cuenta de Tomverse",
    linked: (method) => `${method} se acaba de añadir como método de acceso a tu cuenta de Tomverse.`,
    unlinked: (method) => `${method} se acaba de eliminar como método de acceso de tu cuenta de Tomverse. Se cerró tu sesión en todos los demás dispositivos.`,
    contact: "Si tú no hiciste este cambio, contacta a support@tomverse.app de inmediato.",
  },
  pt: {
    linkedSubject: "Um novo método de login foi adicionado à sua conta Tomverse",
    unlinkedSubject: "Um método de login foi removido da sua conta Tomverse",
    linked: (method) => `${method} acabou de ser adicionado como método de login da sua conta Tomverse.`,
    unlinked: (method) => `${method} acabou de ser removido como método de login da sua conta Tomverse. Você foi desconectado de todos os outros dispositivos.`,
    contact: "Se você não fez essa alteração, contate support@tomverse.app imediatamente.",
  },
};

const methodLabel = (method: "google" | "azure-ad" | "email") =>
  method === "google" ? "Google" : method === "azure-ad" ? "Microsoft" : "Email";

export async function sendLoginMethodChangedEmail(input: {
  to: string | null | undefined;
  action: "linked" | "unlinked";
  method: "google" | "azure-ad" | "email";
  language?: string | null;
}) {
  if (!input.to) return;
  const copy = methodChangedCopy[normalizeLanguage(input.language)];
  const label = methodLabel(input.method);
  const body = input.action === "linked" ? copy.linked(label) : copy.unlinked(label);
  const subject = input.action === "linked" ? copy.linkedSubject : copy.unlinkedSubject;
  return sendTransactionalEmail({
    to: input.to,
    subject,
    text: `${body}\n\n${copy.contact}`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6">
        <p>${escapeHtml(body)}</p>
        <p style="color:#6b7280;font-size:13px">${escapeHtml(copy.contact)}</p>
      </div>
    `,
  });
}
