/**
 * Which code an answer can show as a running page, and the document that runs it.
 *
 * Policy: docs/policy/generated-artifacts.md section 9, "답변 안 코드 블록과
 * React도 같은 격리 패널에서 미리 본다".
 *
 * `lib/htmlArtifactPreview.ts` is the isolation (sandbox, CSP, nested frame) for
 * a model-written HTML page. This file adds nothing to it. It only decides what
 * may be put in that frame and writes the one document each kind needs:
 *
 *   * `html`  -- the code block is the page, as written.
 *   * `svg`   -- the markup centred on a white page.
 *   * `react` -- a page that loads React 18 and Babel from pinned, integrity
 *     checked cdnjs files and compiles the block *inside the frame*. Nothing
 *     is compiled or evaluated by the chat page itself, and the frame's policy
 *     has no `'unsafe-eval'`: the compiled code reaches the frame as an inline
 *     `<script>` element, which the policy already admits.
 *
 * Every kind goes through `buildHtmlPreviewSrcdoc`, so the policy `<meta>` is
 * still the first element of the page and the page still cannot reach the
 * chat's origin, network, or navigation.
 *
 * Pure and client-safe: strings only.
 */

import { HTML_PREVIEW_MAX_BYTES } from "@/lib/htmlArtifactPreview";

export type CodePreviewKind = "html" | "svg" | "react";

const KIND_BY_LANGUAGE: ReadonlyMap<string, CodePreviewKind> = new Map([
    ["html", "html"],
    ["htm", "html"],
    ["svg", "svg"],
    ["jsx", "react"],
    ["tsx", "react"],
]);

/** The previewable kind for a fence's language tag, or null for any other code. */
export const codePreviewKindForLanguage = (language: string | null | undefined): CodePreviewKind | null =>
    (language ? KIND_BY_LANGUAGE.get(language.trim().toLowerCase()) : undefined) ?? null;

/** `hljs language-html` -> `html`. The fence's own tag, as rehype-highlight leaves it on `<code>`. */
export const codeLanguageFromClassName = (className: string | null | undefined): string | null => {
    const match = /(?:^|\s)language-([A-Za-z0-9_+-]+)(?:\s|$)/.exec(className ?? "");
    return match ? match[1].toLowerCase() : null;
};

/**
 * What a generated file's card previews. HTML always has (an existing,
 * ungated behaviour); React source is previewed only when the workspace switch
 * is on.
 */
export const artifactPreviewKind = (
    artifact: { format: string; status: string },
    options: { react: boolean }
): "html" | "react" | null => {
    if (artifact.status !== "ready") return null;
    const format = artifact.format.toLowerCase();
    if (format === "html" || format === "htm") return "html";
    if (options.react && (format === "jsx" || format === "tsx")) return "react";
    return null;
};

/** The words the page itself shows when it cannot run. The chat passes them in already translated. */
export type PreviewDocumentLabels = {
    errorTitle: string;
    loadFailed: string;
    noComponent: string;
    /** Contains `{name}`. */
    missingPackage: string;
};

/**
 * The libraries a React preview loads. Exact versions, from the CDNs the frame's
 * policy already allows, each with a subresource-integrity hash so a changed
 * file on the CDN is refused rather than run. React 18 is the last major with
 * a browser build that needs no bundler.
 */
export const REACT_PREVIEW_SCRIPTS = [
    {
        src: "https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js",
        integrity: "sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z",
    },
    {
        src: "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js",
        integrity: "sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1",
    },
    {
        src: "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.26.2/babel.min.js",
        integrity: "sha384-RgwZ6hj+t5cUuE1+O8VrbNENCeVFTIjTroWdTHusMbpfssSx1gxln5reSjtRkxWs",
    },
] as const;

/**
 * A second policy, ours, as the first element of the React page's `<head>`.
 * Every policy in force applies, so on top of the shared frame policy the page
 * may load exactly the three files above and run inline script (the bootstrap
 * and the compiled code), and fetch nothing else -- not another file from the
 * same CDN, not an image. The person's code is inside a `<textarea>` after
 * this element and cannot come before it.
 */
export const REACT_PREVIEW_CSP = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${REACT_PREVIEW_SCRIPTS.map((script) => script.src).join(" ")}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
].join("; ");

const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, "&quot;");

const PAGE_STYLE =
    "html,body{margin:0;min-height:100%}body{font-family:system-ui,-apple-system,sans-serif;background:#fff;color:#18181b}" +
    "#tomverse-error{margin:12px;padding:10px 12px;border:1px solid #fecaca;border-radius:8px;background:#fef2f2;color:#7f1d1d;font-size:13px;line-height:1.5}" +
    "#tomverse-error[hidden]{display:none}#tomverse-error pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,monospace}";

/**
 * Runs inside the frame. No `eval`, no `Function`: the compiled module is
 * handed to the browser as the text of a `<script>` element, carrying the
 * embedding page's nonce so an enforced nonce policy admits it (the frame's own
 * policy admits inline script already). No backslashes, so the string is the
 * same in source and at runtime.
 */
