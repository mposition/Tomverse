/**
 * The public page a share link opens, as a string, and the headers it is sent
 * with.
 *
 * Policy: docs/policy/generated-artifacts.md section 19. The shared page runs
 * exactly as it runs in the chat's preview panel, one level further down:
 *
 *   top document (this file, served by app/(site)/(application)/share/a/[shareToken]/route.ts)
 *     CSP header: `sandbox allow-scripts` + htmlPreviewCsp(origin) + `frame-ancestors 'none'`
 *     -> iframe sandbox="allow-scripts" srcdoc=  (buildHtmlPreviewSrcdoc's outer document, `frame-src 'none'`)
 *       -> iframe sandbox="allow-scripts" srcdoc=  (the page, htmlPreviewCsp first; reactPreviewCsp too for React)
 *
 * The page's code is never the top document. The top document is ours: a
 * fixed notice bar, a report link and the frame, with no script of its own.
 * Its policy's `sandbox` directive gives even this document an opaque origin,
 * so a mistake in this template could not run script with the application's
 * origin. The frame policy is the preview's, unchanged, and every document
 * below inherits the top one's: what the page may load or reach is the
 * intersection, never more than the preview's own policy.
 *
 * Pure: strings in, strings out.
 */

import { ARTIFACT_SHARE_OVERRIDE_HEADERS } from "@/lib/artifactSharePageHeaders";
import { buildCodePreviewDocument, type CodePreviewKind, type PreviewDocumentLabels } from "@/lib/chatArtifactPreview";
import { HTML_PREVIEW_SANDBOX, buildHtmlPreviewSrcdoc, htmlPreviewCsp } from "@/lib/htmlArtifactPreview";

/** The frame's sandbox on the public page: the preview's, scripts and nothing else. */
export const ARTIFACT_SHARE_FRAME_SANDBOX = HTML_PREVIEW_SANDBOX;

/** The top-level page's policy. `frame-ancestors` and `sandbox` only work as a header, which is how it is sent. */
export const artifactSharePageCsp = (assetOrigin: string | null) =>
  [`sandbox ${ARTIFACT_SHARE_FRAME_SANDBOX}`, htmlPreviewCsp(assetOrigin), "frame-ancestors 'none'"].join("; ");

/** The "not available" page has no frame and no script at all. */
export const ARTIFACT_SHARE_NOT_FOUND_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const artifactSharePageHeaders = (csp: string): Record<string, string> => ({
  ...Object.fromEntries(ARTIFACT_SHARE_OVERRIDE_HEADERS.map((header) => [header.key, header.value])),
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": csp,
  // The conversation share's cache policy (app/api/public/shares/[shareToken]/route.ts).
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Cloudflare-CDN-Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  Vary: "Accept-Language",
});

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export type ArtifactSharePageCopy = {
  lang: string;
  title: string;
  notice: string;
  report: string;
  /** Already formatted with the date. */
  expires: string;
  frameTitle: string;
};

const STYLE =
  ":root{color-scheme:light dark;--bg:#fff;--fg:#18181b;--bar:#fef3c7;--bar-fg:#78350f;--bar-line:#fcd34d}" +
  "@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#f4f4f5;--bar:#451a03;--bar-fg:#fef3c7;--bar-line:#92400e}}" +
  "html,body{height:100%;margin:0}" +
  "body{display:flex;flex-direction:column;overflow:hidden;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif}" +
  "header{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:0 12px;padding:4px 16px;background:var(--bar);color:var(--bar-fg);border-bottom:1px solid var(--bar-line)}" +
  "header p{margin:6px 0}header .meta{margin-left:auto;display:flex;flex-wrap:wrap;align-items:center;gap:0 12px;font-size:12px}" +
  "header .file{font-weight:600;overflow-wrap:anywhere}" +
  "header a{display:inline-flex;align-items:center;min-height:44px;padding:0 4px;color:inherit;font-weight:700}" +
  "header a:focus-visible{outline:2px solid currentColor;outline-offset:2px}" +
  "main{flex:1;min-height:0;display:flex}iframe{flex:1;width:100%;height:100%;border:0;background:#fff}" +
  ".empty{margin:auto;max-width:28rem;padding:24px 16px;text-align:center}.empty h1{font-size:18px;margin:0 0 8px}";

const head = (lang: string, title: string) =>
  `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">` +
  `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>`;

/**
 * The share page, or null when the stored page cannot be built (empty, or
 * over the preview's size limit -- the table's CHECK already refuses both).
 */
export function buildArtifactSharePage(input: {
  share: { previewKind: CodePreviewKind; language: string; title: string | null; content: string };
  copy: ArtifactSharePageCopy;
  labels: PreviewDocumentLabels;
  assetOrigin: string;
  reportUrl: string;
}): string | null {
  const { share, copy } = input;
  const built = buildCodePreviewDocument(share.previewKind, share.content, {
    language: share.language,
    labels: input.labels,
    assetOrigin: input.assetOrigin,
  });
  if (!built.ok) return null;
  const frame = buildHtmlPreviewSrcdoc(built.html, input.assetOrigin);
  const file = share.title ? `<span class="file">${escapeHtml(share.title)}</span>` : "";
  return (
    head(copy.lang, share.title ? `${share.title} · ${copy.title}` : copy.title) +
    `<body><header role="note" data-testid="artifact-share-notice">` +
    `<p><strong>${escapeHtml(copy.notice)}</strong></p>` +
    `<div class="meta">${file}<span>${escapeHtml(copy.expires)}</span>` +
    `<a href="${escapeHtml(input.reportUrl)}" rel="noreferrer noopener" data-testid="artifact-share-report">${escapeHtml(copy.report)}</a></div>` +
    `</header><main><iframe data-testid="artifact-share-frame" title="${escapeHtml(copy.frameTitle)}" sandbox="${ARTIFACT_SHARE_FRAME_SANDBOX}"` +
    ` referrerpolicy="no-referrer" allow="" srcdoc="${escapeHtml(frame)}"></iframe></main></body></html>`
  );
}

export function buildArtifactShareNotFoundPage(copy: { lang: string; title: string; notFoundTitle: string; notFound: string }) {
  return (
    head(copy.lang, copy.title) +
    `<body><main><div class="empty" data-testid="artifact-share-not-found"><h1>${escapeHtml(copy.notFoundTitle)}</h1>` +
    `<p>${escapeHtml(copy.notFound)}</p></div></main></body></html>`
  );
}
