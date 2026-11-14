import Link from "next/link";
import { headers } from "next/headers";
import { SignOutAndSwitchAccountButton } from "@/components/auth/SignOutAndSwitchAccountButton";
import { REVIEW_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";
import { HELP_CENTRE_PATH } from "@/lib/localizedHelpHref";
import {
  accountSwitchSignInHref,
  isAdminPathname,
} from "@/lib/adminReauthenticationCore";
import {
  DOCUMENT_LANGUAGE_HEADER,
  isSupportedDocumentLanguage,
} from "@/lib/documentLanguage";
import type { Language } from "@/lib/language";

type NotFoundCopy = {
  title: string;
  accountDescription: string;
  description: string;
  home: string;
  workspace: string;
  helpCentre: string;
  support: string;
  switchAccount: string;
  switchingAccount: string;
  switchAccountFailed: string;
};

/**
 * The 404 copy per document language. The page sits outside
 * `LanguageProvider` (it renders above the application layout), so it reads
 * the language the proxy already resolved for `<html lang>` instead of `t()`.
 */
export const notFoundCopy: Readonly<Record<Language, NotFoundCopy>> = {
  en: {
    title: "We couldn't find that page",
    accountDescription:
      "The link may be out of date, the page may have moved, or you may need to use a different account.",
    description:
      "The link may be out of date, or the page may have moved. Nothing is wrong with your account.",
    home: "Go to the homepage",
    workspace: "Open the chat workspace",
    helpCentre: "Browse the help centre",
    support: "Contact support",
    switchAccount: "Sign out and use another account",
    switchingAccount: "Signing out…",
    switchAccountFailed: "Could not end the current session. Please try again.",
  },
  ko: {
    title: "페이지를 찾을 수 없습니다",
    accountDescription:
      "링크가 오래되었거나 페이지가 이동했을 수 있습니다. 다른 계정으로 로그인해야 할 수도 있습니다.",
    description:
      "링크가 오래되었거나 페이지가 이동했을 수 있습니다. 계정에는 문제가 없습니다.",
    home: "홈으로 이동",
    workspace: "답변 비교 화면으로 이동",
    helpCentre: "도움말 센터 보기",
    support: "지원팀에 문의",
    switchAccount: "로그아웃하고 다른 계정 사용",
    switchingAccount: "로그아웃 중…",
    switchAccountFailed: "현재 세션을 종료하지 못했습니다. 다시 시도해 주세요.",
  },
  zh: {
    title: "找不到该页面",
    accountDescription: "链接可能已过期，页面可能已移动，或者您可能需要使用其他账户。",
    description: "链接可能已过期，或页面可能已移动。您的账户没有问题。",
    home: "前往首页",
    workspace: "前往回答比较页面",
    helpCentre: "浏览帮助中心",
    support: "联系支持",
    switchAccount: "退出并使用其他账户",
    switchingAccount: "正在退出…",
    switchAccountFailed: "无法结束当前会话，请重试。",
  },
  "zh-Hant": {
    title: "找不到該頁面",
    accountDescription: "連結可能已過期，頁面可能已移動，或者您可能需要使用其他帳戶。",
    description: "連結可能已過期，或頁面可能已移動。您的帳戶沒有問題。",
    home: "前往首頁",
    workspace: "前往回答比較頁面",
    helpCentre: "瀏覽說明中心",
    support: "聯絡支援",
    switchAccount: "登出並使用其他帳戶",
    switchingAccount: "正在登出…",
    switchAccountFailed: "無法結束目前的工作階段，請重試。",
  },
  fr: {
    title: "Page introuvable",
    accountDescription:
      "Le lien est peut-être obsolète, la page a peut-être été déplacée, ou vous devez peut-être utiliser un autre compte.",
    description:
      "Le lien est peut-être obsolète ou la page a peut-être été déplacée. Votre compte n’est pas en cause.",
    home: "Aller à l’accueil",
    workspace: "Ouvrir la comparaison des réponses",
    helpCentre: "Parcourir le centre d’aide",
    support: "Contacter le support",
    switchAccount: "Se déconnecter et utiliser un autre compte",
    switchingAccount: "Déconnexion…",
    switchAccountFailed: "Impossible de fermer la session actuelle. Veuillez réessayer.",
  },
  de: {
    title: "Seite nicht gefunden",
    accountDescription:
      "Der Link ist möglicherweise veraltet, die Seite wurde verschoben, oder Sie müssen ein anderes Konto verwenden.",
    description:
      "Der Link ist möglicherweise veraltet oder die Seite wurde verschoben. Mit Ihrem Konto ist alles in Ordnung.",
    home: "Zur Startseite",
    workspace: "Zum Antwortvergleich",
    helpCentre: "Hilfe-Center durchsuchen",
    support: "Support kontaktieren",
    switchAccount: "Abmelden und anderes Konto verwenden",
    switchingAccount: "Abmeldung…",
    switchAccountFailed: "Die aktuelle Sitzung konnte nicht beendet werden. Bitte versuchen Sie es erneut.",
  },
  es: {
    title: "No encontramos esa página",
    accountDescription:
      "Es posible que el enlace esté desactualizado, que la página se haya movido o que necesites usar otra cuenta.",
    description:
      "Es posible que el enlace esté desactualizado o que la página se haya movido. Tu cuenta no tiene ningún problema.",
    home: "Ir a la página de inicio",
    workspace: "Ir a la comparación de respuestas",
    helpCentre: "Ver el centro de ayuda",
    support: "Contactar con soporte",
    switchAccount: "Cerrar sesión y usar otra cuenta",
    switchingAccount: "Cerrando sesión…",
    switchAccountFailed: "No se pudo cerrar la sesión actual. Inténtalo de nuevo.",
  },
  pt: {
    title: "Não encontramos essa página",
    accountDescription:
      "O link pode estar desatualizado, a página pode ter sido movida ou talvez você precise usar outra conta.",
    description:
      "O link pode estar desatualizado ou a página pode ter sido movida. Não há nada de errado com sua conta.",
    home: "Ir para a página inicial",
    workspace: "Ir para a comparação de respostas",
    helpCentre: "Ver a central de ajuda",
    support: "Falar com o suporte",
    switchAccount: "Sair e usar outra conta",
    switchingAccount: "Saindo…",
    switchAccountFailed: "Não foi possível encerrar a sessão atual. Tente novamente.",
  },
};

/**
 * The body of the 404 page, rendered by both of the files that can serve one:
 * `app/not-found.tsx` (a `notFound()` thrown inside a route, composed with
 * that route's root layout) and `app/global-not-found.tsx` (a URL no route
 * matches, which renders its own document because there is no single root
 * layout to compose with -- see that file).
 *
 * ## The account-switch path
 *
 * `/admin/**` answers a signed-in non-administrator with this page rather than
 * a 403, so the console never confirms it exists. That is the right answer and
 * it stays, but on its own it left a visitor stranded: the only account they
 * could use was the one that had just been refused, and the sign-in page
 * forwards an authenticated visitor straight back to where they came from --
 * the same 404.
 *
 * So a request under `/admin` also offers a way out of the current session.
 * The decision reads the request path and nothing else -- not the session, not
 * whether the path is a real route -- so every visitor to every `/admin` URL
 * sees one identical page. Nothing here names the console, a role or an
 * allowlist.
 */
export function NotFoundBody({
  signInHref,
  language = "en",
}: {
  /** The document language the proxy resolved for this request. */
  language?: Language;
  /**
   * The sign-in destination offered to a visitor whose account may be the
   * reason they are here, or null when the path says nothing about an account.
   * Already normalized by `accountSwitchSignInHref`.
   */
  signInHref: string | null;
}) {
  const copy = notFoundCopy[language] ?? notFoundCopy.en;
  const secondaryLinkClass =
    "rounded-xl border border-zinc-300 px-4 py-2 text-sm font-bold text-zinc-800 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-800";

  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <p className="text-xs font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
        404
      </p>
      <h1 className="text-balance text-2xl font-bold text-zinc-900 dark:text-zinc-50">
        {copy.title}
      </h1>
      <p className="max-w-md text-sm leading-6 text-zinc-600 dark:text-zinc-300">
        {signInHref
          ? // "Nothing is wrong with your account" is not true here: the
            // account really can be the reason, and telling the visitor
            // otherwise is what sent them looking for a fault elsewhere.
            copy.accountDescription
          : copy.description}
      </p>
      {signInHref ? (
        <div className="mt-2 w-full">
          <SignOutAndSwitchAccountButton
            signInHref={signInHref}
            labels={{
              idle: copy.switchAccount,
              submitting: copy.switchingAccount,
              failed: copy.switchAccountFailed,
            }}
          />
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/"
          className={
            signInHref
              ? secondaryLinkClass
              : "rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-blue-500"
          }
        >
          {copy.home}
        </Link>
        <Link href={REVIEW_WORKSPACE_PATH} className={secondaryLinkClass}>
          {copy.workspace}
        </Link>
        {/*
          A visitor who guessed a help URL -- `/help` is the one that surfaced
          this page's own 500 -- lands here, so the page names where the guides
          actually are instead of leaving "support" to stand for both.
        */}
        <Link href={HELP_CENTRE_PATH} className={secondaryLinkClass}>
          {copy.helpCentre}
        </Link>
        <Link href="/support" className={secondaryLinkClass}>
          {copy.support}
        </Link>
      </div>
    </main>
  );
}

/** {@link NotFoundBody} with the recovery decision taken from the request. */
export async function NotFoundContent() {
  const requestHeaders = await headers();
  // Set by proxy.ts. A server component cannot read the request URL, and
  // `usePathname()` would move this decision to the client and flash the wrong
  // copy first.
  const pathname = requestHeaders.get("x-tomverse-pathname") || "";
  const search = requestHeaders.get("x-tomverse-search") || "";
  // Both halves are raw request input; `accountSwitchSignInHref` normalizes
  // them and falls back to /admin/overview for anything that is not an
  // internal admin path.
  const signInHref = isAdminPathname(pathname)
    ? accountSwitchSignInHref(`${pathname}${search}`)
    : null;
  // Set by proxy.ts for `<html lang>`; the body follows the same language.
  const documentLanguage = requestHeaders.get(DOCUMENT_LANGUAGE_HEADER);
  const language = isSupportedDocumentLanguage(documentLanguage)
    ? documentLanguage
    : "en";

  return <NotFoundBody signInHref={signInHref} language={language} />;
}