export const REACT_PREVIEW_BOOTSTRAP = `(function () {
  var nonce = (document.currentScript && document.currentScript.nonce) || "";
  var holder = document.getElementById("tomverse-source");
  var root = document.getElementById("root");
  var banner = document.getElementById("tomverse-error");
  var shown = false;
  var newline = String.fromCharCode(10);
  function word(name) { return holder.getAttribute(name) || ""; }
  function fail(detail) {
    if (shown) return;
    shown = true;
    var title = document.createElement("strong");
    title.textContent = word("data-error-title");
    banner.appendChild(title);
    if (detail) {
      var pre = document.createElement("pre");
      pre.textContent = String(detail).split(newline).slice(0, 8).join(newline).slice(0, 800);
      banner.appendChild(pre);
    }
    banner.hidden = false;
  }
  window.addEventListener("error", function (event) { fail(event.message); });
  window.addEventListener("unhandledrejection", function (event) { fail(event.reason && event.reason.message ? event.reason.message : event.reason); });
  var Babel = window.Babel, React = window.React, ReactDOM = window.ReactDOM;
  if (!Babel || !React || !ReactDOM || !ReactDOM.createRoot) { fail(word("data-load-failed")); return; }
  var language = holder.getAttribute("data-language") === "tsx" ? "tsx" : "jsx";
  var compiled;
  try {
    compiled = Babel.transform(holder.value, {
      filename: "preview." + language,
      sourceType: "module",
      presets: language === "tsx" ? [["typescript", { isTSX: true, allExtensions: true }], "react"] : ["react"],
      plugins: ["transform-modules-commonjs"]
    }).code;
  } catch (error) { fail(error && error.message); return; }
  function requireModule(name) {
    if (name === "react") return React;
    if (name === "react-dom" || name === "react-dom/client") return ReactDOM;
    throw new Error(word("data-missing-package").split("{name}").join(name));
  }
  var script = document.createElement("script");
  if (nonce) script.nonce = nonce;
  script.text = "window.__tomversePreview = function (exports, module, require) {" + compiled + newline +
    ";if (!module.exports.default && typeof App !== 'undefined') { module.exports.default = App; }" + newline + "};";
  document.head.appendChild(script);
  script.remove();
  var factory = window.__tomversePreview;
  if (typeof factory !== "function") { fail(word("data-load-failed")); return; }
  var mod = { exports: {} };
  try { factory.call(mod.exports, mod.exports, mod, requireModule); } catch (error) { fail(error && error.message); return; }
  var Component = mod.exports.default || mod.exports.App;
  if (!Component) { fail(word("data-no-component")); return; }
  class Boundary extends React.Component {
    constructor(props) { super(props); this.state = { failed: false }; }
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(error) { fail(error && error.message); }
    render() { return this.state.failed ? null : this.props.children; }
  }
  ReactDOM.createRoot(root).render(React.createElement(Boundary, null, React.createElement(Component)));
})();`;

export function buildReactPreviewDocument(code: string, options: { typescript: boolean; labels: PreviewDocumentLabels }): string {
    const { labels } = options;
    const scripts = REACT_PREVIEW_SCRIPTS.map(
        (script) => `<script src="${script.src}" integrity="${script.integrity}" crossorigin="anonymous"></script>`
    ).join("");
    // The first newline of a <textarea> is dropped by the parser, so one is put in front: the code starts exactly as written.
    const source =
        `<textarea id="tomverse-source" hidden data-language="${options.typescript ? "tsx" : "jsx"}"` +
        ` data-error-title="${escapeAttribute(labels.errorTitle)}" data-load-failed="${escapeAttribute(labels.loadFailed)}"` +
        ` data-no-component="${escapeAttribute(labels.noComponent)}" data-missing-package="${escapeAttribute(labels.missingPackage)}">` +
        `\n${escapeText(code)}</textarea>`;
    return (
        `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${REACT_PREVIEW_CSP}">` +
        `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<style>${PAGE_STYLE}</style></head><body><div id="root"></div><div id="tomverse-error" role="alert" hidden></div>` +
        `${source}${scripts}<script>${REACT_PREVIEW_BOOTSTRAP}</script></body></html>`
    );
}

const SVG_PROLOGUE = /^\s*(?:<\?xml[^>]*\?>\s*|<!doctype[^>]*>\s*|<!--[\s\S]*?-->\s*)*/i;

export function buildSvgPreviewDocument(svg: string): string {
    return (
        `<!doctype html><html><head><meta charset="utf-8"><style>` +
        `html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;background:#fff}svg{max-width:100%;max-height:100%}` +
        `</style></head><body>${svg.replace(SVG_PROLOGUE, "")}</body></html>`
    );
}

export type CodePreviewDocument = { ok: true; html: string } | { ok: false; reason: "too_large" | "empty" };

/** The page for a code block of a previewable kind. Larger-than-a-page code is refused, as a file is. */
export function buildCodePreviewDocument(
    kind: CodePreviewKind,
    code: string,
    options: { language?: string | null; labels: PreviewDocumentLabels }
): CodePreviewDocument {
    if (!code.trim()) return { ok: false, reason: "empty" };
    if (new TextEncoder().encode(code).byteLength > HTML_PREVIEW_MAX_BYTES) return { ok: false, reason: "too_large" };
    if (kind === "html") return { ok: true, html: code };
    if (kind === "svg") return { ok: true, html: buildSvgPreviewDocument(code) };
    return {
        ok: true,
        html: buildReactPreviewDocument(code, { typescript: options.language?.toLowerCase() === "tsx", labels: options.labels }),
    };
}
