import { consumeApiRateLimit, apiSecurityResponse } from "@/lib/apiSecurity";
import { isArtifactSharingEnabled } from "@/lib/artifactShareSettings";
import { readPublicArtifactShare } from "@/lib/artifactShareService";
import {
  ARTIFACT_SHARE_NOT_FOUND_CSP,
  artifactSharePageCsp,
  artifactSharePageHeaders,
  buildArtifactShareNotFoundPage,
  buildArtifactSharePage,
} from "@/lib/artifactSharePage";
import { resolveDocumentLanguage } from "@/lib/documentLanguage";
import type { Language } from "@/lib/language";
import { getPublicAppOrigin } from "@/lib/publicUrl";
import { isStrongShareToken } from "@/lib/shareTokens";
import { artifactWorkspaceCopy, formatArtifactWorkspaceCopy } from "@/locales/artifactWorkspace";
import { de } from "@/locales/de";
import { en } from "@/locales/en";
import { es } from "@/locales/es";
import { fr } from "@/locales/fr";
import { ko } from "@/locales/ko";
import { pt } from "@/locales/pt";
import { zh } from "@/locales/zh";
import { zhHant } from "@/locales/zhHant";

/**
 * The public, read-only page a share link opens.
 *
 * Policy: docs/policy/generated-artifacts.md section 19. A static answer: it
 * takes the token from the path and the visitor's language from
 * `Accept-Language` (or `?lang=`), and nothing else -- no session, no cookie,
 * no identity of any kind -- so a signed-in visitor's account cannot reach the
 * page or anything inside it. The document and its headers are
 * lib/artifactSharePage.ts; the proxy leaves this path's Content-Security-Policy
 * to this route (proxy.ts, isArtifactSharePagePath).
 *
 * Every refusal is the same "not available" page with a 404: a wrong token,
 * an expired or stopped link, a conversation locked since, and the feature
 * switched off are indistinguishable from outside.
 */

const DICTIONARIES: Record<Language, typeof en> = { ko, en, zh, "zh-Hant": zhHant, fr, de, es, pt };

const formatDate = (lang: Language, date: Date) => {
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeZone: "UTC" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
};

export async function GET(req: Request, context: { params: Promise<{ shareToken: string }> }) {
  const lang = resolveDocumentLanguage({
    pathname: "/",
    searchLanguage: new URL(req.url).searchParams.get("lang"),
    acceptLanguage: req.headers.get("accept-language"),
  }).language;
  const copy = artifactWorkspaceCopy[lang].page;
  const notAvailable = (status = 404) =>
    new Response(buildArtifactShareNotFoundPage({ lang, ...copy }), {
      status,
      headers: artifactSharePageHeaders(ARTIFACT_SHARE_NOT_FOUND_CSP),
    });

  try {
    const { shareToken } = await context.params;
    if (!isStrongShareToken(shareToken)) return notAvailable();
    // Keyed on the link (plus the caller's address), like the conversation share's public read.
    await consumeApiRateLimit(req, `artifact-share:${shareToken}`, "artifact-share-read", { minute: 120, day: 5_000 });
    // After the rate limit. The switch is one of the rules the read decides with all the others
    // (shareRefusal in lib/artifactShareService.ts, the same decision that made the link).
    const share = await readPublicArtifactShare(shareToken, { sharingAvailable: await isArtifactSharingEnabled() });
    if (!share) return notAvailable();

    const origin = getPublicAppOrigin(req);
    const chat = DICTIONARIES[lang].chat;
    const page = buildArtifactSharePage({
      share,
      copy: {
        lang,
        title: copy.title,
        notice: copy.notice,
        report: copy.report,
        expires: formatArtifactWorkspaceCopy(copy.expires, { date: formatDate(lang, share.expiresAt) }),
        frameTitle: copy.frameTitle,
      },
      labels: {
        errorTitle: chat.artifactWorkspaceErrorTitle,
        loadFailed: chat.artifactWorkspaceLoadFailed,
        noComponent: chat.artifactWorkspaceNoComponent,
        missingPackage: chat.artifactWorkspaceMissingPackage,
      },
      assetOrigin: origin,
      reportUrl: `${origin}/support`,
    });
    if (!page) return notAvailable();
    return new Response(page, { status: 200, headers: artifactSharePageHeaders(artifactSharePageCsp(origin)) });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      const response = notAvailable(security.status);
      const retryAfter = security.headers.get("Retry-After");
      if (retryAfter) response.headers.set("Retry-After", retryAfter);
      return response;
    }
    console.error("Public artifact share page failed:", error);
    return notAvailable(500);
  }
}
